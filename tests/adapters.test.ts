import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCommandForPty, resolveExecutable } from '../src/adapters/cli-wrapper';
import { HotkeyAdapter } from '../src/adapters/hotkey';
import { WrapperActivityTracker } from '../src/adapters/wrapper-tracker';
import { AGENT_FINISHED, AGENT_STARTED, AgentEvent, CoreState } from '../src/core/types';
import { KeyEvent, parseHotkey } from '../src/windows/key-listener';
import { FakeMachine, ManualScheduler } from './helpers';

class FakeKeySource {
  private listeners = new Set<(event: KeyEvent) => void>();

  onKey(listener: (event: KeyEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: KeyEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  get count(): number {
    return this.listeners.size;
  }
}

class FakeForceMachine extends FakeMachine {
  forceReturns: string[] = [];

  async forceReturn(reason: 'hotkey' | 'cap'): Promise<void> {
    this.forceReturns.push(reason);
    this.state = 'done' as CoreState;
  }
}

function key(name: string, ctrl = false, alt = false, shift = false): KeyEvent {
  return {
    key: name,
    ctrl,
    alt,
    shift,
    window: null,
    at: 0,
  };
}

describe('hotkey parsing and adapter', () => {
  it('parses modifiers and keys', () => {
    expect(parseHotkey('Ctrl+Alt+D')).toEqual({ key: 'D', ctrl: true, alt: true, shift: false });
    expect(parseHotkey('ctrl+shift+enter')).toEqual({
      key: 'ENTER',
      ctrl: true,
      alt: false,
      shift: true,
    });
    expect(parseHotkey(null)).toBeNull();
    expect(parseHotkey('Ctrl+Alt')).toBeNull();
    expect(parseHotkey('Win+Alt+D')).toBeNull();
  });

  it('starts when idle and force-returns when working', async () => {
    const listener = new FakeKeySource();
    const machine = new FakeForceMachine();
    const logs: string[] = [];
    const adapter = new HotkeyAdapter({
      listener,
      machine,
      hotkey: parseHotkey('Ctrl+Alt+D'),
      logger: {
        debug: () => {},
        info: (message) => logs.push(message),
        warn: () => {},
        error: () => {},
      },
    });
    adapter.start();
    expect(listener.count).toBe(1);

    listener.emit(key('D', true, true));
    expect(machine.events).toEqual([AGENT_STARTED]);
    expect(machine.state).toBe('working');

    listener.emit(key('D', true, true));
    expect(machine.forceReturns).toEqual(['hotkey']);

    listener.emit(key('D', true, false));
    expect(machine.events).toHaveLength(1);

    adapter.stop();
    expect(listener.count).toBe(0);
  });
});

describe('resolveCommandForPty', () => {
  it('prefers PATHEXT executables over extensionless Unix scripts', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'doomscroller-resolve-'));
    const originalPath = process.env.PATH;
    const originalExtensions = process.env.PATHEXT;
    try {
      writeFileSync(path.join(directory, 'tool'), '#!/bin/sh\n');
      writeFileSync(path.join(directory, 'tool.exe'), '');
      process.env.PATH = directory;
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';

      expect(resolveExecutable('tool')?.toLowerCase()).toBe(
        path.join(directory, 'tool.exe').toLowerCase(),
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalExtensions === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = originalExtensions;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('spawns .cmd shims directly so paths with spaces survive', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'doomscroller-resolve-'));
    try {
      const command = path.join(directory, 'my tool.cmd');
      writeFileSync(command, '@echo off\n');
      expect(resolveCommandForPty(command, ['--version'], 'win32')).toEqual({
        file: command,
        args: ['--version'],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('routes PowerShell scripts through powershell.exe', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'doomscroller-resolve-'));
    try {
      const command = path.join(directory, 'tool.ps1');
      writeFileSync(command, 'Write-Output hi\n');
      expect(resolveCommandForPty(command, ['-x'], 'win32')).toEqual({
        file: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', command, '-x'],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('leaves commands alone on other platforms', () => {
    expect(resolveCommandForPty('sh', ['-c', 'true'], 'linux')).toEqual({
      file: 'sh',
      args: ['-c', 'true'],
    });
  });
});

describe('WrapperActivityTracker', () => {
  it('starts on Enter, resets on output, and finishes after a quiet gap', () => {
    const scheduler = new ManualScheduler();
    const events: AgentEvent[] = [];
    const tracker = new WrapperActivityTracker({
      quietMs: 5_000,
      onStarted: () => events.push(AGENT_STARTED),
      onFinished: () => events.push(AGENT_FINISHED),
      scheduler,
    });

    tracker.onInput('hello');
    expect(events).toEqual([]);

    tracker.onInput('\r');
    expect(events).toEqual([AGENT_STARTED]);
    expect(tracker.isStarted).toBe(true);

    scheduler.advance(3_000);
    tracker.onOutput('working...');
    scheduler.advance(4_999);
    expect(events).toEqual([AGENT_STARTED]);

    scheduler.advance(1);
    expect(events).toEqual([AGENT_STARTED, AGENT_FINISHED]);
    expect(tracker.isStarted).toBe(false);

    tracker.onInput('\r');
    expect(events).toEqual([AGENT_STARTED, AGENT_FINISHED, AGENT_STARTED]);

    tracker.onExit();
    expect(events).toEqual([
      AGENT_STARTED,
      AGENT_FINISHED,
      AGENT_STARTED,
      AGENT_FINISHED,
    ]);
  });

  it('ignores output before a session starts', () => {
    const scheduler = new ManualScheduler();
    let finished = 0;
    const tracker = new WrapperActivityTracker({
      quietMs: 1_000,
      onStarted: () => {},
      onFinished: () => {
        finished += 1;
      },
      scheduler,
    });

    tracker.onOutput('agent chatter');
    scheduler.advance(5_000);
    expect(finished).toBe(0);
  });
});

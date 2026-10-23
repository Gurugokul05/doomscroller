import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanMaxMtime } from '../src/adapters/file-activity';
import { IdeActivityAdapter, windowMatches } from '../src/adapters/ide-activity';
import { noopLogger } from '../src/core/logger';
import { AGENT_FINISHED, AGENT_STARTED, CoreState, RegisteredAgent, WindowHandle } from '../src/core/types';
import { KeyEvent } from '../src/windows/key-listener';
import { FakeCpuProbeFactory, FakeMachine, fakeIntervals, testConfig } from './helpers';

const temporaryDirectories: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'doomscroller-ide-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

const ideWindow: WindowHandle = {
  id: '555',
  title: 'agent.ts - Antigravity',
  processName: 'Antigravity',
  pid: 4242,
};

function enter(window: WindowHandle | null = ideWindow, key = 'ENTER'): KeyEvent {
  return { key, ctrl: false, alt: false, shift: false, window, at: 0 };
}

interface Harness {
  adapter: IdeActivityAdapter;
  machine: FakeMachine;
  probes: FakeCpuProbeFactory;
  intervals: ReturnType<typeof fakeIntervals>;
  scheduler: { now: number };
  setScan: (value: number) => void;
  agent: RegisteredAgent;
}

function createHarness(quietSeconds = 3): Harness {
  let scanValue = 100;
  const scheduler = { now: 0 };
  const machine = new FakeMachine();
  const probes = new FakeCpuProbeFactory();
  probes.sample = { cpuSeconds: 0, at: 0, alive: true, processes: 1 };
  const intervals = fakeIntervals();
  const agent: RegisteredAgent = {
    name: 'Antigravity',
    adapter: 'ide-activity',
    match: { process: 'Antigravity' },
    workspace: 'C:\\fake-workspace',
    quietSeconds,
  };
  const config = testConfig({ registeredAgents: [agent], idleCpuPercent: 5 });
  const adapter = new IdeActivityAdapter({
    config,
    machine,
    logger: noopLogger,
    keySource: null,
    cpuProbes: probes,
    scanWorkspace: async () => scanValue,
    intervals,
    now: () => scheduler.now,
    scanIntervalMs: 2_000,
  });
  return {
    adapter,
    machine,
    probes,
    intervals,
    scheduler,
    setScan: (value) => {
      scanValue = value;
    },
    agent,
  };
}

describe('windowMatches', () => {
  it('matches process names case-insensitively and ignores .exe', () => {
    expect(windowMatches(ideWindow, { process: 'antigravity.exe' })).toBe(true);
    expect(windowMatches(ideWindow, { process: 'Code' })).toBe(false);
  });

  it('matches title substrings and requires every provided field', () => {
    expect(windowMatches(ideWindow, { title: 'agent.ts' })).toBe(true);
    expect(windowMatches(ideWindow, { title: 'other.ts' })).toBe(false);
    expect(windowMatches(ideWindow, { process: 'Antigravity', title: 'agent.ts' })).toBe(true);
    expect(windowMatches(ideWindow, { process: 'Antigravity', title: 'other.ts' })).toBe(false);
    expect(windowMatches(ideWindow, undefined)).toBe(false);
    expect(windowMatches(ideWindow, {})).toBe(false);
  });
});

describe('IdeActivityAdapter', () => {
  it('starts on Enter inside a registered window', async () => {
    const harness = createHarness();
    await harness.adapter.handleKeyEvent(enter());

    expect(harness.machine.events).toEqual([AGENT_STARTED]);
    expect(harness.machine.state).toBe('working');
    expect(harness.adapter.isMonitoring).toBe(true);
    expect(harness.probes.probes).toHaveLength(1);
    expect(harness.intervals.callbacks).toHaveLength(1);
  });

  it('ignores non-Enter keys and unregistered windows', async () => {
    const harness = createHarness();
    await harness.adapter.handleKeyEvent(enter(ideWindow, 'D'));
    await harness.adapter.handleKeyEvent(
      enter({ ...ideWindow, processName: 'Code', title: 'main.ts - Visual Studio Code' }),
    );
    await harness.adapter.handleKeyEvent(enter(null));

    expect(harness.machine.events).toEqual([]);
    expect(harness.adapter.isMonitoring).toBe(false);
  });

  it('ignores Enter combined with a modifier key', async () => {
    const harness = createHarness();

    await harness.adapter.handleKeyEvent({ ...enter(), shift: true });
    await harness.adapter.handleKeyEvent({ ...enter(), ctrl: true });
    await harness.adapter.handleKeyEvent({ ...enter(), alt: true });

    expect(harness.machine.events).toEqual([]);
    expect(harness.adapter.isMonitoring).toBe(false);
  });

  it('does not start when another adapter already owns the session', async () => {
    const harness = createHarness();
    harness.machine.state = 'working' as CoreState;

    await harness.adapter.handleKeyEvent(enter());
    expect(harness.machine.events).toEqual([]);
  });

  it('keeps the session alive on CPU activity, then finishes after quiet', async () => {
    const harness = createHarness(3);
    await harness.adapter.handleKeyEvent(enter());
    const probe = harness.probes.probes[0];

    harness.scheduler.now = 1_000;
    probe.sample = { cpuSeconds: 0.5, at: 1_000, alive: true, processes: 1 };
    await harness.adapter.tick();
    expect(harness.machine.events).toEqual([AGENT_STARTED]);
    expect(harness.adapter.isMonitoring).toBe(true);

    harness.scheduler.now = 4_000;
    probe.sample = { cpuSeconds: 0.5, at: 4_000, alive: true, processes: 1 };
    await harness.adapter.tick();

    expect(harness.machine.events).toEqual([AGENT_STARTED, AGENT_FINISHED]);
    expect(harness.adapter.isMonitoring).toBe(false);
    expect(probe.stopped).toBe(true);
    expect(harness.intervals.cleared).toHaveLength(1);
  });

  it('keeps the session alive when workspace files change', async () => {
    const harness = createHarness(5);
    await harness.adapter.handleKeyEvent(enter());
    const probe = harness.probes.probes[0];

    harness.scheduler.now = 2_000;
    probe.sample = { cpuSeconds: 0, at: 2_000, alive: true, processes: 1 };
    harness.setScan(200);
    await harness.adapter.tick();
    expect(harness.adapter.isMonitoring).toBe(true);

    harness.scheduler.now = 4_000;
    probe.sample = { cpuSeconds: 0, at: 4_000, alive: true, processes: 1 };
    await harness.adapter.tick();
    expect(harness.adapter.isMonitoring).toBe(true);

    harness.scheduler.now = 7_000;
    probe.sample = { cpuSeconds: 0, at: 7_000, alive: true, processes: 1 };
    await harness.adapter.tick();

    expect(harness.machine.events).toEqual([AGENT_STARTED, AGENT_FINISHED]);
    expect(harness.adapter.isMonitoring).toBe(false);
  });

  it('stops monitoring when the session ends elsewhere', async () => {
    const harness = createHarness(5);
    await harness.adapter.handleKeyEvent(enter());
    harness.machine.state = 'done' as CoreState;

    await harness.adapter.tick();

    expect(harness.adapter.isMonitoring).toBe(false);
    expect(harness.machine.events).toEqual([AGENT_STARTED]);
  });

  it('uses the agent quietSeconds override', async () => {
    const harness = createHarness(1);
    await harness.adapter.handleKeyEvent(enter());
    const probe = harness.probes.probes[0];

    harness.scheduler.now = 1_000;
    probe.sample = { cpuSeconds: 1, at: 1_000, alive: true, processes: 1 };
    await harness.adapter.tick();
    expect(harness.adapter.isMonitoring).toBe(true);

    harness.scheduler.now = 2_500;
    probe.sample = { cpuSeconds: 1, at: 2_500, alive: true, processes: 1 };
    await harness.adapter.tick();

    expect(harness.machine.events).toEqual([AGENT_STARTED, AGENT_FINISHED]);
  });
});

describe('scanMaxMtime', () => {
  it('finds the newest source file and ignores build directories', async () => {
    const root = tempDir();
    const source = path.join(root, 'src');
    const nodeModules = path.join(root, 'node_modules');
    mkdirSync(source);
    mkdirSync(nodeModules);

    const oldFile = path.join(source, 'old.ts');
    const newFile = path.join(source, 'new.ts');
    const ignoredFile = path.join(nodeModules, 'ignored.js');
    writeFileSync(oldFile, 'old');
    writeFileSync(newFile, 'new');
    writeFileSync(ignoredFile, 'ignored');

    utimesSync(oldFile, new Date(1_000_000), new Date(1_000_000));
    utimesSync(newFile, new Date(2_000_000), new Date(2_000_000));
    utimesSync(ignoredFile, new Date(9_000_000), new Date(9_000_000));

    const newest = await scanMaxMtime(root);
    expect(newest).toBeGreaterThanOrEqual(2_000_000 - 1_000);
    expect(newest).toBeLessThan(9_000_000);
  });

  it('returns zero for a missing directory', async () => {
    expect(await scanMaxMtime(path.join(tempDir(), 'missing'))).toBe(0);
  });
});

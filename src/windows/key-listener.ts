import { spawn, ChildProcessByStdio } from 'node:child_process';
import { Readable } from 'node:stream';
import readline from 'node:readline';
import { Logger } from '../core/logger';
import { WindowHandle } from '../core/types';
import { scriptPath } from '../util/paths';

export interface KeyEvent {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  window: WindowHandle | null;
  at: number;
}

export interface HotkeySpec {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const MODIFIERS = new Set(['ctrl', 'control', 'alt', 'shift', 'win', 'meta', 'cmd']);

export function parseHotkey(spec: string | null): HotkeySpec | null {
  if (!spec) return null;
  const parts = spec
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const result: HotkeySpec = { key: '', ctrl: false, alt: false, shift: false };
  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') {
      result.ctrl = true;
    } else if (part === 'alt') {
      result.alt = true;
    } else if (part === 'shift') {
      result.shift = true;
    } else if (part === 'win' || part === 'meta' || part === 'cmd') {
      // Windows-key hotkeys are not supported by the polling watcher.
      return null;
    } else if (!result.key) {
      if (part === 'return') result.key = 'ENTER';
      else if (part === 'escape') result.key = 'ESC';
      else if (part.length === 1) result.key = part.toUpperCase();
      else result.key = part.toUpperCase();
    }
  }

  if (!result.key) return null;
  if (MODIFIERS.has(result.key.toLowerCase())) return null;
  return result;
}

export function matchesHotkey(event: KeyEvent, hotkey: HotkeySpec): boolean {
  return (
    event.key.toUpperCase() === hotkey.key.toUpperCase() &&
    event.ctrl === hotkey.ctrl &&
    event.alt === hotkey.alt &&
    event.shift === hotkey.shift
  );
}

function toKeyEvent(value: Record<string, unknown>): KeyEvent | null {
  if (typeof value.key !== 'string') return null;
  const pid = typeof value.pid === 'number' ? value.pid : Number(value.pid);
  const hwnd = typeof value.hwnd === 'string' ? value.hwnd : String(value.hwnd ?? '');
  const window =
    Number.isFinite(pid) && pid > 0 && hwnd && hwnd !== '0'
      ? {
          id: hwnd,
          title: typeof value.title === 'string' ? value.title : '',
          processName: typeof value.process === 'string' ? value.process : '',
          pid,
        }
      : null;

  return {
    key: value.key.toUpperCase(),
    ctrl: value.ctrl === true,
    alt: value.alt === true,
    shift: value.shift === true,
    window,
    at: typeof value.at === 'number' ? value.at : Date.now(),
  };
}

/**
 * A single PowerShell polling process feeds all key consumers (hotkey + IDE
 * activity). It is restarted automatically if PowerShell dies.
 */
export class GlobalKeyListener {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private readonly listeners = new Set<(event: KeyEvent) => void>();
  private stopped = false;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly hotkeyKey = 'D',
  ) {}

  onKey(listener: (event: KeyEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (process.platform !== 'win32') {
      this.logger.warn('global hotkey is only available on Windows');
      return;
    }
    if (this.child || this.stopped) return;
    this.spawnWatcher();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // ignore
      }
      this.child = null;
    }
  }

  private spawnWatcher(): void {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath('key-watcher.ps1'),
          '-ParentPid',
          String(process.pid),
          '-HotkeyKey',
          this.hotkeyKey,
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      this.scheduleRestart();
      return;
    }

    this.child = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (parsed.type === 'ready') {
          this.logger.info('global key listener ready');
          return;
        }
        if (parsed.type !== 'key') return;
        const event = toKeyEvent(parsed);
        if (!event) return;
        for (const listener of this.listeners) {
          try {
            listener(event);
          } catch (error) {
            this.logger.debug(`key listener callback failed: ${String(error)}`);
          }
        }
      } catch {
        // Ignore malformed lines.
      }
    });
    child.stdout.on('error', () => {});
    child.stderr.on('data', () => {});
    child.stderr.on('error', () => {});

    const onGone = (): void => {
      if (this.child === child) this.child = null;
      this.scheduleRestart();
    };
    child.on('error', onGone);
    child.on('close', onGone);
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped && !this.child) this.spawnWatcher();
    }, 2500);
  }
}

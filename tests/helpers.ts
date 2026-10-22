import { defaultConfig } from '../src/core/config';
import { Scheduler } from '../src/core/state-machine';
import {
  AgentEvent,
  CoreState,
  DoomscrollerConfig,
  SessionRecord,
  SessionRecorder,
  SoundPlayer,
  WindowHandle,
  WindowMatch,
} from '../src/core/types';
import { AgentControlPort } from '../src/adapters/ports';
import { CpuProbe, CpuProbeFactory, CpuSample } from '../src/windows/cpu-probe';
import { WindowController } from '../src/windows/window-controller';

export function testConfig(overrides: Partial<DoomscrollerConfig> = {}): DoomscrollerConfig {
  return {
    ...defaultConfig(),
    registeredAgents: [],
    ...overrides,
  };
}

export const agentWindow: WindowHandle = {
  id: '100',
  title: 'Coding agent',
  processName: 'WindowsTerminal',
  pid: 1000,
};

export const browserWindow: WindowHandle = {
  id: '200',
  title: 'Instagram',
  processName: 'msedge',
  pid: 2000,
};

export class MockWindowController implements WindowController {
  foreground: WindowHandle | null = agentWindow;
  browser: WindowHandle | null = browserWindow;
  failForeground = false;
  failMinimize = false;
  failFocus = false;
  failOpen = false;

  calls: string[] = [];
  minimized: string[] = [];
  focused: string[] = [];
  opened: string[] = [];

  async getForegroundWindow(): Promise<WindowHandle | null> {
    this.calls.push('get-foreground');
    if (this.failForeground) throw new Error('foreground failed');
    return this.foreground;
  }

  async minimizeWindow(handle: WindowHandle): Promise<void> {
    this.calls.push(`minimize:${handle.id}`);
    this.minimized.push(handle.id);
    if (this.failMinimize) throw new Error('minimize failed');
  }

  async restoreAndFocusWindow(handle: WindowHandle): Promise<boolean> {
    this.calls.push(`focus:${handle.id}`);
    this.focused.push(handle.id);
    if (this.failFocus) throw new Error('focus failed');
    return true;
  }

  async openInNewBrowserWindow(url: string): Promise<WindowHandle | null> {
    this.calls.push(`open:${url}`);
    this.opened.push(url);
    if (this.failOpen) throw new Error('open failed');
    return this.browser;
  }

  async findWindows(_match: WindowMatch): Promise<WindowHandle[]> {
    return [];
  }
}

export class MockSound implements SoundPlayer {
  plays = 0;
  throwOnPlay = false;

  play(): void {
    this.plays += 1;
    if (this.throwOnPlay) throw new Error('sound failed');
  }
}

export class MockRecorder implements SessionRecorder {
  records: SessionRecord[] = [];
  throwOnRecord = false;

  record(record: SessionRecord): void {
    if (this.throwOnRecord) throw new Error('record failed');
    this.records.push(record);
  }
}

interface ScheduledTimer {
  at: number;
  callback: () => void;
}

export class ManualScheduler implements Scheduler {
  now = 0;
  private nextId = 1;
  private timers = new Map<number, ScheduledTimer>();

  setTimer(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + Math.max(0, delayMs), callback });
    return id;
  }

  clearTimer(timer: unknown): void {
    this.timers.delete(timer as number);
  }

  get pending(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    this.now += Math.max(0, ms);
    let ran = true;
    while (ran) {
      ran = false;
      let selectedId: number | null = null;
      let selected: ScheduledTimer | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.at > this.now) continue;
        if (!selected || timer.at < selected.at) {
          selected = timer;
          selectedId = id;
        }
      }
      if (selectedId !== null && selected) {
        this.timers.delete(selectedId);
        selected.callback();
        ran = true;
      }
    }
  }
}

export class FakeMachine implements AgentControlPort {
  state: CoreState = 'idle';
  events: AgentEvent[] = [];

  async handle(event: AgentEvent): Promise<void> {
    this.events.push(event);
    if (event === 'agent:started') this.state = 'working';
    else if (event === 'agent:finished') this.state = 'done';
  }
}

export class FakeCpuProbe implements CpuProbe {
  sample: CpuSample | null = null;
  stopped = false;

  latest(): CpuSample | null {
    return this.sample;
  }

  stop(): void {
    this.stopped = true;
  }
}

export class FakeCpuProbeFactory implements CpuProbeFactory {
  probes: FakeCpuProbe[] = [];
  sample: CpuSample | null = null;

  create(_pid: number): CpuProbe {
    const probe = new FakeCpuProbe();
    probe.sample = this.sample;
    this.probes.push(probe);
    return probe;
  }
}

export interface FakeIntervals {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  callbacks: Array<() => void>;
  cleared: unknown[];
}

export function fakeIntervals(): FakeIntervals {
  const callbacks: Array<() => void> = [];
  const cleared: unknown[] = [];
  let id = 0;
  return {
    callbacks,
    cleared,
    setInterval: (callback) => {
      callbacks.push(callback);
      return ++id;
    },
    clearInterval: (handle) => {
      cleared.push(handle);
    },
  };
}

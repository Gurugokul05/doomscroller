export const AGENT_STARTED = 'agent:started' as const;
export const AGENT_FINISHED = 'agent:finished' as const;

export type AgentEvent = typeof AGENT_STARTED | typeof AGENT_FINISHED;
export type CoreState = 'idle' | 'working' | 'done';
export type SessionEndReason = 'finished' | 'hotkey' | 'cap';
export type AdapterKind = 'hotkey' | 'hook' | 'cli-wrapper' | 'ide-activity';
export type BrowserChoice = 'auto' | 'edge' | 'chrome' | 'brave' | 'firefox' | 'default';

export interface WindowHandle {
  /** Decimal Win32 HWND as a string to avoid precision loss. */
  id: string;
  title: string;
  processName: string;
  pid: number;
}

export interface WindowMatch {
  title?: string;
  process?: string;
}

export interface RegisteredAgent {
  name: string;
  adapter: AdapterKind;
  match?: WindowMatch;
  workspace?: string;
  quietSeconds?: number;
}

export interface DoomscrollerConfig {
  targets: string[];
  delaySeconds: number;
  quietSeconds: number;
  maxDoomscrollSeconds: number;
  hotkey: string | null;
  sound: boolean;
  browser: BrowserChoice;
  port: number;
  idleCpuPercent: number;
  registeredAgents: RegisteredAgent[];
  logPath: string;
  sessionLogPath: string;
}

export interface SessionRecord {
  type: 'session';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  doomscrollMs: number;
  target: string | null;
  end: SessionEndReason;
}

export interface SessionRecorder {
  record(record: SessionRecord): void;
}

export interface SoundPlayer {
  play(): void;
}

export interface TargetProvider {
  next(): string | null;
}

import path from 'node:path';
import { logCaught, Logger } from '../core/logger';
import { AGENT_FINISHED, AGENT_STARTED, CoreState, DoomscrollerConfig, RegisteredAgent, WindowHandle, WindowMatch } from '../core/types';
import { errorMessage } from '../util/errors';
import { expandHome } from '../util/paths';
import { CpuProbe, CpuProbeFactory } from '../windows/cpu-probe';
import { KeyEvent } from '../windows/key-listener';
import { MtimeScanner, scanMaxMtime } from './file-activity';
import { AgentControlPort, KeySource } from './ports';

export interface IntervalScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemIntervals: IntervalScheduler = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export function normalizeProcessName(value: string): string {
  return value.trim().toLowerCase().replace(/\.exe$/i, '');
}

export function windowMatches(window: WindowHandle, match: WindowMatch | undefined): boolean {
  if (!match) return false;
  const wantedProcess = match.process ? normalizeProcessName(match.process) : '';
  const wantedTitle = match.title ? match.title.trim().toLowerCase() : '';
  if (!wantedProcess && !wantedTitle) return false;
  if (wantedProcess && normalizeProcessName(window.processName) !== wantedProcess) return false;
  if (wantedTitle && !window.title.toLowerCase().includes(wantedTitle)) return false;
  return true;
}

interface ActiveSession {
  agent: RegisteredAgent;
  quietMs: number;
  probe: CpuProbe;
  workspace: string | null;
  lastMaxMtime: number;
  lastScanAt: number;
  lastActivityAt: number;
  lastCpuSeconds: number | null;
  lastCpuAt: number;
  timer: unknown;
  ticking: boolean;
}

export interface IdeActivityDeps {
  config: DoomscrollerConfig;
  machine: AgentControlPort;
  logger: Logger;
  keySource: KeySource | null;
  cpuProbes: CpuProbeFactory;
  scanWorkspace?: MtimeScanner;
  intervals?: IntervalScheduler;
  now?: () => number;
  tickIntervalMs?: number;
  scanIntervalMs?: number;
}

/**
 * GUI-agent adapter. Enter inside a registered IDE window starts a session.
 * A session finishes after quietSeconds with no workspace file changes and
 * low CPU across the window's process tree.
 */
export class IdeActivityAdapter {
  private unsubscribe: (() => void) | null = null;
  private session: ActiveSession | null = null;
  private starting = false;
  private finishing = false;
  private readonly intervals: IntervalScheduler;
  private readonly now: () => number;
  private readonly scanWorkspace: MtimeScanner;

  constructor(private readonly deps: IdeActivityDeps) {
    this.intervals = deps.intervals ?? systemIntervals;
    this.now = deps.now ?? Date.now;
    this.scanWorkspace = deps.scanWorkspace ?? scanMaxMtime;
  }

  private currentState(): CoreState {
    return this.deps.machine.state;
  }

  get isMonitoring(): boolean {
    return this.session !== null;
  }

  start(): void {
    if (!this.deps.keySource) return;
    this.unsubscribe = this.deps.keySource.onKey((event) => {
      void this.handleKeyEvent(event);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopMonitor();
  }

  findAgentForWindow(window: WindowHandle): RegisteredAgent | null {
    for (const agent of this.deps.config.registeredAgents) {
      if (agent.adapter !== 'ide-activity') continue;
      if (windowMatches(window, agent.match)) return agent;
    }
    return null;
  }

  async handleKeyEvent(event: KeyEvent): Promise<void> {
    try {
      if (event.key !== 'ENTER' || !event.window) return;
      // Shift+Enter is a newline in most agent chat inputs, and a modified
      // Enter is a shortcut elsewhere in the window. Neither submits a prompt,
      // so neither should start a session.
      if (event.ctrl || event.alt || event.shift) return;
      if (this.session || this.starting || this.finishing) return;
      if (this.currentState() === 'working') return;

      const agent = this.findAgentForWindow(event.window);
      if (!agent) return;
      await this.beginSession(agent, event.window);
    } catch (error) {
      this.starting = false;
      this.stopMonitor();
      logCaught(this.deps.logger, 'ide-activity key handling failed', error);
    }
  }

  async tick(): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (this.currentState() !== 'working') {
      this.stopMonitor();
      return;
    }
    if (session.ticking) return;

    session.ticking = true;
    try {
      const now = this.now();
      let activity = false;

      const sample = session.probe.latest();
      if (sample && sample.alive && sample.at !== session.lastCpuAt) {
        if (session.lastCpuSeconds !== null) {
          const elapsedSeconds = (sample.at - session.lastCpuAt) / 1000;
          const deltaSeconds = Math.max(0, sample.cpuSeconds - session.lastCpuSeconds);
          if (elapsedSeconds > 0) {
            const cpuPercent = (deltaSeconds / elapsedSeconds) * 100;
            if (cpuPercent > this.deps.config.idleCpuPercent) activity = true;
          }
        }
        session.lastCpuSeconds = sample.cpuSeconds;
        session.lastCpuAt = sample.at;
      }

      const scanInterval = this.deps.scanIntervalMs ?? 2000;
      if (session.workspace && now - session.lastScanAt >= scanInterval) {
        session.lastScanAt = now;
        try {
          const newest = await this.scanWorkspace(session.workspace);
          if (newest > session.lastMaxMtime) {
            session.lastMaxMtime = newest;
            activity = true;
          }
        } catch (error) {
          this.deps.logger.debug(`workspace scan failed: ${errorMessage(error)}`);
        }
      }

      if (activity) session.lastActivityAt = this.now();

      if (this.now() - session.lastActivityAt >= session.quietMs) {
        await this.finishSession(session);
      }
    } catch (error) {
      logCaught(this.deps.logger, 'ide-activity tick failed', error);
    } finally {
      const current = this.session;
      if (current) current.ticking = false;
    }
  }

  private async beginSession(agent: RegisteredAgent, window: WindowHandle): Promise<void> {
    this.starting = true;
    try {
      if (this.currentState() === 'working') return;

      const quietSeconds = agent.quietSeconds ?? this.deps.config.quietSeconds;
      const workspace = agent.workspace ? path.resolve(expandHome(agent.workspace)) : null;
      let baseline = 0;
      if (workspace) {
        try {
          baseline = await this.scanWorkspace(workspace);
        } catch (error) {
          this.deps.logger.debug(`could not baseline workspace: ${errorMessage(error)}`);
        }
      }

      if (this.currentState() === 'working') return;

      const now = this.now();
      const probe = this.deps.cpuProbes.create(window.pid);
      const initial = probe.latest();

      const session: ActiveSession = {
        agent,
        quietMs: Math.max(1, quietSeconds) * 1000,
        probe,
        workspace,
        lastMaxMtime: baseline,
        lastScanAt: now,
        lastActivityAt: now,
        lastCpuSeconds: initial?.cpuSeconds ?? null,
        lastCpuAt: initial?.at ?? now,
        timer: null,
        ticking: false,
      };
      this.session = session;

      this.deps.logger.info(
        `ide-activity: ${agent.name} started ("${window.title}", pid ${window.pid})`,
      );

      await this.deps.machine.handle(AGENT_STARTED);

      if (!this.session || this.currentState() !== 'working') {
        this.stopMonitor();
        return;
      }

      session.timer = this.intervals.setInterval(() => {
        void this.tick();
      }, this.deps.tickIntervalMs ?? 1000);
    } finally {
      this.starting = false;
    }
  }

  private async finishSession(session: ActiveSession): Promise<void> {
    if (this.session !== session) return;
    this.finishing = true;
    try {
      this.deps.logger.info(
        `ide-activity: ${session.agent.name} idle for ${Math.round(session.quietMs / 1000)}s -> finished`,
      );
      this.stopMonitor();
      await this.deps.machine.handle(AGENT_FINISHED);
    } catch (error) {
      logCaught(this.deps.logger, 'ide-activity finish failed', error);
    } finally {
      this.finishing = false;
    }
  }

  private stopMonitor(): void {
    const session = this.session;
    this.session = null;
    if (!session) return;
    if (session.timer !== null) {
      try {
        this.intervals.clearInterval(session.timer);
      } catch {
        // ignore
      }
    }
    try {
      session.probe.stop();
    } catch {
      // ignore
    }
  }
}

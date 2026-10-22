import { logCaught, Logger } from './logger';
import { SessionRecorder, SoundPlayer, TargetProvider } from './types';
import {
  AGENT_FINISHED,
  AGENT_STARTED,
  AgentEvent,
  CoreState,
  DoomscrollerConfig,
  SessionEndReason,
  WindowHandle,
} from './types';
import { errorMessage } from '../util/errors';
import { WindowController } from '../windows/window-controller';

export interface Scheduler {
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
}

export const systemScheduler: Scheduler = {
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

export interface StateChangeInfo {
  target: string | null;
  doomscrolling: boolean;
}

export interface StateMachineDeps {
  config: DoomscrollerConfig;
  windows: WindowController;
  logger: Logger;
  stats: SessionRecorder;
  sound: SoundPlayer;
  targets: TargetProvider;
  now?: () => number;
  scheduler?: Scheduler;
  onStateChange?: (state: CoreState, info: StateChangeInfo) => void;
}

export class DoomscrollerStateMachine {
  private currentState: CoreState = 'idle';
  private startedAtMs = 0;
  private doomStartedAtMs: number | null = null;
  private target: string | null = null;
  private agentWindow: WindowHandle | null = null;
  private browserWindow: WindowHandle | null = null;
  private delayTimer: unknown = null;
  private capTimer: unknown = null;
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;

  private readonly now: () => number;
  private readonly scheduler: Scheduler;

  constructor(private readonly deps: StateMachineDeps) {
    this.now = deps.now ?? Date.now;
    this.scheduler = deps.scheduler ?? systemScheduler;
  }

  get state(): CoreState {
    return this.currentState;
  }

  get isWorking(): boolean {
    return this.currentState === 'working';
  }

  get currentTarget(): string | null {
    return this.target;
  }

  /** Serializes events so overlapping hook callbacks can't interleave window operations. */
  handle(event: AgentEvent): Promise<void> {
    if (event === AGENT_STARTED) {
      return this.enqueue(() => this.onStarted());
    }
    if (event === AGENT_FINISHED) {
      return this.enqueue(() => this.onFinished());
    }
    return Promise.resolve();
  }

  /** Global hotkey / max-cap escape hatch. Ends the current session and restores focus. */
  forceReturn(reason: Exclude<SessionEndReason, 'finished'> = 'hotkey'): Promise<void> {
    return this.enqueue(async () => {
      if (this.currentState !== 'working') {
        this.deps.logger.debug(`force return ignored while ${this.currentState}`);
        return;
      }
      this.deps.logger.info(`force return requested (${reason})`);
      await this.endSession(reason);
    });
  }

  whenIdle(): Promise<void> {
    return this.tail;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.tail
      .then(operation)
      .catch((error) => {
        logCaught(this.deps.logger, 'state machine error', error);
      });
    this.tail = next;
    return next;
  }

  private onStarted(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.currentState === 'working') {
      this.deps.logger.debug('duplicate agent:started ignored');
      return Promise.resolve();
    }

    this.clearTimers();
    this.currentState = 'working';
    this.startedAtMs = this.now();
    this.doomStartedAtMs = null;
    this.target = null;
    this.agentWindow = null;
    this.browserWindow = null;
    this.notify();

    const delayMs = Math.max(0, this.deps.config.delaySeconds) * 1000;
    this.deps.logger.info(
      `agent:started -> WORKING (doomscroll in ${this.deps.config.delaySeconds}s)`,
    );

    if (delayMs === 0) return this.beginDoomscroll();

    this.delayTimer = this.scheduler.setTimer(() => {
      this.delayTimer = null;
      void this.enqueue(() => this.beginDoomscroll());
    }, delayMs);
    return Promise.resolve();
  }

  private onFinished(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.currentState !== 'working') {
      this.deps.logger.debug(`agent:finished ignored while ${this.currentState}`);
      return Promise.resolve();
    }
    return this.endSession('finished');
  }

  private async beginDoomscroll(): Promise<void> {
    if (this.disposed || this.currentState !== 'working' || this.doomStartedAtMs !== null) return;

    let agentWindow: WindowHandle | null = null;
    try {
      agentWindow = await this.deps.windows.getForegroundWindow();
    } catch (error) {
      logCaught(this.deps.logger, 'could not read foreground window', error);
    }

    if (agentWindow) {
      this.agentWindow = agentWindow;
      try {
        await this.deps.windows.minimizeWindow(agentWindow);
        this.deps.logger.info(
          `minimized agent window: "${agentWindow.title}" (${agentWindow.processName})`,
        );
      } catch (error) {
        logCaught(this.deps.logger, 'could not minimize agent window', error);
      }
    } else {
      this.deps.logger.warn('no foreground window to save; continuing without a restore target');
    }

    let target: string | null = null;
    try {
      target = this.deps.targets.next();
    } catch (error) {
      logCaught(this.deps.logger, 'could not pick a target', error);
    }

    if (!target) {
      this.deps.logger.warn('no doomscroll targets configured; restoring agent window');
      await this.restoreAgentWindow();
      return;
    }

    let browserWindow: WindowHandle | null = null;
    try {
      browserWindow = await this.deps.windows.openInNewBrowserWindow(target);
    } catch (error) {
      logCaught(this.deps.logger, 'could not open doomscroll target', error);
    }

    if (!browserWindow) {
      this.deps.logger.warn('browser window was not found; restoring agent window');
      await this.restoreAgentWindow();
      return;
    }

    this.browserWindow = browserWindow;
    this.target = target;
    this.doomStartedAtMs = this.now();
    this.notify();
    this.deps.logger.info(
      `doomscroll started: ${target} (browser ${browserWindow.processName} ${browserWindow.id})`,
    );

    const capSeconds = Math.max(0, this.deps.config.maxDoomscrollSeconds);
    if (capSeconds > 0) {
      this.capTimer = this.scheduler.setTimer(() => {
        this.capTimer = null;
        this.deps.logger.warn(`max doomscroll time reached (${capSeconds}s)`);
        void this.forceReturn('cap');
      }, capSeconds * 1000);
    }
  }

  private async endSession(reason: SessionEndReason): Promise<void> {
    const finishedAtMs = this.now();
    this.clearTimers();

    const wasDoomscrolling = this.doomStartedAtMs !== null;
    const durationMs = Math.max(0, finishedAtMs - this.startedAtMs);
    const doomscrollMs = wasDoomscrolling
      ? Math.max(0, finishedAtMs - (this.doomStartedAtMs as number))
      : 0;
    const agentWindow = this.agentWindow;
    const browserWindow = this.browserWindow;
    const target = this.target;

    this.currentState = 'done';
    this.notify();

    if (wasDoomscrolling) {
      if (browserWindow) {
        try {
          await this.deps.windows.minimizeWindow(browserWindow);
          this.deps.logger.info('minimized doomscroll browser window');
        } catch (error) {
          logCaught(this.deps.logger, 'could not minimize browser window', error);
        }
      }

      if (agentWindow) {
        try {
          const focused = await this.deps.windows.restoreAndFocusWindow(agentWindow);
          if (focused) {
            this.deps.logger.info(`restored agent window: "${agentWindow.title}"`);
          } else {
            this.deps.logger.warn('window restore ran but focus was not confirmed');
          }
        } catch (error) {
          logCaught(this.deps.logger, 'could not restore agent window', error);
        }
      }

      try {
        this.deps.sound.play();
      } catch (error) {
        logCaught(this.deps.logger, 'could not play notification sound', error);
      }
    }

    try {
      this.deps.stats.record({
        type: 'session',
        startedAt: new Date(this.startedAtMs).toISOString(),
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs,
        doomscrollMs,
        target,
        end: reason,
      });
    } catch (error) {
      logCaught(this.deps.logger, 'could not record session stats', error);
    }

    this.deps.logger.info(
      `session ended (${reason}) duration=${(durationMs / 1000).toFixed(1)}s doomscroll=${(
        doomscrollMs / 1000
      ).toFixed(1)}s -> DONE`,
    );

    this.doomStartedAtMs = null;
    this.agentWindow = null;
    this.browserWindow = null;
    this.target = null;
  }

  private async restoreAgentWindow(): Promise<void> {
    if (!this.agentWindow) return;
    try {
      await this.deps.windows.restoreAndFocusWindow(this.agentWindow);
    } catch (error) {
      logCaught(this.deps.logger, 'could not restore agent window', error);
    }
  }

  private clearTimers(): void {
    if (this.delayTimer !== null) {
      this.scheduler.clearTimer(this.delayTimer);
      this.delayTimer = null;
    }
    if (this.capTimer !== null) {
      this.scheduler.clearTimer(this.capTimer);
      this.capTimer = null;
    }
  }

  private notify(): void {
    try {
      this.deps.onStateChange?.(this.currentState, {
        target: this.target,
        doomscrolling: this.doomStartedAtMs !== null,
      });
    } catch (error) {
      this.deps.logger.debug(`state change callback failed: ${errorMessage(error)}`);
    }
  }
}

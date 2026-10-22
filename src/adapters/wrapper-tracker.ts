import { Scheduler, systemScheduler } from '../core/state-machine';

export interface WrapperTrackerOptions {
  quietMs: number;
  onStarted: () => void;
  onFinished: () => void;
  scheduler?: Scheduler;
}

/**
 * Enter starts a session, any output keeps it alive, and a silent gap ends it.
 * Kept independent of the PTY so the timing rules are unit-testable.
 */
export class WrapperActivityTracker {
  private started = false;
  private quietTimer: unknown = null;
  private readonly scheduler: Scheduler;

  constructor(private readonly options: WrapperTrackerOptions) {
    this.scheduler = options.scheduler ?? systemScheduler;
  }

  get isStarted(): boolean {
    return this.started;
  }

  onInput(data: string): void {
    if (this.started) return;
    if (!/[\r\n]/.test(data)) return;
    this.started = true;
    try {
      this.options.onStarted();
    } catch {
      // Adapter callbacks must not break the wrapped command.
    }
    this.resetQuietTimer();
  }

  onOutput(_data: string): void {
    if (!this.started) return;
    this.resetQuietTimer();
  }

  onExit(): void {
    if (!this.started) return;
    this.finish();
  }

  dispose(): void {
    if (this.quietTimer !== null) {
      this.scheduler.clearTimer(this.quietTimer);
      this.quietTimer = null;
    }
    this.started = false;
  }

  private resetQuietTimer(): void {
    if (this.quietTimer !== null) this.scheduler.clearTimer(this.quietTimer);
    this.quietTimer = this.scheduler.setTimer(() => {
      this.quietTimer = null;
      this.finish();
    }, this.options.quietMs);
  }

  private finish(): void {
    if (!this.started) return;
    this.started = false;
    if (this.quietTimer !== null) {
      this.scheduler.clearTimer(this.quietTimer);
      this.quietTimer = null;
    }
    try {
      this.options.onFinished();
    } catch {
      // Adapter callbacks must not break the wrapped command.
    }
  }
}

import { Logger } from '../core/logger';
import { AGENT_STARTED } from '../core/types';
import { errorMessage } from '../util/errors';
import { HotkeySpec, matchesHotkey } from '../windows/key-listener';
import { ForceReturnPort, KeySource } from './ports';

export interface HotkeyAdapterDeps {
  listener: KeySource;
  machine: ForceReturnPort;
  hotkey: HotkeySpec | null;
  logger: Logger;
}

/**
 * Default adapter: Ctrl+Alt+D starts a session when idle and force-returns
 * the agent window when a session is already running.
 */
export class HotkeyAdapter {
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: HotkeyAdapterDeps) {}

  start(): void {
    if (!this.deps.hotkey) {
      this.deps.logger.info('global hotkey disabled');
      return;
    }
    this.unsubscribe = this.deps.listener.onKey((event) => {
      if (!matchesHotkey(event, this.deps.hotkey!)) return;
      try {
        if (this.deps.machine.state === 'working') {
          this.deps.logger.info('hotkey: force return');
          void this.deps.machine.forceReturn('hotkey').catch((error) => {
            this.deps.logger.warn(`hotkey force return failed: ${errorMessage(error)}`);
          });
        } else {
          this.deps.logger.info('hotkey: agent started');
          void this.deps.machine.handle(AGENT_STARTED).catch((error) => {
            this.deps.logger.warn(`hotkey start failed: ${errorMessage(error)}`);
          });
        }
      } catch (error) {
        this.deps.logger.warn(`hotkey handler failed: ${errorMessage(error)}`);
      }
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

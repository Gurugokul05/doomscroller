import { spawn } from 'node:child_process';
import { Logger } from './logger';
import { SoundPlayer } from './types';
import { errorMessage } from '../util/errors';

const BEEP_SCRIPT = '[console]::beep(784,110); [console]::beep(1046,150)';

/** Plays a short two-tone chime without blocking the caller. */
export class WindowsSoundPlayer implements SoundPlayer {
  constructor(
    private enabled = true,
    private readonly logger?: Logger,
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  play(): void {
    if (!this.enabled) return;
    if (process.platform !== 'win32') return;
    try {
      // Not detached: a detached, console-less powershell.exe exits 0 without
      // running -Command, so the chime would never play.
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', BEEP_SCRIPT],
        { stdio: 'ignore', windowsHide: true },
      );
      child.on('error', (error) => {
        this.logger?.debug(`could not play notification sound: ${errorMessage(error)}`);
      });
      child.unref();
    } catch (error) {
      this.logger?.debug(`could not play notification sound: ${errorMessage(error)}`);
    }
  }
}

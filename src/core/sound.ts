import { spawn } from 'node:child_process';
import { SoundPlayer } from './types';

const BEEP_SCRIPT = '[console]::beep(784,110); [console]::beep(1046,150)';

/** Plays a short two-tone chime without blocking the caller. */
export class WindowsSoundPlayer implements SoundPlayer {
  constructor(private readonly enabled = true) {}

  play(): void {
    if (!this.enabled) return;
    if (process.platform !== 'win32') return;
    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', BEEP_SCRIPT],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      child.on('error', () => {});
      child.unref();
    } catch {
      // A failed chime must never break focus switching.
    }
  }
}

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { Logger } from '../core/logger';
import { scriptPath } from '../util/paths';

export interface CpuSample {
  cpuSeconds: number;
  at: number;
  alive: boolean;
  processes: number;
}

export interface CpuProbe {
  latest(): CpuSample | null;
  stop(): void;
}

export interface CpuProbeFactory {
  create(pid: number): CpuProbe;
}

/** Samples the total processor time of an entire process tree once per second. */
export class PowerShellCpuProbe implements CpuProbe {
  private sample: CpuSample | null = null;
  private stopped = false;
  private child: ReturnType<typeof spawn> | null = null;

  constructor(
    pid: number,
    private readonly logger: Logger,
    intervalMs = 1000,
  ) {
    if (process.platform !== 'win32') return;
    try {
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath('cpu-sampler.ps1'),
          '-RootPid',
          String(pid),
          '-IntervalMs',
          String(intervalMs),
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      this.child = child;
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) return;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          if (typeof parsed.cpuSeconds !== 'number' || typeof parsed.at !== 'number') return;
          this.sample = {
            cpuSeconds: parsed.cpuSeconds,
            at: parsed.at,
            alive: parsed.alive !== false,
            processes: typeof parsed.processes === 'number' ? parsed.processes : 0,
          };
        } catch {
          // Ignore malformed sampler output.
        }
      });
      child.stdout.on('error', () => {});
      child.stderr.on('data', () => {});
      child.stderr.on('error', () => {});
      child.on('error', () => this.markDead());
      child.on('close', () => {
        if (this.sample && this.sample.alive && !this.stopped) this.markDead();
      });
    } catch (error) {
      this.logger.debug(`cpu probe failed to start: ${String(error)}`);
    }
  }

  latest(): CpuSample | null {
    return this.sample;
  }

  stop(): void {
    this.stopped = true;
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // ignore
      }
      this.child = null;
    }
  }

  private markDead(): void {
    this.sample = {
      cpuSeconds: this.sample?.cpuSeconds ?? 0,
      at: Date.now(),
      alive: false,
      processes: 0,
    };
  }
}

export class PowerShellCpuProbeFactory implements CpuProbeFactory {
  constructor(private readonly logger: Logger) {}

  create(pid: number): CpuProbe {
    if (process.platform !== 'win32') {
      return {
        latest: () => null,
        stop: () => {},
      };
    }
    return new PowerShellCpuProbe(pid, this.logger);
  }
}

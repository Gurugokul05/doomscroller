import { spawn } from 'node:child_process';
import { BrowserChoice, WindowHandle, WindowMatch } from '../core/types';
import { Logger } from '../core/logger';
import { errorMessage } from '../util/errors';
import { scriptPath } from '../util/paths';
import { WindowController } from './window-controller';

interface PowerShellOutput {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

function runPowerShell(args: string[], timeoutMs: number): Promise<PowerShellOutput> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (error) {
      resolve({ stdout: '', stderr: errorMessage(error), code: null, timedOut: false });
      return;
    }

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish(null);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 2_000_000) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 200_000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      stderr += errorMessage(error);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/^\uFEFF/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toWindow(value: unknown): WindowHandle | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawId = record.id;
  const id =
    typeof rawId === 'string'
      ? rawId
      : typeof rawId === 'number' && Number.isFinite(rawId)
        ? String(rawId)
        : '';
  const pid = typeof record.pid === 'number' ? record.pid : Number(record.pid);
  if (!id || id === '0' || !Number.isFinite(pid) || pid <= 0) return null;
  return {
    id,
    title: typeof record.title === 'string' ? record.title : '',
    processName: typeof record.processName === 'string' ? record.processName : '',
    pid,
  };
}

export class Win32WindowController implements WindowController {
  constructor(
    private browser: BrowserChoice = 'auto',
    private readonly logger?: Logger,
  ) {}

  setBrowser(browser: BrowserChoice): void {
    this.browser = browser;
  }

  private async invoke(
    action: string,
    extraArgs: string[],
    timeoutMs = 15000,
  ): Promise<Record<string, unknown> | null> {
    if (process.platform !== 'win32') {
      this.logger?.warn('window control is only available on Windows');
      return null;
    }

    const result = await runPowerShell(
      [
        '-File',
        scriptPath('win32-window.ps1'),
        '-Action',
        action,
        ...extraArgs,
      ],
      timeoutMs,
    );

    const parsed = extractJson(result.stdout);
    if (!parsed) {
      this.logger?.debug(
        `win32 ${action} returned no JSON (code=${result.code}, timeout=${result.timedOut}): ${result.stderr.slice(0, 300)}`,
      );
    }
    return parsed;
  }

  async getForegroundWindow(): Promise<WindowHandle | null> {
    const result = await this.invoke('get-foreground', [], 8000);
    if (!result?.ok) return null;
    return toWindow(result.window);
  }

  /**
   * A saved HWND can go stale: browsers replace their startup window and some
   * apps recreate their top-level window. Re-resolve once by process name so a
   * session end can still act on something sensible instead of just failing.
   */
  private async replaceStaleHandle(handle: WindowHandle): Promise<WindowHandle | null> {
    if (!handle.processName) return null;
    try {
      const candidates = await this.findWindows({ process: handle.processName });
      const live = candidates.find((entry) => entry.id !== handle.id) ?? candidates[0];
      return live ?? null;
    } catch {
      return null;
    }
  }

  async minimizeWindow(handle: WindowHandle): Promise<void> {
    const result = await this.invoke('minimize', ['-Handle', handle.id], 8000);
    if (result?.ok) return;

    const replacement = await this.replaceStaleHandle(handle);
    if (replacement) {
      const retry = await this.invoke('minimize', ['-Handle', replacement.id], 8000);
      if (retry?.ok) {
        this.logger?.warn(
          `window ${handle.id} was no longer valid; minimized the live ` +
            `${replacement.processName} window ${replacement.id} instead`,
        );
        return;
      }
    }

    throw new Error(typeof result?.error === 'string' ? result.error : 'minimize failed');
  }

  async restoreAndFocusWindow(handle: WindowHandle): Promise<boolean> {
    // The PowerShell helper restores the window and applies the Alt-key
    // foreground-lock workaround before calling SetForegroundWindow.
    const result = await this.invoke('focus', ['-Handle', handle.id], 10000);
    if (result?.ok && result.focused) return true;

    const replacement = await this.replaceStaleHandle(handle);
    if (replacement) {
      const retry = await this.invoke('focus', ['-Handle', replacement.id], 10000);
      if (retry?.ok && retry.focused) {
        this.logger?.warn(
          `window ${handle.id} was no longer valid; restored the live ` +
            `${replacement.processName} window ${replacement.id} instead`,
        );
        return true;
      }
    }

    return Boolean(result?.ok && result.focused);
  }

  async openInNewBrowserWindow(url: string): Promise<WindowHandle | null> {
    const result = await this.invoke(
      'open-url',
      ['-Url', url, '-Browser', this.browser],
      22000,
    );
    if (!result?.ok) return null;
    return toWindow(result.window);
  }

  async findWindows(match: WindowMatch): Promise<WindowHandle[]> {
    const args: string[] = [];
    if (match.title) args.push('-Title', match.title);
    if (match.process) args.push('-ProcessName', match.process);
    if (args.length === 0) return [];

    const result = await this.invoke('find', args, 10000);
    if (!result?.ok || !Array.isArray(result.windows)) return [];
    return result.windows
      .map((entry) => toWindow(entry))
      .filter((entry): entry is WindowHandle => entry !== null);
  }
}

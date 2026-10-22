import fs from 'node:fs';
import path from 'node:path';
import { Logger } from '../core/logger';
import { EventClient } from '../core/ipc';
import { AGENT_FINISHED, AGENT_STARTED, DoomscrollerConfig } from '../core/types';
import { errorMessage } from '../util/errors';
import { WrapperActivityTracker } from './wrapper-tracker';

type NodePty = typeof import('node-pty');
type PtyProcess = ReturnType<NodePty['spawn']>;

interface ResolvedCommand {
  file: string;
  args: string[];
}

export function resolveExecutable(command: string): string | null {
  if (command.includes('/') || command.includes('\\')) {
    return fs.existsSync(command) ? command : null;
  }

  const pathValue = process.env.PATH ?? '';
  const directories = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean);
  if (!extensions.some((extension) => extension.toLowerCase() === '.ps1')) {
    extensions.push('.PS1');
  }

  const hasExtension = /\.[^\\/]+$/.test(command);
  for (const directory of directories) {
    if (hasExtension) {
      const candidate = path.join(directory, command);
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    // Prefer real Windows executable extensions; the extensionless file in an
    // npm install (C:\Program Files\nodejs\npm) is a Unix shell script.
    for (const extension of [...extensions, '']) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolves .cmd/.bat npm shims and .ps1 scripts so node-pty can launch them on
 * Windows. Plain executables are spawned directly.
 */
export function resolveCommandForPty(
  command: string,
  args: string[],
  platform: string = process.platform,
): ResolvedCommand {
  if (platform !== 'win32') return { file: command, args };

  const resolved = resolveExecutable(command);
  if (!resolved) return { file: command, args };

  const lower = resolved.toLowerCase();
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    // node-pty launches .cmd/.bat shims through the Windows shell itself.
    // Passing them to `cmd /c` as an argv array mangles quoted paths.
    return { file: resolved, args };
  }
  if (lower.endsWith('.ps1')) {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...args],
    };
  }
  return { file: resolved, args };
}

function loadNodePty(logger: Logger): NodePty | null {
  try {
    // Loaded lazily so all non-PTY commands work even if the native module
    // cannot be rebuilt on this machine.
    return require('node-pty') as NodePty;
  } catch (error) {
    logger.error(`node-pty is not available: ${errorMessage(error)}`);
    return null;
  }
}

function terminalSize(): { cols: number; rows: number } {
  const cols = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 120;
  const rows = process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 30;
  return { cols, rows };
}

export async function runCliWrapper(
  commandArgs: string[],
  config: DoomscrollerConfig,
  logger: Logger,
): Promise<number> {
  if (commandArgs.length === 0) {
    process.stderr.write('Usage: doomscroller run -- <command> [args...]\n');
    process.stderr.write('Example: doomscroller run -- claude\n');
    return 2;
  }

  const ptyModule = loadNodePty(logger);
  if (!ptyModule) {
    process.stderr.write(
      'doomscroller run: node-pty is not available. Re-run "npm install" in the doomscroller directory.\n',
    );
    return 1;
  }

  const resolved = resolveCommandForPty(commandArgs[0], commandArgs.slice(1));
  const size = terminalSize();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }

  let pty: PtyProcess;
  try {
    pty = ptyModule.spawn(resolved.file, resolved.args, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: process.cwd(),
      env,
    });
  } catch (error) {
    process.stderr.write(`doomscroller run: could not start command: ${errorMessage(error)}\n`);
    return 1;
  }

  const client = new EventClient(config.port);
  const tracker = new WrapperActivityTracker({
    quietMs: Math.max(1, config.quietSeconds) * 1000,
    onStarted: () => client.emit(AGENT_STARTED),
    onFinished: () => client.emit(AGENT_FINISHED),
  });

  const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false;

  return new Promise<number>((resolve) => {
    let cleaned = false;

    const onStdin = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      tracker.onInput(text);
      try {
        pty.write(text);
      } catch {
        // The child may have exited.
      }
    };

    const onResize = (): void => {
      const next = terminalSize();
      try {
        pty.resize(next.cols, next.rows);
      } catch {
        // ignore
      }
    };

    const onSignal = (): void => {
      try {
        pty.kill();
      } catch {
        // ignore
      }
    };

    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      try {
        process.stdin.pause();
      } catch {
        // ignore
      }
      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(Boolean(wasRaw));
        } catch {
          // ignore
        }
      }
      try {
        process.stdin.off('data', onStdin);
      } catch {
        // ignore
      }
      try {
        process.stdout.off('resize', onResize);
      } catch {
        // ignore
      }
      try {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      } catch {
        // ignore
      }
      tracker.dispose();
    };

    const dataSubscription = pty.onData((data) => {
      try {
        process.stdout.write(data);
      } catch {
        // ignore
      }
      tracker.onOutput(data);
    });

    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(true);
      } catch {
        // Not fatal; line-buffered input still works.
      }
    }
    process.stdin.resume();
    process.stdin.on('data', onStdin);
    process.stdout.on('resize', onResize);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    pty.onExit(({ exitCode }) => {
      tracker.onExit();
      void (async () => {
        await client.flush();
        try {
          dataSubscription.dispose();
        } catch {
          // ignore
        }
        cleanup();
        resolve(typeof exitCode === 'number' ? exitCode : 0);
      })();
    });
  });
}

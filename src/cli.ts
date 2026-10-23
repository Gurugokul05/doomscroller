import fs from 'node:fs';
import path from 'node:path';
import { installAntigravityHooks } from './adapters/antigravity-hooks';
import { installClaudeCodeHooks } from './adapters/claude-code-hooks';
import { installCommandCodeHooks } from './adapters/command-code-hooks';
import { runCliWrapper } from './adapters/cli-wrapper';
import { emitHookEvent } from './adapters/hook';
import { loadConfig, writeDefaultConfig } from './core/config';
import { startDaemon } from './core/daemon';
import { dispatchWithDaemon, sendIpcRequest } from './core/ipc';
import { createLogger } from './core/logger';
import { aggregateByDay, formatDuration, readSessions } from './core/stats';
import { AGENT_FINISHED, AGENT_STARTED, AgentEvent } from './core/types';
import { errorMessage } from './util/errors';
import { configFilePath, stateDirectory } from './util/paths';

export const VERSION = '0.3.1';

function usage(): string {
  return `doomscroller ${VERSION} - doomscroll while your coding agent works

Usage:
  doomscroller daemon                 Run the background daemon (hotkey + IDE activity)
  doomscroller hotkey                 Alias for daemon (the global hotkey is built in)
  doomscroller start                  Emit agent:started (hook-safe, never blocks)
  doomscroller done                   Emit agent:finished (hook-safe, never blocks)
  doomscroller status                 Show the daemon state
  doomscroller stop                   Stop a running daemon
  doomscroller run -- <command>       Wrap a terminal agent in a PTY
  doomscroller init                   Create ~/.doomscroller.json
  doomscroller init claude-code       Merge hooks into Claude Code settings
  doomscroller init command-code      Merge hooks into Command Code settings
  doomscroller init antigravity       Merge hooks into Antigravity hooks.json
  doomscroller config [--path|--json] Show the config path and effective config
  doomscroller stats [--days N|--all] Show doomscroll wait time per day

Adapters:
  1. hotkey        Ctrl+Alt+D starts when idle, force-returns when working
  2. hook          doomscroller start / done, plus init claude-code / command-code
  3. cli-wrapper   doomscroller run -- claude
  4. ide-activity  Enter in a registered IDE window

Config: ${configFilePath()}
`;
}

function printVersion(): number {
  process.stdout.write(`doomscroller ${VERSION}\n`);
  return 0;
}

async function daemonCommand(args: string[]): Promise<number | null> {
  let hidden = false;
  let portOverride: number | null = null;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--hidden') {
      hidden = true;
    } else if (arg === '--port' && args[index + 1]) {
      const parsed = Number(args[index + 1]);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65535) {
        portOverride = parsed;
        index++;
      }
    }
  }

  const loaded = loadConfig();
  const config = { ...loaded.config };
  if (portOverride !== null) config.port = portOverride;

  const logger = createLogger({ filePath: config.logPath, console: !hidden });
  if (loaded.error) logger.warn(loaded.error);

  let handle: Awaited<ReturnType<typeof startDaemon>>;
  try {
    handle = await startDaemon(config, logger);
  } catch (error) {
    const message = errorMessage(error);
    logger.error(message);
    if (message.includes('could not listen') && message.includes('another daemon')) {
      return 0;
    }
    if (!hidden) process.stderr.write(`${message}\n`);
    return 1;
  }

  if (!hidden) {
    process.stderr.write(
      `doomscroller daemon running. Global hotkey: ${config.hotkey ?? 'disabled'}. Press Ctrl+C to stop.\n`,
    );
  }

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await handle.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('uncaughtException', (error) => {
    logger.error(`uncaught exception: ${errorMessage(error)}`);
  });
  process.on('unhandledRejection', (error) => {
    logger.warn(`unhandled rejection: ${errorMessage(error)}`);
  });

  return null;
}

async function hookEventCommand(event: AgentEvent): Promise<number> {
  // Claude Code writes the hook payload to stdin. Drain it without waiting so
  // the writer never sees a broken pipe; the process still exits immediately.
  try {
    if (!process.stdin.isTTY) {
      process.stdin.on('data', () => {});
      process.stdin.resume();
    }
  } catch {
    // ignore
  }

  const loaded = loadConfig();
  await emitHookEvent(event, loaded.config.port);
  return 0;
}

interface HookInput {
  /** The payload exactly as it arrived, for the diagnostic log. */
  raw: string;
  payload: Record<string, unknown> | null;
}

/**
 * Reads a hook payload from stdin. Bounded, because a hook runs inside the
 * agent's execution loop and must never block it.
 */
async function readHookPayload(timeoutMs = 600): Promise<HookInput> {
  const empty: HookInput = { raw: '', payload: null };
  try {
    if (process.stdin.isTTY) return empty;
    return await new Promise<HookInput>((resolve) => {
      let text = '';
      let settled = false;
      const done = (result: HookInput): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const finish = (): void => {
        const trimmed = text.trim();
        if (trimmed === '') {
          done({ raw: text, payload: null });
          return;
        }
        try {
          const parsed: unknown = JSON.parse(trimmed);
          done({
            raw: text,
            payload:
              parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : null,
          });
        } catch {
          done({ raw: text, payload: null });
        }
      };
      const timer = setTimeout(finish, timeoutMs);
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk: string) => {
        text += chunk;
        if (text.length > 200_000) finish();
      });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
      process.stdin.resume();
    });
  } catch {
    return empty;
  }
}

/**
 * Appends one entry per hook invocation to
 * `~/.doomscroller/antigravity-hooks.log`, so it is possible to check whether
 * the hooks fire without a daemon running. Best effort: a hook must never fail
 * the agent because diagnostics could not be written.
 */
function logAntigravityHook(action: string, decision: string, raw: string): void {
  try {
    const logPath = path.join(stateDirectory(), 'antigravity-hooks.log');
    const payload = raw.trim() === '' ? '(empty)' : raw.trim().replace(/\s+/g, ' ');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      `${new Date().toISOString()} ${action} ${decision}\n  stdin: ${payload}\n`,
      'utf8',
    );
  } catch {
    // Diagnostics are best effort.
  }
}

/**
 * Antigravity parses this hook's stdout as JSON (see
 * https://antigravity.google/docs/hooks). `PreInvocation` takes an optional
 * `injectSteps` and the docs mark `Stop`'s `decision` as required — but the only
 * `Stop` value the docs define is `"continue"` (which would keep the agent
 * running); no non-`"continue"` value is specified. So we emit `{}` for both
 * events, which is valid JSON and, per the docs, lets the stop proceed.
 */
const HOOK_OUTPUT = '{}\n';

/**
 * Antigravity hook entry point (`antigravity-hook start|done`).
 *
 * Antigravity fires `Stop` on every termination of the execution loop,
 * including terminations that leave background tasks running. Its payload
 * carries `fullyIdle`, which is only true once the agent has completely
 * finished, so a stop with `fullyIdle: false` is not a real finish.
 */
async function antigravityHookCommand(action: string | undefined): Promise<number> {
  if (action !== 'start' && action !== 'done') return 0;

  const input = await readHookPayload();
  const suppressed = action === 'done' && input.payload?.fullyIdle === false;
  const decision = suppressed
    ? 'suppressed because fullyIdle=false'
    : action === 'start'
      ? 'started'
      : 'done';
  logAntigravityHook(action, decision, input.raw);

  if (suppressed) {
    process.stdout.write(HOOK_OUTPUT);
    return 0;
  }

  const loaded = loadConfig();
  await emitHookEvent(action === 'start' ? AGENT_STARTED : AGENT_FINISHED, loaded.config.port);
  process.stdout.write(HOOK_OUTPUT);
  return 0;
}

async function dispatchHelper(arg: string | undefined): Promise<number> {
  const event =
    arg === 'start' || arg === AGENT_STARTED
      ? AGENT_STARTED
      : arg === 'done' || arg === AGENT_FINISHED
        ? AGENT_FINISHED
        : null;
  if (!event) return 0;
  try {
    const loaded = loadConfig();
    await dispatchWithDaemon(event, loaded.config.port);
  } catch {
    // Silence is intentional.
  }
  return 0;
}

async function statusCommand(): Promise<number> {
  const loaded = loadConfig();
  const response = await sendIpcRequest(loaded.config.port, { type: 'status' }, 500);
  if (!response?.ok) {
    process.stdout.write('doomscroller daemon is not running\n');
    return 1;
  }
  const target = response.target ? ` target=${response.target}` : '';
  process.stdout.write(`state=${response.state ?? 'unknown'}${target}\n`);
  return 0;
}

async function stopCommand(): Promise<number> {
  const loaded = loadConfig();
  const response = await sendIpcRequest(loaded.config.port, { type: 'shutdown' }, 1500);
  if (!response?.ok) {
    process.stdout.write('doomscroller daemon is not running\n');
    return 1;
  }
  process.stdout.write('doomscroller daemon stopped\n');
  return 0;
}

async function runCommand(args: string[]): Promise<number> {
  const separator = args[0] === '--' ? 1 : 0;
  const commandArgs = args.slice(separator);
  if (commandArgs.length === 0) {
    process.stderr.write('Usage: doomscroller run -- <command> [args...]\n');
    return 2;
  }

  const loaded = loadConfig();
  const logger = createLogger({ filePath: loaded.config.logPath, console: false });
  if (loaded.error) logger.warn(loaded.error);
  return runCliWrapper(commandArgs, loaded.config, logger);
}

function configCommand(args: string[]): number {
  const loaded = loadConfig();
  const pathOnly = args.includes('--path');
  const jsonOnly = args.includes('--json');

  if (pathOnly) {
    process.stdout.write(`${loaded.path}\n`);
    return 0;
  }

  if (!jsonOnly) {
    process.stdout.write(`Config: ${loaded.path}\n`);
    process.stdout.write(`Exists: ${loaded.exists ? 'yes' : 'no'}\n`);
    if (loaded.error) process.stdout.write(`Warning: ${loaded.error}\n`);
    process.stdout.write('\n');
  }

  process.stdout.write(`${JSON.stringify(loaded.config, null, 2)}\n`);
  return 0;
}

async function initCommand(args: string[]): Promise<number> {
  if (args.length === 0) {
    const result = writeDefaultConfig();
    process.stdout.write(
      result.created
        ? `Created ${result.path}\n`
        : `Config already exists at ${result.path}\n`,
    );
    process.stdout.write('Next: doomscroller init claude-code\n');
    process.stdout.write('  or: doomscroller init command-code\n');
    return 0;
  }

  if (args[0] === 'claude-code') {
    const configResult = writeDefaultConfig();
    process.stdout.write(
      configResult.created
        ? `Created ${configResult.path}\n`
        : `Config already exists at ${configResult.path}\n`,
    );

    const result = await installClaudeCodeHooks();
    if (result.error) {
      process.stderr.write(`Could not install Claude Code hooks: ${result.error}\n`);
      return 1;
    }

    process.stdout.write(`Claude Code settings: ${result.settingsPath}\n`);
    if (result.changed) {
      process.stdout.write(`  added: ${result.added.join(', ') || 'none'}\n`);
      if (result.existing.length > 0) {
        process.stdout.write(`  already present: ${result.existing.join(', ')}\n`);
      }
      process.stdout.write('  backup: settings.json.doomscroller.bak\n');
    } else {
      process.stdout.write(
        `  hooks already present: ${result.existing.join(', ') || 'none'}\n`,
      );
    }
    process.stdout.write(
      'Claude Code hooks call doomscroller directly; no daemon needs to be running.\n',
    );
    return 0;
  }

  if (args[0] === 'command-code') {
    const configResult = writeDefaultConfig();
    process.stdout.write(
      configResult.created
        ? `Created ${configResult.path}\n`
        : `Config already exists at ${configResult.path}\n`,
    );

    const result = await installCommandCodeHooks();
    if (result.error) {
      process.stderr.write(`Could not install Command Code hooks: ${result.error}\n`);
      return 1;
    }

    process.stdout.write(`Command Code settings: ${result.settingsPath}\n`);
    if (result.changed) {
      process.stdout.write(`  added: ${result.added.join(', ') || 'none'}\n`);
      if (result.existing.length > 0) {
        process.stdout.write(`  already present: ${result.existing.join(', ')}\n`);
      }
      process.stdout.write('  backup: settings.json.doomscroller.bak\n');
    } else {
      process.stdout.write(
        `  hooks already present: ${result.existing.join(', ') || 'none'}\n`,
      );
    }
    process.stdout.write(
      'Command Code has no per-prompt hook: PreToolUse starts a session on the first '
        + 'tool call of a turn and Stop finishes it. Hooks are skipped in plan mode.\n',
    );
    return 0;
  }

  if (args[0] === 'antigravity') {
    const configResult = writeDefaultConfig();
    process.stdout.write(
      configResult.created
        ? `Created ${configResult.path}\n`
        : `Config already exists at ${configResult.path}\n`,
    );

    const result = installAntigravityHooks();
    if (result.error) {
      process.stderr.write(`Could not install Antigravity hooks: ${result.error}\n`);
      return 1;
    }

    process.stdout.write(`Antigravity hooks: ${result.hooksPath}\n`);
    if (result.legacyGroup) {
      process.stdout.write(
        '  warning: a legacy "doomscroll" hook group is present in hooks.json; it is left ' +
          'untouched. Remove it yourself if it is stale.\n',
      );
    }
    if (result.changed) {
      process.stdout.write(`  added: ${result.added.join(', ') || 'none'}\n`);
      if (result.existing.length > 0) {
        process.stdout.write(`  already present: ${result.existing.join(', ')}\n`);
      }
      process.stdout.write('  backup: hooks.json.doomscroller.bak\n');
    } else {
      process.stdout.write(
        `  hooks already present: ${result.existing.join(', ') || 'none'}\n`,
      );
    }
    process.stdout.write(
      'PreInvocation starts a session before each model call; Stop finishes it once\n'
        + 'the payload reports fullyIdle. Other named hooks are preserved.\n',
    );
    return 0;
  }

  process.stderr.write('Usage: doomscroller init [claude-code|command-code|antigravity]\n');
  return 1;
}

function statsCommand(args: string[]): number {
  let days: number | null = 14;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--all') {
      days = null;
    } else if (arg === '--days' && args[index + 1]) {
      const parsed = Number(args[index + 1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        days = Math.floor(parsed);
        index++;
      }
    }
  }

  const loaded = loadConfig();
  const records = readSessions(loaded.config.sessionLogPath);
  const rows = aggregateByDay(records, { days });

  if (rows.length === 0) {
    process.stdout.write(
      `No sessions logged yet (${loaded.config.sessionLogPath}). Use an adapter, then finish a session.\n`,
    );
    return 0;
  }

  const title = days === null ? 'all time' : `last ${days} days`;
  process.stdout.write(`Doomscroll wait time (${title})\n\n`);
  process.stdout.write('Date        Sessions     Waiting       Avg\n');

  let totalSessions = 0;
  let totalDoomscroll = 0;
  for (const row of rows) {
    totalSessions += row.sessions;
    totalDoomscroll += row.doomscrollMs;
    const average = row.sessions > 0 ? row.doomscrollMs / row.sessions : 0;
    process.stdout.write(
      `${row.date}  ${String(row.sessions).padStart(8)}  ${formatDuration(row.doomscrollMs).padStart(12)}  ${formatDuration(average).padStart(9)}\n`,
    );
  }

  const overallAverage = totalSessions > 0 ? totalDoomscroll / totalSessions : 0;
  process.stdout.write('\n');
  process.stdout.write(
    `Total      ${String(totalSessions).padStart(8)}  ${formatDuration(totalDoomscroll).padStart(12)}  ${formatDuration(overallAverage).padStart(9)}\n`,
  );
  return 0;
}

export async function main(argv: string[]): Promise<number | null> {
  const command = argv[0];

  try {
    switch (command) {
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        process.stdout.write(usage());
        return 0;
      case '-v':
      case '--version':
      case 'version':
        return printVersion();
      case 'daemon':
      case 'hotkey':
        return await daemonCommand(argv.slice(1));
      case 'start':
        return await hookEventCommand(AGENT_STARTED);
      case 'done':
        return await hookEventCommand(AGENT_FINISHED);
      case 'antigravity-hook':
        return await antigravityHookCommand(argv[1]);
      case '__dispatch':
        return await dispatchHelper(argv[1]);
      case 'status':
        return await statusCommand();
      case 'stop':
        return await stopCommand();
      case 'run':
        return await runCommand(argv.slice(1));
      case 'config':
        return configCommand(argv.slice(1));
      case 'init':
        return await initCommand(argv.slice(1));
      case 'stats':
        return statsCommand(argv.slice(1));
      default:
        process.stderr.write(`Unknown command: ${command}\n\n${usage()}`);
        return 1;
    }
  } catch (error) {
    // Hooks call start/done; those must never surface a failure to the agent.
    if (command !== 'start' && command !== 'done' && command !== '__dispatch') {
      process.stderr.write(`${errorMessage(error)}\n`);
    }
    return 1;
  }
}

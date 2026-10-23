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
import { configFilePath } from './util/paths';

export const VERSION = '0.1.0';

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

  process.stderr.write('Usage: doomscroller init [claude-code|command-code]\n');
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

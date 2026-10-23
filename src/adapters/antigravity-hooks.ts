import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from '../util/errors';
import { antigravityHooksPath, cliEntryPath } from '../util/paths';

/**
 * Antigravity keeps its hooks in a `hooks.json` whose shape differs from the
 * Claude Code / Command Code `settings.json`: the top level maps a *hook name*
 * to its event configuration, and the events we use take a flat handler list
 * (only PreToolUse/PostToolUse use `{matcher, hooks: [...]}`).
 *
 * Start is `PreInvocation` (fires before every model call, i.e. once per turn).
 * `SessionStart` is deliberately not used: it fires once per *conversation*, so
 * a second prompt in the same conversation would never start a session.
 *
 * Finish is `Stop`, gated on the payload's `fullyIdle` flag.
 */
export const HOOK_NAME = 'doomscroller';

export const HOOK_EVENTS = ['PreInvocation', 'Stop'] as const;

export const HOOK_TIMEOUT_SECONDS = 5;

export type HookAction = 'start' | 'done';

/** The CLI subcommand the hook command invokes. */
export const ACTION_ARGUMENT = 'antigravity-hook';

/** Which doomscroller action each Antigravity event runs. */
export const HOOK_ACTIONS: Record<string, HookAction> = {
  PreInvocation: 'start',
  Stop: 'done',
};

/**
 * True when the value cannot be used unquoted as a shell word. Shell
 * metacharacters are included so an unusual install path never produces a
 * command that gets re-parsed by the shell.
 */
function needsQuoting(value: string): boolean {
  return /[\s"'&|<>^()%!$`*?]/.test(value);
}

/** PowerShell single-quoted literal; embedded single quotes are doubled. */
function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Builds the command Antigravity runs for one hook action.
 *
 * A command that begins with a quoted path is not executed: PowerShell needs
 * the call operator (`&`) before a quoted path, and cmd folds the leading quote
 * into the program name. So the bare form is only used when it needs no quoting
 * at all; anything else is handed to PowerShell explicitly.
 */
export function buildHookCommand(options: {
  action: HookAction;
  nodePath: string;
  cliPath: string;
  nodeOnPath: boolean;
}): string {
  const { action, nodePath, cliPath, nodeOnPath } = options;
  if (nodeOnPath && !needsQuoting(nodePath) && !needsQuoting(cliPath)) {
    return `node ${cliPath} ${ACTION_ARGUMENT} ${action}`;
  }
  return (
    `powershell.exe -NoProfile -Command "& ${powerShellLiteral(nodePath)} ` +
    `${powerShellLiteral(cliPath)} ${ACTION_ARGUMENT} ${action}"`
  );
}

/** True when `process.execPath` is the `node` a shell finds on PATH. */
export function nodeResolvesOnPath(): boolean {
  const pathValue = process.env.PATH ?? '';
  if (pathValue.trim() === '') return false;
  const target = process.execPath.toLowerCase();
  for (const entry of pathValue.split(path.delimiter)) {
    const directory = entry.trim();
    if (directory === '') continue;
    for (const name of ['node.exe', 'node']) {
      if (path.join(directory, name).toLowerCase() === target) return true;
    }
  }
  return false;
}

export function hookCommands(nodeOnPath: boolean = nodeResolvesOnPath()): Record<string, string> {
  const base = { nodePath: process.execPath, cliPath: cliEntryPath(), nodeOnPath };
  const commands: Record<string, string> = {};
  for (const eventName of HOOK_EVENTS) {
    commands[eventName] = buildHookCommand({ ...base, action: HOOK_ACTIONS[eventName] });
  }
  return commands;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonicalHandler(command: string): Record<string, unknown> {
  return { type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS };
}

/**
 * True when a stored command already invokes this doomscroller hook action,
 * whatever form it was written in — including the old quoted-path form that
 * Antigravity refuses to execute.
 */
export function commandTargetsAction(command: string, action: HookAction): boolean {
  const trimmed = command.trim();
  // The PowerShell form closes with the -Command quote and the bare form does
  // not, so a trailing quote after the action argument is allowed.
  if (!new RegExp(`(?:^|[\\s"'])${action}["']?\\s*$`, 'i').test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  return (
    lower.includes(ACTION_ARGUMENT) ||
    lower.includes('doomscroller') ||
    lower.includes('index.js') ||
    lower.includes('index.ts')
  );
}

interface NormalizeResult {
  handlers: unknown[];
  changed: boolean;
}

/**
 * Ensures the handler list holds exactly one doomscroller handler carrying the
 * canonical command. A stale command is replaced in place rather than appended,
 * so re-running the installer upgrades it instead of stacking duplicates.
 */
function normalizeHandlers(
  handlers: unknown[],
  command: string,
  action: HookAction,
): NormalizeResult {
  const result: unknown[] = [];
  let inserted = false;
  let changed = false;

  for (const handler of handlers) {
    const record = asRecord(handler);
    const existingCommand =
      record && typeof record.command === 'string' ? record.command : null;
    if (existingCommand === null || !commandTargetsAction(existingCommand, action)) {
      result.push(handler);
      continue;
    }
    if (inserted) {
      // A second handler we own; collapse it away.
      changed = true;
      continue;
    }
    inserted = true;
    if (existingCommand === command) {
      result.push(handler);
      continue;
    }
    result.push(canonicalHandler(command));
    changed = true;
  }

  if (!inserted) {
    result.push(canonicalHandler(command));
    changed = true;
  }

  return { handlers: result, changed };
}

export interface HookMergeResult {
  hooks: Record<string, unknown>;
  added: string[];
  existing: string[];
  error?: string;
}

/**
 * Adds or upgrades the doomscroller hook group without touching any other named
 * hook (including a legacy `doomscroll` group). Re-running with the same
 * commands is a no-op.
 */
export function mergeAntigravityHooks(
  hooksFile: unknown,
  commands: Record<string, string>,
  actions: Record<string, HookAction> = HOOK_ACTIONS,
): HookMergeResult {
  const root = asRecord(hooksFile) ?? {};
  const groupRaw = root[HOOK_NAME];
  if (groupRaw !== undefined && !asRecord(groupRaw)) {
    return {
      hooks: root,
      added: [],
      existing: [],
      error: `"${HOOK_NAME}" in hooks.json is not an object`,
    };
  }

  const group: Record<string, unknown> = { ...(asRecord(groupRaw) ?? {}) };
  const added: string[] = [];
  const existing: string[] = [];

  for (const [eventName, command] of Object.entries(commands)) {
    const current = group[eventName];
    if (current !== undefined && !Array.isArray(current)) {
      return {
        hooks: root,
        added,
        existing,
        error: `hooks.json ${HOOK_NAME}.${eventName} exists but is not an array; refusing to overwrite it`,
      };
    }

    const handlers = current === undefined ? [] : [...(current as unknown[])];
    const normalized = normalizeHandlers(handlers, command, actions[eventName] ?? 'start');
    if (!normalized.changed) {
      existing.push(eventName);
      continue;
    }

    group[eventName] = normalized.handlers;
    added.push(eventName);
  }

  return { hooks: { ...root, [HOOK_NAME]: group }, added, existing };
}

export interface HookInstallResult {
  hooksPath: string;
  added: string[];
  existing: string[];
  changed: boolean;
  error?: string;
}

export function installAntigravityHooks(
  hooksPath: string = antigravityHooksPath(),
  nodeOnPath: boolean = nodeResolvesOnPath(),
): HookInstallResult {
  let raw: unknown = {};
  try {
    const text = fs.readFileSync(hooksPath, 'utf8').replace(/^\uFEFF/, '');
    if (text.trim() !== '') raw = JSON.parse(text);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      return {
        hooksPath,
        added: [],
        existing: [],
        changed: false,
        error: `could not read ${hooksPath}: ${errorMessage(error)}`,
      };
    }
  }

  const merged = mergeAntigravityHooks(raw, hookCommands(nodeOnPath));
  if (merged.error) {
    return {
      hooksPath,
      added: merged.added,
      existing: merged.existing,
      changed: false,
      error: merged.error,
    };
  }

  if (merged.added.length === 0) {
    return { hooksPath, added: [], existing: merged.existing, changed: false };
  }

  try {
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    if (fs.existsSync(hooksPath)) {
      fs.copyFileSync(hooksPath, `${hooksPath}.doomscroller.bak`);
    }
    // Antigravity parses hooks.json with Go's JSON decoder, which fails on a
    // UTF-8 BOM ("invalid character '\ufeff' looking for beginning of value")
    // and then silently loads zero hooks. Write plain UTF-8, never a BOM.
    const json = `${JSON.stringify(merged.hooks, null, 2)}\n`;
    const temporary = `${hooksPath}.doomscroller-${process.pid}.tmp`;
    fs.writeFileSync(temporary, json, 'utf8');
    try {
      fs.renameSync(temporary, hooksPath);
    } catch {
      fs.writeFileSync(hooksPath, json, 'utf8');
      try {
        fs.unlinkSync(temporary);
      } catch {
        // ignore
      }
    }
    return {
      hooksPath,
      added: merged.added,
      existing: merged.existing,
      changed: true,
    };
  } catch (error) {
    return {
      hooksPath,
      added: merged.added,
      existing: merged.existing,
      changed: false,
      error: `could not write ${hooksPath}: ${errorMessage(error)}`,
    };
  }
}

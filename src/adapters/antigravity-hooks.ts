import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from '../util/errors';
import { antigravityHooksPath, cliEntryPath, stateDirectory } from '../util/paths';

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
 *
 * Command form: Antigravity runs the `command` string through a shell on
 * Windows. A command that *starts* with a quoted path is not executed (cmd
 * folds the leading quote into the program name; PowerShell needs the call
 * operator). A `powershell.exe -NoProfile -Command "& '<node>' '<cli>' ..."`
 * wrapper does not work either: the nested quoting is lost and the literal
 * `& '<node>' '<cli>' ...` text is captured as the hook's stdout, which then
 * fails Antigravity's JSON parse ("invalid value &"). So the interpreter is
 * always the bare `node` and only the script argument is ever quoted.
 */
export const HOOK_NAME = 'doomscroller';

/** A legacy group the first prototypes used; never modified, only warned about. */
export const LEGACY_HOOK_NAME = 'doomscroll';

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

/** Double-quote a value only when leaving it bare would break the shell. */
function quoteArgument(value: string): string {
  return needsQuoting(value) ? `"${value}"` : value;
}

/**
 * Builds the command Antigravity runs for one hook action when `node` resolves
 * from PATH. The command never begins with a quote, so both cmd.exe and
 * PowerShell execute it; the CLI path is quoted only when it needs it. The
 * interpreter is the bare `node`, so `nodePath` is irrelevant here.
 */
export function buildHookCommand(options: { action: HookAction; cliPath: string }): string {
  return `node ${quoteArgument(options.cliPath)} ${ACTION_ARGUMENT} ${options.action}`;
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

/** Name of the wrapper script used when `node` cannot be resolved from PATH. */
export function wrapperFileName(action: HookAction): string {
  return process.platform === 'win32'
    ? `antigravity-hook-${action}.cmd`
    : `antigravity-hook-${action}.sh`;
}

/** A wrapper that re-invokes the CLI through the absolute node path. */
function wrapperContents(nodePath: string, cliPath: string, action: HookAction): string {
  const invocation = `${quoteArgument(nodePath)} ${quoteArgument(cliPath)} ${ACTION_ARGUMENT} ${action}`;
  return process.platform === 'win32' ? `@echo off\r\n${invocation}\r\n` : `#!/bin/sh\nexec ${invocation}\n`;
}

export interface PlannedHooks {
  /** event name -> command to store in hooks.json */
  commands: Record<string, string>;
  /** files that must exist before the commands can run */
  wrappers: { path: string; contents: string }[];
  /** set when no command Antigravity can execute could be produced */
  error?: string;
}

/**
 * Decides the command for every hook event. With `node` on PATH this is the
 * bare form. Otherwise it generates a wrapper script that calls the absolute
 * node path; if even the wrapper path cannot be expressed without a leading
 * quote, it returns an error instead of writing a command that never runs.
 */
export function planAntigravityHooks(
  options: {
    nodeOnPath?: boolean;
    nodePath?: string;
    cliPath?: string;
    wrapperDirectory?: string;
  } = {},
): PlannedHooks {
  const nodeOnPath = options.nodeOnPath ?? nodeResolvesOnPath();
  const nodePath = options.nodePath ?? process.execPath;
  const cliPath = options.cliPath ?? cliEntryPath();
  const wrapperDirectory = options.wrapperDirectory ?? stateDirectory();

  const commands: Record<string, string> = {};
  const wrappers: { path: string; contents: string }[] = [];

  for (const eventName of HOOK_EVENTS) {
    const action = HOOK_ACTIONS[eventName];
    if (nodeOnPath) {
      commands[eventName] = buildHookCommand({ action, cliPath });
      continue;
    }
    const wrapperPath = path.join(wrapperDirectory, wrapperFileName(action));
    if (needsQuoting(wrapperPath)) {
      return {
        commands: {},
        wrappers: [],
        error:
          `node is not on PATH and the wrapper path "${wrapperPath}" contains spaces or shell ` +
          'metacharacters that Antigravity cannot execute. Put node on PATH (or set ' +
          'DOOMSCROLLER_HOME to a path without spaces) and re-run `doomscroller init antigravity`.',
      };
    }
    wrappers.push({ path: wrapperPath, contents: wrapperContents(nodePath, cliPath, action) });
    commands[eventName] = wrapperPath;
  }

  return { commands, wrappers };
}

/** Convenience wrapper returning just the commands for the current machine. */
export function hookCommands(nodeOnPath: boolean = nodeResolvesOnPath()): Record<string, string> {
  return planAntigravityHooks({ nodeOnPath }).commands;
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
 * whatever form it was written in — the old quoted-path form, the removed
 * PowerShell `-Command "& ..."` form, or a generated wrapper script.
 */
export function commandTargetsAction(command: string, action: HookAction): boolean {
  const trimmed = command.trim();
  const lower = trimmed.toLowerCase();
  // Wrapper form: `...\antigravity-hook-<action>.cmd`.
  if (lower.includes(`${ACTION_ARGUMENT}-${action}`)) return true;
  // Bare or `-Command`-wrapped form: the action is the trailing argument (a
  // trailing quote after it is allowed).
  if (!new RegExp(`(?:^|[\\s"'])${action}["']?\\s*$`, 'i').test(trimmed)) return false;
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
 * so re-running the installer upgrades the old quoted or wrapped form instead
 * of stacking duplicates.
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
  /** True when a legacy `doomscroll` group is present (left untouched). */
  legacyGroup: boolean;
  error?: string;
}

/**
 * Adds or upgrades the doomscroller hook group without touching any other named
 * hook (including a legacy `doomscroll` group, which is only reported). Running
 * again with the same commands is a no-op.
 */
export function mergeAntigravityHooks(
  hooksFile: unknown,
  commands: Record<string, string>,
  actions: Record<string, HookAction> = HOOK_ACTIONS,
): HookMergeResult {
  const root = asRecord(hooksFile) ?? {};
  const legacyGroup = root[LEGACY_HOOK_NAME] !== undefined;
  const groupRaw = root[HOOK_NAME];
  if (groupRaw !== undefined && !asRecord(groupRaw)) {
    return {
      hooks: root,
      added: [],
      existing: [],
      legacyGroup,
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
        legacyGroup,
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

  return { hooks: { ...root, [HOOK_NAME]: group }, added, existing, legacyGroup };
}

export interface HookInstallResult {
  hooksPath: string;
  added: string[];
  existing: string[];
  changed: boolean;
  /** True when a legacy `doomscroll` group is present (left untouched). */
  legacyGroup: boolean;
  error?: string;
}

export function installAntigravityHooks(
  hooksPath: string = antigravityHooksPath(),
  nodeOnPath: boolean = nodeResolvesOnPath(),
): HookInstallResult {
  const planned = planAntigravityHooks({ nodeOnPath, wrapperDirectory: stateDirectory() });
  if (planned.error) {
    return {
      hooksPath,
      added: [],
      existing: [],
      changed: false,
      legacyGroup: false,
      error: planned.error,
    };
  }

  let raw: unknown = {};
  const read = (): string | null => {
    try {
      const text = fs.readFileSync(hooksPath, 'utf8').replace(/^\uFEFF/, '');
      if (text.trim() !== '') raw = JSON.parse(text);
      return null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      return `could not read ${hooksPath}: ${errorMessage(error)}`;
    }
  };
  const readError = read();
  if (readError) {
    return { hooksPath, added: [], existing: [], changed: false, legacyGroup: false, error: readError };
  }

  const merged = mergeAntigravityHooks(raw, planned.commands);
  if (merged.error) {
    return {
      hooksPath,
      added: merged.added,
      existing: merged.existing,
      changed: false,
      legacyGroup: merged.legacyGroup,
      error: merged.error,
    };
  }

  if (merged.added.length === 0) {
    return {
      hooksPath,
      added: [],
      existing: merged.existing,
      changed: false,
      legacyGroup: merged.legacyGroup,
    };
  }

  try {
    // Write the wrapper scripts first so hooks.json never points at a file that
    // does not exist yet.
    for (const wrapper of planned.wrappers) {
      fs.mkdirSync(path.dirname(wrapper.path), { recursive: true });
      fs.writeFileSync(wrapper.path, wrapper.contents, 'utf8');
    }
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
      legacyGroup: merged.legacyGroup,
    };
  } catch (error) {
    return {
      hooksPath,
      added: merged.added,
      existing: merged.existing,
      changed: false,
      legacyGroup: merged.legacyGroup,
      error: `could not write ${hooksPath}: ${errorMessage(error)}`,
    };
  }
}

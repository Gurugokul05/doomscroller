import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from '../util/errors';
import { claudeSettingsPath, cliEntryPath } from '../util/paths';

export const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'Notification'] as const;
export type HookAction = 'start' | 'done';

export function hookCommand(action: HookAction): string {
  return `"${process.execPath}" "${cliEntryPath()}" ${action}`;
}

export function hookCommands(): Record<string, string> {
  const start = hookCommand('start');
  const done = hookCommand('done');
  return {
    UserPromptSubmit: start,
    Stop: done,
    Notification: done,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function commandTargetsAction(command: string, action: string): boolean {
  const trimmed = command.trim();
  const ending = new RegExp(`(?:^|[\\s"'=])${action}\\s*$`, 'i');
  if (!ending.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  return lower.includes('doomscroller') || lower.includes('index.js') || lower.includes('index.ts');
}

function groupsContainCommand(groups: unknown[], command: string, action: string): boolean {
  for (const group of groups) {
    const record = asRecord(group);
    if (!record || !Array.isArray(record.hooks)) continue;
    for (const hook of record.hooks) {
      const hookRecord = asRecord(hook);
      if (!hookRecord || typeof hookRecord.command !== 'string') continue;
      if (hookRecord.command === command || commandTargetsAction(hookRecord.command, action)) {
        return true;
      }
    }
  }
  return false;
}

export interface HookMergeResult {
  settings: Record<string, unknown>;
  added: string[];
  existing: string[];
  error?: string;
}

/**
 * Adds doomscroller hooks without replacing any existing hook groups. Running
 * this repeatedly is a no-op because an existing doomscroller command for the
 * same event is detected first.
 */
export function mergeClaudeHooks(settings: unknown, commands: Record<string, string>): HookMergeResult {
  const root = asRecord(settings) ?? {};
  const hooksRaw = root.hooks;
  if (hooksRaw !== undefined && !asRecord(hooksRaw)) {
    return { settings: root, added: [], existing: [], error: '"hooks" in settings.json is not an object' };
  }

  const hooks: Record<string, unknown> = { ...(asRecord(hooksRaw) ?? {}) };
  const added: string[] = [];
  const existing: string[] = [];

  for (const [eventName, command] of Object.entries(commands)) {
    const current = hooks[eventName];
    if (current !== undefined && !Array.isArray(current)) {
      return {
        settings: root,
        added,
        existing,
        error: `hooks.${eventName} exists but is not an array; refusing to overwrite it`,
      };
    }

    const groups = current === undefined ? [] : [...(current as unknown[])];
    const action = eventName === 'UserPromptSubmit' ? 'start' : 'done';
    if (groupsContainCommand(groups, command, action)) {
      existing.push(eventName);
      continue;
    }

    groups.push({ hooks: [{ type: 'command', command }] });
    hooks[eventName] = groups;
    added.push(eventName);
  }

  return {
    settings: { ...root, hooks },
    added,
    existing,
  };
}

export interface HookInstallResult {
  settingsPath: string;
  added: string[];
  existing: string[];
  changed: boolean;
  error?: string;
}

export async function installClaudeCodeHooks(
  settingsPath: string = claudeSettingsPath(),
): Promise<HookInstallResult> {
  let raw: unknown = {};
  try {
    const text = fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '');
    if (text.trim() !== '') raw = JSON.parse(text);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      return {
        settingsPath,
        added: [],
        existing: [],
        changed: false,
        error: `could not read ${settingsPath}: ${errorMessage(error)}`,
      };
    }
  }

  const merged = mergeClaudeHooks(raw, hookCommands());
  if (merged.error) {
    return {
      settingsPath,
      added: merged.added,
      existing: merged.existing,
      changed: false,
      error: merged.error,
    };
  }

  if (merged.added.length === 0) {
    return {
      settingsPath,
      added: [],
      existing: merged.existing,
      changed: false,
    };
  }

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    if (fs.existsSync(settingsPath)) {
      fs.copyFileSync(settingsPath, `${settingsPath}.doomscroller.bak`);
    }
    const json = `${JSON.stringify(merged.settings, null, 2)}\n`;
    const temporary = `${settingsPath}.doomscroller-${process.pid}.tmp`;
    fs.writeFileSync(temporary, json, 'utf8');
    try {
      fs.renameSync(temporary, settingsPath);
    } catch {
      fs.writeFileSync(settingsPath, json, 'utf8');
      try {
        fs.unlinkSync(temporary);
      } catch {
        // ignore
      }
    }
    return {
      settingsPath,
      added: merged.added,
      existing: merged.existing,
      changed: true,
    };
  } catch (error) {
    return {
      settingsPath,
      added: merged.added,
      existing: merged.existing,
      changed: false,
      error: `could not write ${settingsPath}: ${errorMessage(error)}`,
    };
  }
}

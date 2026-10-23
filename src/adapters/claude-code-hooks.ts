import { claudeSettingsPath } from '../util/paths';
import {
  HookActionFor,
  HookInstallResult,
  HookMergeResult,
  hookCommand,
  installHookSettings,
  mergeHookSettings,
} from './hook-settings';

export { hookCommand };
export type { HookAction, HookInstallResult, HookMergeResult } from './hook-settings';

export const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'Notification'] as const;

export function hookCommands(): Record<string, string> {
  const start = hookCommand('start');
  const done = hookCommand('done');
  return {
    UserPromptSubmit: start,
    Stop: done,
    Notification: done,
  };
}

const actionFor: HookActionFor = (eventName) => (eventName === 'UserPromptSubmit' ? 'start' : 'done');

export function mergeClaudeHooks(
  settings: unknown,
  commands: Record<string, string>,
): HookMergeResult {
  return mergeHookSettings(settings, commands, actionFor);
}

export async function installClaudeCodeHooks(
  settingsPath: string = claudeSettingsPath(),
): Promise<HookInstallResult> {
  return installHookSettings(settingsPath, hookCommands(), actionFor);
}

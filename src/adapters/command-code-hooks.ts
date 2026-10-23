import { commandCodeSettingsPath } from '../util/paths';
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

/**
 * Command Code has no per-prompt hook, so start is driven by the first tool
 * call of a turn (`PreToolUse`) and finish by the end of the turn (`Stop`).
 * Both events omit `matcher`: a matcher on `Stop` stops it firing entirely,
 * and omitting it on `PreToolUse` matches every tool.
 */
export const HOOK_EVENTS = ['PreToolUse', 'Stop'] as const;

export function hookCommands(): Record<string, string> {
  const start = hookCommand('start');
  const done = hookCommand('done');
  return {
    PreToolUse: start,
    Stop: done,
  };
}

const actionFor: HookActionFor = (eventName) => (eventName === 'PreToolUse' ? 'start' : 'done');

export function mergeCommandCodeHooks(
  settings: unknown,
  commands: Record<string, string>,
): HookMergeResult {
  return mergeHookSettings(settings, commands, actionFor);
}

export async function installCommandCodeHooks(
  settingsPath: string = commandCodeSettingsPath(),
): Promise<HookInstallResult> {
  return installHookSettings(settingsPath, hookCommands(), actionFor);
}

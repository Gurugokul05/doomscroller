import os from 'node:os';
import path from 'node:path';

export function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function doomscrollerHome(): string {
  const override = process.env.DOOMSCROLLER_HOME;
  if (override) return path.resolve(expandHome(override));
  return os.homedir();
}

export function configFilePath(): string {
  const override = process.env.DOOMSCROLLER_CONFIG;
  if (override) return path.resolve(expandHome(override));
  return path.join(doomscrollerHome(), '.doomscroller.json');
}

export function stateDirectory(): string {
  return path.join(doomscrollerHome(), '.doomscroller');
}

export function defaultLogPath(): string {
  return path.join(stateDirectory(), 'doomscroller.log');
}

export function defaultSessionLogPath(): string {
  return path.join(stateDirectory(), 'sessions.jsonl');
}

export function claudeSettingsPath(): string {
  const base = process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(expandHome(process.env.CLAUDE_CONFIG_DIR))
    : path.join(os.homedir(), '.claude');
  return path.join(base, 'settings.json');
}

export function packageRoot(): string {
  // dist/util -> package root, or src/util -> package root.
  return path.resolve(__dirname, '..', '..');
}

export function scriptsDirectory(): string {
  return path.join(packageRoot(), 'scripts');
}

export function scriptPath(name: string): string {
  return path.join(scriptsDirectory(), name);
}

export function cliEntryPath(): string {
  const arg = process.argv[1];
  if (arg && /\.(?:[cm]?js|ts)$/i.test(arg)) return path.resolve(arg);
  return path.join(packageRoot(), 'dist', 'index.js');
}

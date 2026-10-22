import fs from 'node:fs';
import path from 'node:path';
import {
  BrowserChoice,
  DoomscrollerConfig,
  RegisteredAgent,
  WindowMatch,
} from './types';
import { errorMessage } from '../util/errors';
import {
  configFilePath,
  defaultLogPath,
  defaultSessionLogPath,
  expandHome,
} from '../util/paths';

const BROWSERS: BrowserChoice[] = ['auto', 'edge', 'chrome', 'brave', 'firefox', 'default'];
const ADAPTERS = ['hotkey', 'hook', 'cli-wrapper', 'ide-activity'] as const;

export function defaultConfig(): DoomscrollerConfig {
  return {
    targets: [
      'https://www.instagram.com/',
      'https://x.com/',
      'https://www.youtube.com/shorts',
    ],
    delaySeconds: 10,
    quietSeconds: 15,
    maxDoomscrollSeconds: 600,
    hotkey: 'Ctrl+Alt+D',
    sound: true,
    browser: 'auto',
    port: 45871,
    idleCpuPercent: 5,
    registeredAgents: [
      {
        name: 'Antigravity',
        adapter: 'ide-activity',
        match: { process: 'antigravity' },
      },
    ],
    logPath: defaultLogPath(),
    sessionLogPath: defaultSessionLogPath(),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberOr(value: unknown, fallback: number, minimum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) return fallback;
  return value;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function parseMatch(value: unknown): WindowMatch | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const match: WindowMatch = {};
  if (typeof record.title === 'string' && record.title.trim() !== '') {
    match.title = record.title.trim();
  }
  if (typeof record.process === 'string' && record.process.trim() !== '') {
    match.process = record.process.trim();
  }
  return match.title || match.process ? match : undefined;
}

function parseAgents(value: unknown, fallback: RegisteredAgent[]): RegisteredAgent[] {
  if (!Array.isArray(value)) return fallback;
  const agents: RegisteredAgent[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const name = stringOr(record.name, '').trim();
    const adapter = record.adapter;
    if (!name) continue;
    if (typeof adapter !== 'string' || !(ADAPTERS as readonly string[]).includes(adapter)) continue;
    const agent: RegisteredAgent = {
      name,
      adapter: adapter as RegisteredAgent['adapter'],
    };
    const match = parseMatch(record.match);
    if (match) agent.match = match;
    if (typeof record.workspace === 'string' && record.workspace.trim() !== '') {
      agent.workspace = expandHome(record.workspace.trim());
    }
    if (typeof record.quietSeconds === 'number' && Number.isFinite(record.quietSeconds) && record.quietSeconds > 0) {
      agent.quietSeconds = record.quietSeconds;
    }
    agents.push(agent);
  }
  return agents;
}

export function mergeConfig(base: DoomscrollerConfig, raw: unknown): DoomscrollerConfig {
  const record = asRecord(raw);
  if (!record) return base;

  const targets = Array.isArray(record.targets)
    ? record.targets.filter((target): target is string => typeof target === 'string' && target.trim() !== '')
    : [];

  const browser = BROWSERS.includes(record.browser as BrowserChoice)
    ? (record.browser as BrowserChoice)
    : base.browser;

  return {
    targets: targets.length > 0 ? targets : base.targets,
    delaySeconds: numberOr(record.delaySeconds, base.delaySeconds, 0),
    quietSeconds: numberOr(record.quietSeconds, base.quietSeconds, 1),
    maxDoomscrollSeconds: numberOr(record.maxDoomscrollSeconds, base.maxDoomscrollSeconds, 0),
    hotkey:
      record.hotkey === null
        ? null
        : typeof record.hotkey === 'string' && record.hotkey.trim() !== ''
          ? record.hotkey.trim()
          : base.hotkey,
    sound: booleanOr(record.sound, base.sound),
    browser,
    port: Math.min(65535, Math.max(1, Math.round(numberOr(record.port, base.port, 1)))),
    idleCpuPercent: numberOr(record.idleCpuPercent, base.idleCpuPercent, 0),
    registeredAgents: parseAgents(record.registeredAgents, base.registeredAgents),
    logPath:
      typeof record.logPath === 'string' && record.logPath.trim() !== ''
        ? path.resolve(expandHome(record.logPath.trim()))
        : base.logPath,
    sessionLogPath:
      typeof record.sessionLogPath === 'string' && record.sessionLogPath.trim() !== ''
        ? path.resolve(expandHome(record.sessionLogPath.trim()))
        : base.sessionLogPath,
  };
}

export interface LoadedConfig {
  config: DoomscrollerConfig;
  path: string;
  exists: boolean;
  error?: string;
}

export function loadConfig(filePath: string = configFilePath()): LoadedConfig {
  const base = defaultConfig();
  try {
    const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return {
        config: base,
        path: filePath,
        exists: true,
        error: `Invalid JSON in ${filePath}: ${errorMessage(error)}`,
      };
    }
    return { config: mergeConfig(base, raw), path: filePath, exists: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { config: base, path: filePath, exists: false };
    return {
      config: base,
      path: filePath,
      exists: false,
      error: `Could not read ${filePath}: ${errorMessage(error)}`,
    };
  }
}

export function defaultConfigFileContents(): string {
  const config = defaultConfig();
  return `${JSON.stringify(
    {
      targets: config.targets,
      delaySeconds: config.delaySeconds,
      quietSeconds: config.quietSeconds,
      maxDoomscrollSeconds: config.maxDoomscrollSeconds,
      hotkey: config.hotkey,
      sound: config.sound,
      browser: config.browser,
      port: config.port,
      idleCpuPercent: config.idleCpuPercent,
      registeredAgents: config.registeredAgents,
    },
    null,
    2,
  )}\n`;
}

export function writeDefaultConfig(filePath: string = configFilePath()): { created: boolean; path: string } {
  try {
    fs.accessSync(filePath);
    return { created: false, path: filePath };
  } catch {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, defaultConfigFileContents(), 'utf8');
    return { created: true, path: filePath };
  }
}

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, loadConfig, mergeConfig, writeDefaultConfig } from '../src/core/config';
import { installClaudeCodeHooks, mergeClaudeHooks } from '../src/adapters/claude-code-hooks';
import { aggregateByDay, formatDuration, readSessions, SessionLogger } from '../src/core/stats';
import { SessionRecord } from '../src/core/types';
import { VERSION } from '../src/cli';

const tempDirectories: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'doomscroller-test-'));
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  // Windows can briefly hold handles; failures here are harmless.
  for (const directory of tempDirectories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('config', () => {
  it('keeps the CLI version in sync with package.json', () => {
    const pkg = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as { version?: string };
    expect(VERSION).toBe(pkg.version);
  });

  it('provides the documented defaults', () => {
    const config = defaultConfig();
    expect(config.delaySeconds).toBe(10);
    expect(config.quietSeconds).toBeGreaterThan(0);
    expect(config.maxDoomscrollSeconds).toBeGreaterThan(0);
    expect(config.hotkey).toBe('Ctrl+Alt+D');
    expect(config.targets).toEqual([
      'https://www.instagram.com/',
      'https://x.com/',
      'https://www.youtube.com/shorts',
    ]);
    expect(config.registeredAgents[0].adapter).toBe('ide-activity');
  });

  it('merges valid values and ignores invalid ones', () => {
    const merged = mergeConfig(defaultConfig(), {
      delaySeconds: 3,
      quietSeconds: -1,
      maxDoomscrollSeconds: 'nope',
      targets: ['https://example.com'],
      hotkey: null,
      port: 99999,
      browser: 'netscape',
      registeredAgents: [
        { name: 'Antigravity', adapter: 'ide-activity', match: { process: 'Antigravity.exe' } },
        { name: 'Broken', adapter: 'unknown' },
      ],
    });

    expect(merged.delaySeconds).toBe(3);
    expect(merged.quietSeconds).toBe(defaultConfig().quietSeconds);
    expect(merged.maxDoomscrollSeconds).toBe(defaultConfig().maxDoomscrollSeconds);
    expect(merged.targets).toEqual(['https://example.com']);
    expect(merged.hotkey).toBeNull();
    expect(merged.port).toBe(65535);
    expect(merged.browser).toBe('auto');
    expect(merged.registeredAgents).toHaveLength(1);
    expect(merged.registeredAgents[0].match?.process).toBe('Antigravity.exe');
  });

  it('loads a file and reports invalid JSON without throwing', () => {
    const directory = tempDir();
    const goodPath = path.join(directory, 'good.json');
    writeFileSync(goodPath, JSON.stringify({ delaySeconds: 2 }), 'utf8');
    expect(loadConfig(goodPath).config.delaySeconds).toBe(2);

    const bomPath = path.join(directory, 'bom.json');
    writeFileSync(bomPath, `\uFEFF${JSON.stringify({ delaySeconds: 4 })}`, 'utf8');
    expect(loadConfig(bomPath).config.delaySeconds).toBe(4);

    const badPath = path.join(directory, 'bad.json');
    writeFileSync(badPath, '{ not json', 'utf8');
    const loaded = loadConfig(badPath);
    expect(loaded.error).toBeTruthy();
    expect(loaded.config.delaySeconds).toBe(10);
  });

  it('writes a default config once', () => {
    const filePath = path.join(tempDir(), '.doomscroller.json');
    expect(writeDefaultConfig(filePath).created).toBe(true);
    expect(writeDefaultConfig(filePath).created).toBe(false);
    const contents = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(contents.delaySeconds).toBe(10);
    expect(contents.hotkey).toBe('Ctrl+Alt+D');
  });
});

describe('claude code hooks', () => {
  it('preserves existing hooks and adds doomscroller hooks', () => {
    const settings = {
      theme: 'dark',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'echo existing' }] }],
      },
    };
    const commands = {
      UserPromptSubmit: '"node.exe" "C:\\doomscroller\\dist\\index.js" start',
      Stop: '"node.exe" "C:\\doomscroller\\dist\\index.js" done',
      Notification: '"node.exe" "C:\\doomscroller\\dist\\index.js" done',
    };

    const merged = mergeClaudeHooks(settings, commands);
    expect(merged.error).toBeUndefined();
    expect(merged.added).toEqual(['UserPromptSubmit', 'Stop', 'Notification']);
    expect(merged.settings.theme).toBe('dark');

    const hooks = merged.settings.hooks as Record<string, unknown[]>;
    expect(hooks.Stop).toHaveLength(2);
    expect(JSON.stringify(hooks.Stop[0])).toContain('echo existing');

    const again = mergeClaudeHooks(merged.settings, commands);
    expect(again.added).toEqual([]);
    expect(again.existing).toEqual(['UserPromptSubmit', 'Stop', 'Notification']);
  });

  it('refuses to overwrite an existing non-array hook event', () => {
    const result = mergeClaudeHooks(
      { hooks: { Stop: 'not-an-array' } },
      { UserPromptSubmit: 'x start', Stop: 'x done', Notification: 'x done' },
    );
    expect(result.error).toContain('not an array');
  });

  it('installs into a settings file and creates a backup', async () => {
    const settingsPath = path.join(tempDir(), 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep me' }] }] } }),
      'utf8',
    );

    const result = await installClaudeCodeHooks(settingsPath);
    expect(result.error).toBeUndefined();
    expect(result.changed).toBe(true);
    expect(result.added).toContain('UserPromptSubmit');

    const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(saved.hooks.UserPromptSubmit).toHaveLength(1);
    expect(saved.hooks.Stop).toHaveLength(2);
    expect(readFileSync(`${settingsPath}.doomscroller.bak`, 'utf8')).toContain('keep me');

    const second = await installClaudeCodeHooks(settingsPath);
    expect(second.changed).toBe(false);
  });

  it('does not overwrite invalid settings JSON', async () => {
    const settingsPath = path.join(tempDir(), 'settings.json');
    writeFileSync(settingsPath, '{ invalid', 'utf8');
    const result = await installClaudeCodeHooks(settingsPath);
    expect(result.error).toBeTruthy();
    expect(readFileSync(settingsPath, 'utf8')).toBe('{ invalid');
  });

  it('reads settings written with a UTF-8 BOM', async () => {
    const settingsPath = path.join(tempDir(), 'settings.json');
    writeFileSync(settingsPath, `\uFEFF${JSON.stringify({ theme: 'dark' })}`, 'utf8');
    const result = await installClaudeCodeHooks(settingsPath);
    expect(result.error).toBeUndefined();
    expect(result.changed).toBe(true);
  });
});

function session(finishedAt: Date, doomscrollMs: number, durationMs = doomscrollMs): SessionRecord {
  return {
    type: 'session',
    startedAt: new Date(finishedAt.getTime() - durationMs).toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    doomscrollMs,
    target: 'https://x.com/',
    end: 'finished',
  };
}

describe('stats', () => {
  it('writes and reads JSONL sessions, skipping corrupt lines', () => {
    const filePath = path.join(tempDir(), 'sessions.jsonl');
    const logger = new SessionLogger(filePath);
    logger.record(session(new Date(2026, 9, 21, 10), 60_000));
    writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}{ broken\n`, 'utf8');
    logger.record(session(new Date(2026, 9, 21, 11), 30_000));

    const records = readSessions(filePath);
    expect(records).toHaveLength(2);
  });

  it('aggregates wait time per day', () => {
    const now = new Date(2026, 9, 22, 12, 0, 0);
    const records = [
      session(new Date(2026, 9, 21, 10), 60_000),
      session(new Date(2026, 9, 21, 15), 30_000),
      session(new Date(2026, 9, 22, 9), 120_000),
      session(new Date(2026, 8, 1, 9), 999_000),
    ];

    const twoDays = aggregateByDay(records, { days: 2, now });
    expect(twoDays.map((row) => row.date)).toEqual(['2026-10-21', '2026-10-22']);
    expect(twoDays[0].sessions).toBe(2);
    expect(twoDays[0].doomscrollMs).toBe(90_000);
    expect(twoDays[1].doomscrollMs).toBe(120_000);

    const oneDay = aggregateByDay(records, { days: 1, now });
    expect(oneDay).toHaveLength(1);
    expect(oneDay[0].date).toBe('2026-10-22');

    const allTime = aggregateByDay(records, { days: null, now });
    expect(allTime).toHaveLength(3);
  });

  it('formats durations for humans', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(3_661_000)).toBe('1h 1m 1s');
  });
});

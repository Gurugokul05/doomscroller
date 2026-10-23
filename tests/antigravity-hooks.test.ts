import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HOOK_NAME,
  LEGACY_HOOK_NAME,
  buildHookCommand,
  commandTargetsAction,
  hookCommands,
  installAntigravityHooks,
  mergeAntigravityHooks,
  planAntigravityHooks,
  wrapperFileName,
} from '../src/adapters/antigravity-hooks';
import { antigravityHooksPath, cliEntryPath } from '../src/util/paths';

const tempDirectories: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'doomscroller-antigravity-'));
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const CLI = 'C:\\doomscroller\\dist\\index.js';
const CLI_SPACED = 'C:\\Program Files\\doomscroller\\dist\\index.js';

/** What the current code generates. */
const NEW = {
  PreInvocation: `node ${CLI} antigravity-hook start`,
  Stop: `node ${CLI} antigravity-hook done`,
};

/** What it generates when the CLI path has spaces. */
const NEW_SPACED = {
  PreInvocation: `node "${CLI_SPACED}" antigravity-hook start`,
  Stop: `node "${CLI_SPACED}" antigravity-hook done`,
};

/** The first release form; Antigravity refuses to execute it. */
const OLD_QUOTED = {
  PreInvocation: `"${NODE}" "${CLI}" antigravity-hook start`,
  Stop: `"${NODE}" "${CLI}" antigravity-hook done`,
};

/** The 0.3.0 form; Antigravity captures the `& ...` text instead of running it. */
const OLD_WRAPPED = {
  PreInvocation: `powershell.exe -NoProfile -Command "& '${NODE}' '${CLI}' antigravity-hook start"`,
  Stop: `powershell.exe -NoProfile -Command "& '${NODE}' '${CLI}' antigravity-hook done"`,
};

describe('buildHookCommand', () => {
  it('emits the bare form when nothing needs quoting', () => {
    expect(buildHookCommand({ action: 'start', cliPath: CLI })).toBe(
      'node C:\\doomscroller\\dist\\index.js antigravity-hook start',
    );
  });

  it('quotes only the CLI path when it contains spaces', () => {
    expect(buildHookCommand({ action: 'done', cliPath: CLI_SPACED })).toBe(
      'node "C:\\Program Files\\doomscroller\\dist\\index.js" antigravity-hook done',
    );
  });

  it('never starts with a quote and never emits a -Command wrapper', () => {
    for (const cliPath of [CLI, CLI_SPACED]) {
      for (const action of ['start', 'done'] as const) {
        const command = buildHookCommand({ action, cliPath });
        expect(command.startsWith('node ')).toBe(true);
        expect(command.startsWith('"')).toBe(false);
        expect(command).not.toContain('-Command');
        expect(command).not.toContain('& ');
        expect(command).toContain(`antigravity-hook ${action}`);
      }
    }
  });

  it('never generates a leading-quote command from hookCommands', () => {
    for (const command of Object.values(hookCommands())) {
      expect(command.startsWith('"')).toBe(false);
      expect(command).toContain('antigravity-hook');
    }
  });
});

describe('planAntigravityHooks', () => {
  it('uses the bare form and no wrappers when node is on PATH', () => {
    const planned = planAntigravityHooks({ nodeOnPath: true, cliPath: CLI });
    expect(planned.error).toBeUndefined();
    expect(planned.wrappers).toEqual([]);
    expect(planned.commands).toEqual(NEW);
  });

  it('generates a wrapper per action when node is not on PATH', () => {
    const directory = tempDir();
    const planned = planAntigravityHooks({
      nodeOnPath: false,
      nodePath: NODE,
      cliPath: CLI,
      wrapperDirectory: directory,
    });
    expect(planned.error).toBeUndefined();
    expect(planned.commands.PreInvocation).toBe(path.join(directory, wrapperFileName('start')));
    expect(planned.commands.Stop).toBe(path.join(directory, wrapperFileName('done')));
    expect(planned.wrappers).toHaveLength(2);
    expect(planned.wrappers[0].contents).toContain(NODE);
    expect(planned.wrappers[0].contents).toContain('antigravity-hook start');
  });

  it('errors instead of generating an unexecutable wrapper path', () => {
    const planned = planAntigravityHooks({
      nodeOnPath: false,
      nodePath: NODE,
      cliPath: CLI,
      wrapperDirectory: path.join(tempDir(), 'with space'),
    });
    expect(planned.error).toBeTruthy();
    expect(planned.commands).toEqual({});
    expect(planned.wrappers).toEqual([]);
  });
});

describe('commandTargetsAction', () => {
  it('recognises every form we have shipped, plus wrappers', () => {
    expect(commandTargetsAction(NEW.PreInvocation, 'start')).toBe(true);
    expect(commandTargetsAction(NEW.Stop, 'done')).toBe(true);
    expect(commandTargetsAction(OLD_QUOTED.PreInvocation, 'start')).toBe(true);
    expect(commandTargetsAction(OLD_WRAPPED.Stop, 'done')).toBe(true);
    expect(commandTargetsAction('C:\\x\\.doomscroller\\antigravity-hook-start.cmd', 'start')).toBe(
      true,
    );
    // A handler for the other action is not ours.
    expect(commandTargetsAction(NEW.Stop, 'start')).toBe(false);
  });
});

describe('mergeAntigravityHooks', () => {
  it('adds the doomscroller hook group and preserves other keys', () => {
    const file = {
      'my-linter': {
        PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './lint.sh' }] }],
      },
      unrelated: 'keep me',
    };

    const merged = mergeAntigravityHooks(file, NEW);
    expect(merged.error).toBeUndefined();
    expect(merged.added).toEqual(['PreInvocation', 'Stop']);
    expect(merged.legacyGroup).toBe(false);
    expect(merged.hooks.unrelated).toBe('keep me');
    expect(merged.hooks['my-linter']).toEqual(file['my-linter']);

    const group = merged.hooks[HOOK_NAME] as Record<string, unknown[]>;
    // PreInvocation and Stop take a flat handler list. Only PreToolUse and
    // PostToolUse use the nested {matcher, hooks: [...]} shape.
    expect(group.PreInvocation).toEqual([
      { type: 'command', command: NEW.PreInvocation, timeout: 5 },
    ]);
    expect(group.Stop).toEqual([{ type: 'command', command: NEW.Stop, timeout: 5 }]);
  });

  it('flags but never touches a legacy doomscroll group or other top-level keys', () => {
    const legacy = {
      Stop: [
        {
          type: 'command',
          command:
            'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\x\\antigravity-done.ps1"',
        },
      ],
    };
    const merged = mergeAntigravityHooks({ doomscroll: legacy, theme: 'dark' }, NEW);
    expect(merged.legacyGroup).toBe(true);
    expect(merged.hooks[LEGACY_HOOK_NAME]).toEqual(legacy);
    expect(merged.hooks.theme).toBe('dark');
  });

  it('preserves handlers it does not own inside the doomscroller group', () => {
    const file = { [HOOK_NAME]: { Stop: [{ type: 'command', command: './other.sh' }] } };
    const merged = mergeAntigravityHooks(file, NEW);
    const group = merged.hooks[HOOK_NAME] as Record<string, unknown[]>;
    expect(group.Stop).toHaveLength(2);
    expect(JSON.stringify(group.Stop[0])).toContain('./other.sh');
  });

  it('upgrades the old quoted-path commands in place', () => {
    const file = {
      [HOOK_NAME]: {
        PreInvocation: [{ type: 'command', command: OLD_QUOTED.PreInvocation }],
        Stop: [{ type: 'command', command: OLD_QUOTED.Stop }],
      },
    };

    const merged = mergeAntigravityHooks(file, NEW);
    expect(merged.error).toBeUndefined();
    expect(merged.added).toEqual(['PreInvocation', 'Stop']);

    const group = merged.hooks[HOOK_NAME] as Record<string, Array<{ command: string }>>;
    expect(group.PreInvocation).toHaveLength(1);
    expect(group.Stop).toHaveLength(1);
    expect(group.PreInvocation[0].command).toBe(NEW.PreInvocation);
    expect(group.Stop[0].command).toBe(NEW.Stop);
  });

  it('upgrades the removed PowerShell -Command "& ..." commands in place', () => {
    const file = {
      [HOOK_NAME]: {
        PreInvocation: [{ type: 'command', command: OLD_WRAPPED.PreInvocation }],
        Stop: [{ type: 'command', command: OLD_WRAPPED.Stop }],
      },
    };

    const merged = mergeAntigravityHooks(file, NEW);
    expect(merged.added).toEqual(['PreInvocation', 'Stop']);

    const group = merged.hooks[HOOK_NAME] as Record<string, Array<{ command: string }>>;
    expect(group.PreInvocation[0].command).toBe(NEW.PreInvocation);
    expect(group.Stop[0].command).toBe(NEW.Stop);
    expect(group.PreInvocation[0].command).not.toContain('-Command');
  });

  it('collapses duplicated doomscroller handlers instead of stacking them', () => {
    const file = {
      [HOOK_NAME]: {
        Stop: [
          { type: 'command', command: OLD_WRAPPED.Stop },
          { type: 'command', command: NEW.Stop },
        ],
      },
    };
    const merged = mergeAntigravityHooks(file, { Stop: NEW.Stop });
    const group = merged.hooks[HOOK_NAME] as Record<string, unknown[]>;
    expect(group.Stop).toHaveLength(1);
    expect(merged.added).toEqual(['Stop']);
  });

  it('is a no-op when the new form is already installed', () => {
    const first = mergeAntigravityHooks({}, NEW);
    const again = mergeAntigravityHooks(first.hooks, NEW);
    expect(again.added).toEqual([]);
    expect(again.existing).toEqual(['PreInvocation', 'Stop']);
  });

  it('is a no-op when the spaced form is already installed', () => {
    const first = mergeAntigravityHooks({}, NEW_SPACED);
    const again = mergeAntigravityHooks(first.hooks, NEW_SPACED);
    expect(again.added).toEqual([]);
    expect(again.existing).toEqual(['PreInvocation', 'Stop']);
  });

  it('refuses to overwrite a non-object hook group', () => {
    const result = mergeAntigravityHooks({ [HOOK_NAME]: 'nope' }, NEW);
    expect(result.error).toContain('not an object');
  });

  it('refuses to overwrite an existing non-array event', () => {
    const result = mergeAntigravityHooks({ [HOOK_NAME]: { Stop: 'nope' } }, NEW);
    expect(result.error).toContain('not an array');
  });
});

describe('installAntigravityHooks', () => {
  it('installs the bare form, backs up, and writes no BOM', () => {
    const hooksPath = path.join(tempDir(), 'hooks.json');
    writeFileSync(
      hooksPath,
      JSON.stringify({ keep: { Stop: [{ type: 'command', command: 'existing' }] } }),
      'utf8',
    );

    const result = installAntigravityHooks(hooksPath, true);
    expect(result.error).toBeUndefined();
    expect(result.changed).toBe(true);
    expect(result.added).toEqual(['PreInvocation', 'Stop']);

    // Antigravity parses hooks.json with Go's JSON decoder. A leading UTF-8 BOM
    // makes it fail with "invalid character '\ufeff'" and then silently load
    // zero hooks, so the file must start with '{'.
    expect(readFileSync(hooksPath)[0]).toBe(0x7b);

    const saved = JSON.parse(readFileSync(hooksPath, 'utf8'));
    expect(saved.keep).toBeTruthy();
    expect(saved[HOOK_NAME].PreInvocation).toHaveLength(1);
    expect(saved[HOOK_NAME].PreInvocation[0].command.startsWith('"')).toBe(false);
    expect(saved[HOOK_NAME].PreInvocation[0].command).toContain('antigravity-hook start');
    expect(readFileSync(`${hooksPath}.doomscroller.bak`, 'utf8')).toContain('existing');

    expect(installAntigravityHooks(hooksPath, true).changed).toBe(false);
  });

  it('upgrades an existing quoted-path install and backs the file up', () => {
    const hooksPath = path.join(tempDir(), 'hooks.json');
    const original = JSON.stringify({
      [HOOK_NAME]: {
        PreInvocation: [{ type: 'command', command: OLD_QUOTED.PreInvocation }],
        Stop: [{ type: 'command', command: OLD_QUOTED.Stop }],
      },
      doomscroll: { Stop: [{ type: 'command', command: 'keep me' }] },
    });
    writeFileSync(hooksPath, original, 'utf8');

    const result = installAntigravityHooks(hooksPath, true);
    expect(result.error).toBeUndefined();
    expect(result.changed).toBe(true);
    expect(result.legacyGroup).toBe(true);
    expect(readFileSync(hooksPath)[0]).toBe(0x7b);

    const saved = JSON.parse(readFileSync(hooksPath, 'utf8'));
    expect(saved.doomscroll).toEqual({ Stop: [{ type: 'command', command: 'keep me' }] });
    expect(saved[HOOK_NAME].PreInvocation).toHaveLength(1);
    expect(saved[HOOK_NAME].PreInvocation[0].command.startsWith('"')).toBe(false);
    expect(saved[HOOK_NAME].PreInvocation[0].command).toContain('antigravity-hook start');
    expect(saved[HOOK_NAME].Stop[0].command).toContain('antigravity-hook done');

    expect(readFileSync(`${hooksPath}.doomscroller.bak`, 'utf8')).toBe(original);
    expect(installAntigravityHooks(hooksPath, true).changed).toBe(false);
  });

  it('upgrades an existing -Command-wrapped install in place', () => {
    const hooksPath = path.join(tempDir(), 'hooks.json');
    writeFileSync(
      hooksPath,
      JSON.stringify({
        [HOOK_NAME]: {
          PreInvocation: [{ type: 'command', command: OLD_WRAPPED.PreInvocation }],
          Stop: [{ type: 'command', command: OLD_WRAPPED.Stop }],
        },
      }),
      'utf8',
    );

    const result = installAntigravityHooks(hooksPath, true);
    expect(result.changed).toBe(true);
    const saved = JSON.parse(readFileSync(hooksPath, 'utf8'));
    // The canonical command embeds the running CLI's own entry path.
    const expected = buildHookCommand({ action: 'start', cliPath: cliEntryPath() });
    expect(saved[HOOK_NAME].PreInvocation[0].command).toBe(expected);
    expect(saved[HOOK_NAME].PreInvocation[0].command).not.toContain('-Command');
    expect(installAntigravityHooks(hooksPath, true).changed).toBe(false);
  });

  it('writes wrapper scripts and points the hooks at them when node is off PATH', () => {
    const home = tempDir();
    const original = process.env.DOOMSCROLLER_HOME;
    process.env.DOOMSCROLLER_HOME = home;
    try {
      const hooksPath = path.join(tempDir(), 'hooks.json');
      const result = installAntigravityHooks(hooksPath, false);
      expect(result.error).toBeUndefined();
      expect(result.changed).toBe(true);

      const saved = JSON.parse(readFileSync(hooksPath, 'utf8'));
      const command: string = saved[HOOK_NAME].PreInvocation[0].command;
      expect(command).toBe(path.join(home, '.doomscroller', wrapperFileName('start')));
      expect(existsSync(command)).toBe(true);
      const contents = readFileSync(command, 'utf8');
      expect(contents).toContain('antigravity-hook start');
      expect(contents).toContain(process.execPath);

      expect(installAntigravityHooks(hooksPath, false).changed).toBe(false);
    } finally {
      if (original === undefined) delete process.env.DOOMSCROLLER_HOME;
      else process.env.DOOMSCROLLER_HOME = original;
    }
  });

  it('refuses to write any command when a wrapper path cannot be expressed', () => {
    const original = process.env.DOOMSCROLLER_HOME;
    process.env.DOOMSCROLLER_HOME = path.join(tempDir(), 'with space');
    try {
      const hooksPath = path.join(tempDir(), 'hooks.json');
      const result = installAntigravityHooks(hooksPath, false);
      expect(result.error).toBeTruthy();
      expect(result.changed).toBe(false);
      expect(existsSync(hooksPath)).toBe(false);
    } finally {
      if (original === undefined) delete process.env.DOOMSCROLLER_HOME;
      else process.env.DOOMSCROLLER_HOME = original;
    }
  });

  it('does not overwrite invalid hooks JSON', () => {
    const hooksPath = path.join(tempDir(), 'hooks.json');
    writeFileSync(hooksPath, '{ invalid', 'utf8');
    const result = installAntigravityHooks(hooksPath, true);
    expect(result.error).toBeTruthy();
    expect(readFileSync(hooksPath, 'utf8')).toBe('{ invalid');
  });

  it('reads a BOM-prefixed hooks.json and rewrites it without a BOM', () => {
    const hooksPath = path.join(tempDir(), 'hooks.json');
    writeFileSync(hooksPath, `\uFEFF${JSON.stringify({ keep: { Stop: [] } })}`, 'utf8');

    const result = installAntigravityHooks(hooksPath, true);
    expect(result.error).toBeUndefined();
    expect(result.changed).toBe(true);
    expect(readFileSync(hooksPath)[0]).toBe(0x7b);
    expect(JSON.parse(readFileSync(hooksPath, 'utf8')).keep).toEqual({ Stop: [] });
  });

  it('resolves the hooks path from the environment', () => {
    const original = process.env.ANTIGRAVITY_CONFIG_DIR;
    try {
      const directory = tempDir();
      process.env.ANTIGRAVITY_CONFIG_DIR = directory;
      expect(antigravityHooksPath()).toBe(path.join(directory, 'hooks.json'));
    } finally {
      if (original === undefined) delete process.env.ANTIGRAVITY_CONFIG_DIR;
      else process.env.ANTIGRAVITY_CONFIG_DIR = original;
    }
  });
});

/** Writes a tiny Node "CLI" that records the argv it was reached with. */
function writeFakeCli(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const cliPath = path.join(directory, 'fake-cli.js');
  writeFileSync(
    cliPath,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const home = process.env.DOOMSCROLLER_HOME || '.';",
      "  const marker = path.join(home, 'fake-cli.log');",
      "  fs.mkdirSync(path.dirname(marker), { recursive: true });",
      "  fs.appendFileSync(marker, JSON.stringify({ argv: process.argv.slice(2), stdin: input }) + '\\n');",
      "  process.stdout.write('{}\\n');",
      '});',
    ].join('\n'),
    'utf8',
  );
  return cliPath;
}

describe('generated command executes', () => {
  it('is accepted by the shell and reaches the CLI with the action and stdin', () => {
    const home = tempDir();
    const command = buildHookCommand({ action: 'start', cliPath: writeFakeCli(home) });

    const result = spawnSync(command, {
      shell: true,
      input: '{"fullyIdle":true}',
      encoding: 'utf8',
      env: { ...process.env, DOOMSCROLLER_HOME: home },
      timeout: 20000,
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(String(result.stdout).trim())).toEqual({});
    const marker = JSON.parse(readFileSync(path.join(home, 'fake-cli.log'), 'utf8').trim());
    expect(marker.argv).toEqual(['antigravity-hook', 'start']);
    expect(marker.stdin).toContain('fullyIdle');
  });

  it('runs even when the CLI path contains spaces', () => {
    const home = tempDir();
    const command = buildHookCommand({ action: 'done', cliPath: writeFakeCli(path.join(home, 'program files')) });
    expect(command).toContain('"');

    const result = spawnSync(command, {
      shell: true,
      input: '{"fullyIdle":false}',
      encoding: 'utf8',
      env: { ...process.env, DOOMSCROLLER_HOME: home },
      timeout: 20000,
    });

    expect(result.status).toBe(0);
    const marker = JSON.parse(readFileSync(path.join(home, 'fake-cli.log'), 'utf8').trim());
    expect(marker.argv).toEqual(['antigravity-hook', 'done']);
  });

  const realCli = path.resolve(process.cwd(), 'dist', 'index.js');

  it.skipIf(!existsSync(realCli))(
    'runs against the real CLI and prints parseable JSON',
    async () => {
      const home = tempDir();
      const configPath = path.join(home, '.doomscroller.json');
      // `done` with fullyIdle=false is suppressed, so the real CLI never touches
      // the daemon and the test stays hermetic.
      writeFileSync(configPath, JSON.stringify({ port: 45879, registeredAgents: [], hotkey: null }), 'utf8');

      const command = buildHookCommand({ action: 'done', cliPath: realCli });
      const child = spawn(command, {
        shell: true,
        env: { ...process.env, DOOMSCROLLER_HOME: home, DOOMSCROLLER_CONFIG: configPath },
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stdin.end('{"fullyIdle":false}');
      const code = await new Promise<number>((resolve) => {
        child.on('close', (value) => resolve(value ?? -1));
      });

      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({});

      const logPath = path.join(home, '.doomscroller', 'antigravity-hooks.log');
      expect(existsSync(logPath)).toBe(true);
      expect(readFileSync(logPath, 'utf8')).toContain('suppressed because fullyIdle=false');
    },
  );
});

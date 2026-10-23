import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HOOK_NAME,
  buildHookCommand,
  hookCommands,
  installAntigravityHooks,
  mergeAntigravityHooks,
} from '../src/adapters/antigravity-hooks';
import { antigravityHooksPath } from '../src/util/paths';

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

const BARE = {
  PreInvocation: 'node C:\\doomscroller\\dist\\index.js antigravity-hook start',
  Stop: 'node C:\\doomscroller\\dist\\index.js antigravity-hook done',
};

const WRAPPED = {
  PreInvocation:
    'powershell.exe -NoProfile -Command "& \'C:\\Program Files\\nodejs\\node.exe\' ' +
    '\'C:\\doomscroller\\dist\\index.js\' antigravity-hook start"',
  Stop:
    'powershell.exe -NoProfile -Command "& \'C:\\Program Files\\nodejs\\node.exe\' ' +
    '\'C:\\doomscroller\\dist\\index.js\' antigravity-hook done"',
};

/** The form the first release wrote; Antigravity refuses to execute it. */
const OLD_QUOTED = {
  PreInvocation:
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\doomscroller\\dist\\index.js" antigravity-hook start',
  Stop:
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\doomscroller\\dist\\index.js" antigravity-hook done',
};

describe('buildHookCommand', () => {
  it('emits the bare form when node is on PATH and nothing needs quoting', () => {
    expect(
      buildHookCommand({
        action: 'start',
        nodePath: 'C:\\nodejs\\node.exe',
        cliPath: 'C:\\doomscroller\\dist\\index.js',
        nodeOnPath: true,
      }),
    ).toBe('node C:\\doomscroller\\dist\\index.js antigravity-hook start');
  });

  it('wraps in PowerShell when the node path contains a space', () => {
    expect(
      buildHookCommand({
        action: 'done',
        nodePath: 'C:\\Program Files\\nodejs\\node.exe',
        cliPath: 'C:\\doomscroller\\dist\\index.js',
        nodeOnPath: true,
      }),
    ).toBe(
      'powershell.exe -NoProfile -Command "& \'C:\\Program Files\\nodejs\\node.exe\' ' +
        '\'C:\\doomscroller\\dist\\index.js\' antigravity-hook done"',
    );
  });

  it('wraps in PowerShell when the CLI path contains a space', () => {
    const command = buildHookCommand({
      action: 'start',
      nodePath: 'C:\\nodejs\\node.exe',
      cliPath: 'C:\\Program Files\\doomscroller\\dist\\index.js',
      nodeOnPath: true,
    });
    expect(command).toContain("& 'C:\\nodejs\\node.exe'");
    expect(command).toContain("'C:\\Program Files\\doomscroller\\dist\\index.js'");
    expect(command.endsWith('antigravity-hook start"')).toBe(true);
  });

  it('wraps in PowerShell when node does not resolve from PATH', () => {
    const command = buildHookCommand({
      action: 'start',
      nodePath: 'C:\\nodejs\\node.exe',
      cliPath: 'C:\\doomscroller\\dist\\index.js',
      nodeOnPath: false,
    });
    expect(command.startsWith('powershell.exe -NoProfile -Command "& ')).toBe(true);
  });

  it('never generates a command that starts with a quote', () => {
    const pathPairs = [
      { nodePath: 'C:\\nodejs\\node.exe', cliPath: 'C:\\doomscroller\\dist\\index.js' },
      {
        nodePath: 'C:\\Program Files\\nodejs\\node.exe',
        cliPath: 'C:\\doomscroller\\dist\\index.js',
      },
      {
        nodePath: 'C:\\Program Files\\nodejs\\node.exe',
        cliPath: 'C:\\Program Files\\doomscroller\\dist\\index.js',
      },
    ];
    for (const paths of pathPairs) {
      for (const action of ['start', 'done'] as const) {
        for (const nodeOnPath of [true, false]) {
          const command = buildHookCommand({ action, ...paths, nodeOnPath });
          expect(command.startsWith('"')).toBe(false);
          expect(command).toContain(`antigravity-hook ${action}`);
        }
      }
    }
  });

  it('never generates a quoted-path command from hookCommands', () => {
    for (const command of Object.values(hookCommands())) {
      expect(command.startsWith('"')).toBe(false);
      expect(command).toContain('antigravity-hook');
    }
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

    const merged = mergeAntigravityHooks(file, WRAPPED);
    expect(merged.error).toBeUndefined();
    expect(merged.added).toEqual(['PreInvocation', 'Stop']);
    expect(merged.hooks.unrelated).toBe('keep me');
    expect(merged.hooks['my-linter']).toEqual(file['my-linter']);

    const group = merged.hooks[HOOK_NAME] as Record<string, unknown[]>;
    // PreInvocation and Stop take a flat handler list. Only PreToolUse and
    // PostToolUse use the nested {matcher, hooks: [...]} shape.
    expect(group.PreInvocation).toEqual([
      { type: 'command', command: WRAPPED.PreInvocation, timeout: 5 },
    ]);
    expect(group.Stop).toEqual([{ type: 'command', command: WRAPPED.Stop, timeout: 5 }]);
  });

  it('never touches a legacy doomscroll group or other top-level keys', () => {
    const legacy = {
      Stop: [
        {
          type: 'command',
          command:
            'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\x\\antigravity-done.ps1"',
        },
      ],
    };
    const merged = mergeAntigravityHooks({ doomscroll: legacy, theme: 'dark' }, WRAPPED);
    expect(merged.hooks.doomscroll).toEqual(legacy);
    expect(merged.hooks.theme).toBe('dark');
  });

  it('preserves handlers it does not own inside the doomscroller group', () => {
    const file = { [HOOK_NAME]: { Stop: [{ type: 'command', command: './other.sh' }] } };
    const merged = mergeAntigravityHooks(file, WRAPPED);
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

    const merged = mergeAntigravityHooks(file, WRAPPED);
    expect(merged.error).toBeUndefined();
    expect(merged.added).toEqual(['PreInvocation', 'Stop']);

    const group = merged.hooks[HOOK_NAME] as Record<string, Array<{ command: string }>>;
    expect(group.PreInvocation).toHaveLength(1);
    expect(group.Stop).toHaveLength(1);
    expect(group.PreInvocation[0].command).toBe(WRAPPED.PreInvocation);
    expect(group.Stop[0].command).toBe(WRAPPED.Stop);
  });

  it('collapses duplicated doomscroller handlers instead of stacking them', () => {
    const file = {
      [HOOK_NAME]: {
        Stop: [
          { type: 'command', command: OLD_QUOTED.Stop },
          { type: 'command', command: WRAPPED.Stop },
        ],
      },
    };
    const merged = mergeAntigravityHooks(file, { Stop: WRAPPED.Stop });
    const group = merged.hooks[HOOK_NAME] as Record<string, unknown[]>;
    expect(group.Stop).toHaveLength(1);
    expect(merged.added).toEqual(['Stop']);
  });

  it('is a no-op when the new form is already installed', () => {
    const first = mergeAntigravityHooks({}, WRAPPED);
    const again = mergeAntigravityHooks(first.hooks, WRAPPED);
    expect(again.added).toEqual([]);
    expect(again.existing).toEqual(['PreInvocation', 'Stop']);
  });

  it('needs no second handler when only the bare form was present', () => {
    const first = mergeAntigravityHooks({}, BARE);
    const again = mergeAntigravityHooks(first.hooks, BARE);
    expect(again.added).toEqual([]);
    expect(again.existing).toEqual(['PreInvocation', 'Stop']);
  });

  it('refuses to overwrite a non-object hook group', () => {
    const result = mergeAntigravityHooks({ [HOOK_NAME]: 'nope' }, WRAPPED);
    expect(result.error).toContain('not an object');
  });

  it('refuses to overwrite an existing non-array event', () => {
    const result = mergeAntigravityHooks({ [HOOK_NAME]: { Stop: 'nope' } }, WRAPPED);
    expect(result.error).toContain('not an array');
  });
});

describe('installAntigravityHooks', () => {
  it('installs into hooks.json, backs it up, and writes no BOM', () => {
    const hooksPath = path.join(tempDir(), 'hooks.json');
    writeFileSync(
      hooksPath,
      JSON.stringify({ keep: { Stop: [{ type: 'command', command: 'existing' }] } }),
      'utf8',
    );

    const result = installAntigravityHooks(hooksPath, false);
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
    expect(readFileSync(`${hooksPath}.doomscroller.bak`, 'utf8')).toContain('existing');

    expect(installAntigravityHooks(hooksPath, false).changed).toBe(false);
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

  it('does not overwrite invalid hooks JSON', () => {
    const hooksPath = path.join(tempDir(), 'hooks.json');
    writeFileSync(hooksPath, '{ invalid', 'utf8');
    const result = installAntigravityHooks(hooksPath, false);
    expect(result.error).toBeTruthy();
    expect(readFileSync(hooksPath, 'utf8')).toBe('{ invalid');
  });

  it('reads a BOM-prefixed hooks.json and rewrites it without a BOM', () => {
    const hooksPath = path.join(tempDir(), 'hooks.json');
    writeFileSync(hooksPath, `\uFEFF${JSON.stringify({ keep: { Stop: [] } })}`, 'utf8');

    const result = installAntigravityHooks(hooksPath, false);
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

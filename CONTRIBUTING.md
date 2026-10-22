# Contributing to doomscroller

Thanks for helping. Keep changes small, test the behavior you touch, and be
explicit about what is experimental.

## Development setup

Requirements:

- Windows 10/11 for the real window and hotkey tests (CI runs on
  `windows-latest`).
- Node.js 20 or 22. The CI matrix tests both. ESLint 10 in the dev dependencies
  needs a recent Node 20.x.
- Windows PowerShell 5.1 for the Win32 helpers.
- Visual Studio Build Tools with the C++ workload if `node-pty` has no prebuilt
  binary for your Node version.

```powershell
git clone https://github.com/Gurugokul05/doomscroller.git
cd doomscroller
npm install --include=dev
npm run build
```

`--include=dev` matters if your shell sets `NODE_ENV=production`; otherwise npm
skips the test and lint dependencies.

## Tests and checks

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

`npm test` runs Vitest. Tests are in `tests/`:

- `state-machine.test.ts` uses a mock `WindowController` and an injected
  scheduler/clock for the delay, cap, rotation, and force-return logic.
- `adapters.test.ts` covers the hotkey adapter, wrapper tracker, and Windows
  command resolution.
- `ide-activity.test.ts` covers window matching, CPU/file activity, quiet
  finish, and workspace scanning.
- `config-hooks-stats.test.ts` covers config validation, Claude Code hook
  merging, BOM handling, and stats aggregation.

Do not use real windows, browsers, or the user's profile in automated tests.
Inject a clock, scheduler, probe, or workspace scanner instead. `tests/helpers.ts`
has reusable fakes.

Manual checks for Win32 changes:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/win32-window.ps1 -Action get-foreground
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/win32-window.ps1 -Action find -ProcessName Code
```

The window minimize/focus commands affect real windows. Use a scratch window
that you own and close only that window when you are done.

The global hotkey must be tested with a real key press. Synthetic `SendKeys`
input does not reliably update `GetAsyncKeyState` in non-interactive sessions.

## Code style

- TypeScript, strict mode, CommonJS output. Keep the existing 2-space,
  single-quote, semicolon style.
- Prefer small, explicit types. Avoid `any` when a real type is available.
- Do not add runtime dependencies without discussing it in an issue first.
  Windows helpers should use PowerShell or Node built-ins where practical.
- Adapter and hook boundaries must never throw into the agent. Catch, log when
  a logger is available, and continue. The state machine and window operations
  are the exception: they are allowed to report failures upward so the state
  machine can log and recover.
- Comments should explain non-obvious behavior, not restate the code.
- Keep the browser minimized, not closed, when a session ends. Preserve the
  agent window handle for restore.

## Writing a new adapter

There is no single formal adapter base class. An adapter is a small component
that emits `agent:started` and `agent:finished` through `AgentControlPort`:

```ts
// src/adapters/ports.ts
export interface AgentControlPort {
  readonly state: CoreState;
  handle(event: AgentEvent): Promise<void>;
}
```

The state machine owns all window operations. An adapter should not call
`WindowController` directly unless it is implementing a platform controller.

A minimal, testable adapter:

```ts
// src/adapters/marker-file.ts
import { Logger } from '../core/logger';
import { AGENT_FINISHED, AGENT_STARTED } from '../core/types';
import { AgentControlPort } from './ports';

export interface MarkerFileProbe {
  exists(): Promise<boolean>;
}

export interface MarkerFileAdapterDeps {
  machine: AgentControlPort;
  probe: MarkerFileProbe;
  logger: Logger;
}

export class MarkerFileAdapter {
  private running = false;

  constructor(private readonly deps: MarkerFileAdapterDeps) {}

  async tick(): Promise<void> {
    try {
      const exists = await this.deps.probe.exists();
      if (exists === this.running) return;
      this.running = exists;
      await this.deps.machine.handle(exists ? AGENT_STARTED : AGENT_FINISHED);
    } catch (error) {
      this.deps.logger.warn(`marker-file adapter failed: ${String(error)}`);
    }
  }
}
```

A matching test, using the existing `FakeMachine` and `noopLogger`:

```ts
// tests/marker-file.test.ts
import { describe, expect, it } from 'vitest';
import { MarkerFileAdapter } from '../src/adapters/marker-file';
import type { MarkerFileProbe } from '../src/adapters/marker-file';
import { AGENT_FINISHED, AGENT_STARTED } from '../src/core/types';
import { noopLogger } from '../src/core/logger';
import { FakeMachine } from './helpers';

describe('MarkerFileAdapter', () => {
  it('emits started and finished when the marker appears and disappears', async () => {
    let marker = false;
    const probe: MarkerFileProbe = { exists: async () => marker };
    const machine = new FakeMachine();
    const adapter = new MarkerFileAdapter({ machine, probe, logger: noopLogger });

    await adapter.tick();
    expect(machine.events).toEqual([]);

    marker = true;
    await adapter.tick();
    expect(machine.events).toEqual([AGENT_STARTED]);

    marker = false;
    await adapter.tick();
    expect(machine.events).toEqual([AGENT_STARTED, AGENT_FINISHED]);
  });
});
```

This example is intentionally minimal. A real adapter also needs a `start()`
that schedules `tick()` or subscribes to the agent's events, and a `stop()` that
clears the timer or subscription.

Registration depends on the adapter type:

- Platform or global adapters (like the hotkey watcher) are constructed in
  `src/core/daemon.ts` and started with the other adapters.
- Window-based adapters are configured through `registeredAgents`. If you add a
  new adapter kind, update `AdapterKind` in `src/core/types.ts`, the validation
  list in `src/core/config.ts`, and this documentation.
- If the adapter runs inside an agent process, keep the CLI path fast and
  silent. The built-in hook command gives the daemon 180 ms, then hands the
  event to a detached helper and exits.

Adapters that run a timer must stop it on `stop()`/`dispose()` and must swallow
errors from callbacks. Add a test for the start transition, the finish
transition, and a failing probe or controller.

## Adding OS support

Windows is currently the only implemented platform. The portable boundary is:

```ts
// src/windows/window-controller.ts
export interface WindowController {
  getForegroundWindow(): Promise<WindowHandle | null>;
  minimizeWindow(handle: WindowHandle): Promise<void>;
  restoreAndFocusWindow(handle: WindowHandle): Promise<boolean>;
  openInNewBrowserWindow(url: string): Promise<WindowHandle | null>;
  findWindows(match: WindowMatch): Promise<WindowHandle[]>;
}
```

`WindowHandle` is `{ id, title, processName, pid }`; `id` is a string because
Win32 HWNDs should not be stored as JavaScript numbers. The Win32 implementation
is in `src/windows/win32.ts`. `src/core/daemon.ts` currently constructs it
unconditionally, so non-Windows daemons start but cannot move windows:
`getForegroundWindow` returns `null`, focus returns `false`, and minimize
rejects; the state machine catches and logs those failures.

A macOS or Linux controller should implement the same five methods and be
selected in the daemon. Use a stub while the platform work is in progress:

```ts
// src/windows/unsupported.ts
import { WindowHandle, WindowMatch } from '../core/types';
import { WindowController } from './window-controller';

export class UnsupportedWindowController implements WindowController {
  async getForegroundWindow(): Promise<WindowHandle | null> {
    return null;
  }

  async minimizeWindow(_handle: WindowHandle): Promise<void> {}

  async restoreAndFocusWindow(_handle: WindowHandle): Promise<boolean> {
    return false;
  }

  async openInNewBrowserWindow(_url: string): Promise<WindowHandle | null> {
    return null;
  }

  async findWindows(_match: WindowMatch): Promise<WindowHandle[]> {
    return [];
  }
}
```

Planned platform selection in `src/core/daemon.ts`:

```ts
const windows: WindowController =
  process.platform === 'win32'
    ? new Win32WindowController(config.browser, logger)
    : process.platform === 'darwin'
      ? new MacOSWindowController()
      : new LinuxWindowController();
```

Notes for platform implementations:

- macOS: AppleScript/JXA via `osascript`, or the Accessibility API for window
  focus. The Alt-key workaround is Windows-specific; use the platform's normal
  activation APIs.
- Linux: `wmctrl`, `xdotool`, or the compositor's protocol. Focus behavior
  differs between X11 and Wayland, so document what is supported.
- The global key listener (`src/windows/key-listener.ts`) and CPU probe
  (`src/windows/cpu-probe.ts`) are Windows/PowerShell implementations. A port
  needs equivalents, or the hotkey/IDE adapters should be disabled on that
  platform.
- Keep the state machine platform-neutral. It only consumes the
  `WindowController` interface.

Open an issue before starting a large platform port so the interface and
behavior can be agreed on first.

## Pull request checklist

- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
- [ ] `npm run build` passes.
- [ ] README and CHANGELOG updated for user-visible changes.
- [ ] New adapters have tests for started, finished, and failure paths.
- [ ] Adapters and hooks never block or crash the agent.
- [ ] Window/focus changes were manually tested on Windows; the browser is
      minimized (not closed) and the agent window is restored.
- [ ] No new runtime dependency without prior discussion.
- [ ] Screenshots or a short GIF included for visible behavior changes.

By contributing, you agree that your changes are licensed under the MIT License.

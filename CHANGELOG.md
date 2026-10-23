# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [0.3.1] - 2026-10-23

### Fixed

- `doomscroller init antigravity` wrote a hook command Antigravity could not
  execute. The previous release wrapped the CLI in
  `powershell.exe -NoProfile -Command "& '<node>' '<cli>' ..."`, but Antigravity
  loses the nested quoting and captures the literal `& '<node>' '<cli>' ...` text
  as the hook's stdout, which then fails its JSON parse ("invalid value &") — so
  the CLI never ran and no session started or finished (sessions ran to the
  `maxDoomscrollSeconds` cap and were reported as `working`). `init antigravity`
  now emits the bare `node <cli> antigravity-hook <action>` form, quoting only
  the CLI path when it contains spaces, and never a `-Command` wrapper. When
  `node` is not on PATH it generates a `~/.doomscroller/antigravity-hook-<action>.cmd`
  wrapper that calls the absolute node path; if no runnable command can be built
  it reports an error and refuses to write one.

## [0.3.0] - 2026-10-23

### Added

- `doomscroller init antigravity` merges `PreInvocation` → start and `Stop` → done
  into `~/.gemini/config/hooks.json`, the global hooks file shared by the
  Antigravity App, CLI and IDE. A `Stop` only finishes a session when its payload
  reports `fullyIdle`, which excludes terminations that still have background
  tasks running. `hooks.json` is always written without a UTF-8 BOM: Antigravity
  parses it with Go's JSON decoder, which rejects a BOM and then silently loads
  no hooks at all.
- Hook invocations are appended to `~/.doomscroller/antigravity-hooks.log` with
  the raw stdin payload and the decision, so the hooks can be checked even with
  no daemon running.

### Changed

- Antigravity hooks are the **primary** signal for that agent, so the default
  `registeredAgents` is now `[]` and no longer ships an Antigravity `ide-activity`
  entry. Leaving it in place let Enter-based sessions and hook sessions both
  start, and they conflict. `PreInvocation` fires before every model call, so a
  session starts on each prompt you submit — one session per prompt, including
  prompts sent with the send button that the Enter fallback never sees. Existing
  configs keep their entry; remove it (or set the list to `[]`) to match. The
  `ide-activity` fallback remains available as an opt-in for agents without
  hooks.

### Fixed

- The Antigravity hook command no longer starts with a quoted path. Antigravity
  runs hook commands through a shell, where a leading quoted path is not
  executed. `init antigravity` now emits the bare
  `node <cli> antigravity-hook <action>` form when nothing needs quoting, and
  otherwise `powershell.exe -NoProfile -Command "& '<node>' '<cli>'
  antigravity-hook <action>"`.
- Re-running `doomscroller init antigravity` upgrades a hooks file written by an
  older release in place, rather than appending a second handler that would never
  run. Re-running against the current form is still a no-op, and no other hook
  group is ever touched.
- Stale window handles no longer break the end of a session. A browser can
  replace the window it exposes at launch, so the saved handle was frequently
  invalid by the time a session ended: `minimize` failed with "invalid window
  handle" and the doomscroll browser stayed open, covering the agent window that
  had just been restored. Browser window detection now requires the same window
  on two consecutive polls, and a stale handle is re-resolved once by process
  name before minimize or restore gives up.
- The `ide-activity` fallback no longer starts a session on Shift/Ctrl/Alt+Enter,
  which are newline and shortcut keys rather than prompt submissions.

## [0.2.1] - 2026-10-23

### Changed

- README: added the demo GIF and removed the placeholder TODO note.

No functional changes. `docs/` is excluded from the published package, so the
GIF does not affect the download size.

## [0.2.0] - 2026-10-23

### Added

- Command Code hook adapter plus `doomscroller init command-code`. It merges a
  `PreToolUse` → start and a `Stop` → done hook into `~/.commandcode/settings.json`
  (user scope), mirroring `init claude-code`. Command Code has no per-prompt
  hook, so start is the first tool call of a turn. Existing hooks are preserved
  and a `settings.json.doomscroller.bak` backup is created.

### Fixed

- The end-of-session chime now plays. The player spawned PowerShell detached,
  and a detached, console-less `powershell.exe` exits without running its
  `-Command`, so `[console]::beep` was a silent no-op.
- Config is re-read at the start of each session, so `delaySeconds`,
  `maxDoomscrollSeconds`, `targets`, `browser`, and `sound` take effect without
  restarting the daemon. A missing or invalid config keeps the previous values;
  `port` and `hotkey` still require a restart.
- Removed a redundant daemon spawn on the hook fast-path that could race the
  dispatch helper and produce `EADDRINUSE` / duplicate daemons.

## [0.1.0] - 2026-10-22

### Added

- Windows CLI with an `IDLE -> WORKING -> DONE` state machine driven by
  `agent:started` and `agent:finished`.
- Configurable delay, target rotation, maximum doomscroll time cap, and a
  `Ctrl+Alt+D` force-return hotkey.
- Win32 window control through PowerShell and `user32.dll`, including the
  Alt-key workaround for Windows foreground locking.
- Hotkey adapter.
- Claude Code hook adapter plus `doomscroller init claude-code`.
- PTY-based CLI wrapper (`doomscroller run -- <command>`).
- Experimental IDE-activity adapter using registered window matches, Enter
  detection, workspace mtime checks, and process-tree CPU sampling.
- `~/.doomscroller.json` config with validation and defaults.
- Session JSONL logging and `doomscroller stats`.
- `doomscroller config`, `status`, and `stop` commands.
- Unit tests for the state machine, adapters, config, hooks, stats, and IDE
  activity.
- README, CONTRIBUTING, issue templates, PR template, and Windows CI.

### Known limitations

- Windows 10/11 only. A macOS/Linux `WindowController` is planned.
- IDE activity detection is heuristic: a long-running agent with no file
  writes and low CPU can be classified as finished.
- The hotkey watcher observes keys but does not swallow them.
- Target rotation is held in memory and resets when the daemon restarts.
- The demo GIF is not recorded yet; see the placeholder in README.md.

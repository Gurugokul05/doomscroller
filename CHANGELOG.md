# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/).

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

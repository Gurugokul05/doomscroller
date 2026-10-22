# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/).

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

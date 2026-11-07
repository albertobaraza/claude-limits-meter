# Changelog

## 0.1.0

Initial version.

- Status-bar item with 5-hour session usage; tooltip and click menu with the 5-hour and 7-day windows and reset countdowns.
- Reads the Claude Code login from `~/.claude/.credentials.json` (Linux, WSL, Windows, remote hosts) or the macOS Keychain.
- Optional, off-by-default renewal of an expired token (`claudeUsageStatusbar.refreshExpiredToken`), never for Keychain logins.
- Polling every 60 seconds (configurable), paused while the window is unfocused.

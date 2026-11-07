# Changelog

All notable changes to this extension are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-07

### Added

- Status-bar item showing the 5-hour session usage, with a tooltip and a click menu for the 5-hour and 7-day windows and their reset countdowns.
- Reads the Claude Code login from `~/.claude/.credentials.json` (Linux, WSL, Windows, remote hosts) or from the macOS Keychain.
- Optional, off-by-default renewal of an expired token (`claudeUsageStatusbar.refreshExpiredToken`), never for a login kept in the Keychain.
- Usage is checked every 60 seconds (configurable) and not while the window is unfocused.

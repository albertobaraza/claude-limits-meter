# Changelog

All notable changes to this extension are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-11-09

### Added

- A new setting, `claudeLimitsMeter.showWeekly`, to show the 7-day weekly usage next to the 5-hour session in the status bar (for example `5h 42% · 7d 18%`). It is off by default, so the status bar still shows the 5-hour session alone until you turn it on, and it takes effect right away.
- A **Settings** entry in the click menu and a **Settings** link in the hover open this extension's settings. The same is available from the command palette as *Claude Limits Meter: Open Settings*.
- An icon for the extension, shown on its Marketplace page and in the Extensions view.

## [0.3.1] - 2026-11-09

### Changed

- No change in what the extension does. It now carries hooks for its automated tests; they are switched off in the installed extension, which still contacts only `api.anthropic.com` (and `console.anthropic.com` when token renewal is on).

## [0.3.0] - 2026-11-09

### Added

- A "Last checked" time (for example `14:32`) in the hover and in the click menu, so you can tell how old the numbers are, for instance after a failed check.
- The click menu now explains the state in plain words when there is no Claude Code login, the token has expired, Claude is rate limiting the bar, or a check failed with an error.

### Changed

- Hovering the status bar item now shows a short summary of the 5-hour session and the week. The bars and the time until each limit resets moved to the click menu.

## [0.2.0] - 2026-11-09

### Changed

- The settings and commands now start with `claudeLimitsMeter.` instead of `claudeUsageStatusbar.`, to match the extension's name. The old names are no longer read: if you set `claudeUsageStatusbar.pollIntervalSeconds`, `claudeUsageStatusbar.refreshExpiredToken` or `claudeUsageStatusbar.clientId` in your settings, or bound a key to one of its commands, rename them to `claudeLimitsMeter.*`.
- The commands, the status bar item, the menu and the warnings are labelled "Claude Limits Meter" instead of "Claude Usage".

## [0.1.2] - 2026-11-07

### Fixed

- Clicking Refresh Now several times no longer ends in `HTTP 429` errors: it asks Claude at most once every 10 seconds and shows the reading it already has in between.
- When Claude does rate limit the bar, the item shows a clock with the last reading and the tooltip says when the next check happens. It waits as long as Claude asks (or 2 minutes, doubling up to 30) before trying again, instead of retrying every minute.

## [0.1.1] - 2026-11-07

### Changed

- Renamed to Claude Limits Meter (extension id `albertobaraza.claude-limits-meter`), because the previous name was not available on the Marketplace. Settings and commands are unchanged; if you installed 0.1.0 from the `.vsix`, uninstall it and install the new one.

## [0.1.0] - 2026-11-07

### Added

- Status-bar item showing the 5-hour session usage, with a tooltip and a click menu for the 5-hour and 7-day windows and their reset countdowns.
- Reads the Claude Code login from `~/.claude/.credentials.json` (Linux, WSL, Windows, remote hosts) or from the macOS Keychain.
- Optional, off-by-default renewal of an expired token (`claudeUsageStatusbar.refreshExpiredToken`), never for a login kept in the Keychain.
- Usage is checked every 60 seconds (configurable) and not while the window is unfocused.

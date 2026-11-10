# Changelog

All notable changes to this extension are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.3] - 2026-11-10

### Changed

- Several VS Code windows on the same machine now ask Claude about as often as one. A window that has just read your usage lets the others show that reading, and a window that Claude told to wait makes the others wait too, so switching windows no longer asks again in the middle of a wait. They share a small file in the extension's storage folder with the last reading, the end of the wait and a one-way fingerprint of your login, never a token. *Refresh Now* still asks for a fresh reading unless another window took one in the last 10 seconds.

### Fixed

- Claude's usage endpoint answers every rate limit (`429`) with `Retry-After: 0`, which was taken as a wait of a few seconds: the bar said "next check in 0m" and asked again every minute, keeping itself rate limited. That is now treated as no hint, so the wait starts at 2 minutes and doubles up to 30.

## [0.5.2] - 2026-11-10

### Changed

- The Marketplace listing has a shorter description, more search keywords (usage limits, session limit, weekly limit, quota) and is listed under the AI category as well as Other.

## [0.5.1] - 2026-11-10

### Changed

- `claudeLimitsMeter.refreshExpiredToken` and `claudeLimitsMeter.clientId` are now read from your User settings only. A value in a workspace's `.vscode/settings.json` is ignored (the Output channel says so), so a repository can no longer switch token renewal on.
- An unexpected error is shown by its type only, for example `Unexpected error (TypeError)`, a network failure with its code (`Network error (ECONNREFUSED)`) and a timeout as `Request timed out`. Text from a library, a token included, can no longer reach the hover, the menu or the Output channel.
- When a renewal rewrites a credentials file that other users could read, the file is made readable by you only (mode 600), and the Output channel says so.
- The extension is declared as not supported in untrusted workspaces, so Restricted Mode now says why it is off.

### Fixed

- A redirect from Anthropic's token endpoint can no longer carry your refresh token to another host. Redirects are refused, for the usage request as well.
- With Claude Code 2.1.319, token renewal presented your login under the wrong OAuth client id, because that version lists a local-development client first. It now uses the production one.
- A renewal no longer overwrites a login that Claude Code or another window saved while it was in flight. Theirs is kept and used.
- An answer from the token endpoint that is not the expected shape, for example `{}`, no longer rewrites your credentials file without an access token. A login whose access token is malformed reads as expired, instead of showing an error that quoted it.
- A refresh token the server refused is not sent again on every check: it waits five minutes, or tries at once when you sign in again.
- After you log out or sign in as another account, the previous account's reading and renewed token are no longer shown or used.
- On macOS, a Keychain that fails to answer (denied, locked, timed out) no longer lets a stale `~/.claude/.credentials.json` be renewed. Only a Keychain that says it holds no login does.
- A very large or non-numeric `claudeLimitsMeter.pollIntervalSeconds` no longer makes the extension check continuously and ignore the rate-limit wait. The setting is now limited to 15 to 86400 seconds, and anything that is not a number means 60.
- A usage answer with neither window in it is now an error, not a reading of 0%.
- The credentials file is rewritten more safely: a file or link planted at a predictable temporary name is no longer written through, and the write is flushed to disk before it replaces your login.
- A check still running when the extension is turned off or reloaded no longer starts the timer again.

## [0.5.0] - 2026-11-09

### Changed

- The extension now needs VS Code 1.125 or newer (it was 1.85). On an older VS Code, either update VS Code or stay on 0.4.0.

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

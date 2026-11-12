# How it works

The details behind the [README](../README.md), for anyone who wants to know exactly when the extension asks Claude, what it
does about a rate limit, and what it keeps on disk. To work on the code, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Checks

- The extension reads your Claude Code login and asks Anthropic's usage endpoint (`/api/oauth/usage`, undocumented, so it
  may change without notice) for the 5-hour session and the 7-day week.
- It checks every `claudeLimitsMeter.pollIntervalSeconds` (60 by default; 15 to 86400, a value outside that is clamped and
  anything that is not a number means 60). A window that is not focused does not check, and checks at once when it is
  focused again if its last check is older than the interval.
- The login is re-read on every check, so a token that Claude Code renewed meanwhile is picked up with no action here.

## Rate limits

The usage endpoint answers `429` when it is asked too often, for example by clicking *Refresh Now* several times in a row.
The extension is careful not to make that worse:

- *Refresh Now* asks the API at most once every 10 seconds; in between it just shows what it already has.
- After a `429` the item shows a clock icon with the last reading, and the extension retries by itself. It waits for
  the time Claude asks for (`Retry-After`), or 2 minutes when Claude gives none, doubling on every further `429` up to
  30 minutes. *Refresh Now* does not ask again before that, and the normal checks resume by themselves.
- Claude's usage endpoint sends `Retry-After: 0` with its `429`s, which is not a wait. A `Retry-After` of under 5 seconds
  counts as no hint, so the 2 minutes (and the doubling) apply.

## Several VS Code windows

Every VS Code window runs its own copy of the extension, with its own timer. Windows on the same machine (and so the same
login) share what they find out through a small file in the extension's storage folder, so that together they ask Claude
about as often as one and all show the same numbers:

- A window that just took a reading lets the others show it instead of asking again.
- A window told to wait by a `429` makes the others wait too, so switching windows never asks again in the middle of a wait.
- Every window watches that file, so all of them show the newest reading as soon as any one takes it, an unfocused window
  included. Following the others sends no request.
- *Refresh Now* still asks for a fresh reading unless another window took one in the last 10 seconds.

The file holds the last reading, the time a `429` says to wait until, and a one-way fingerprint of the login (a truncated
SHA-256 of the access token, so a reading is never shown for another account). It holds **no token**, it is readable by you
only (mode 600), and if it cannot be read or written the extension works as if there were no other windows.

## When the token expires

Claude Code's access token lasts a few hours and Claude Code renews it whenever it is used, so normally there is nothing to
do. If you have not used Claude Code for a while the item shows `!` until you do.

`claudeLimitsMeter.refreshExpiredToken` makes the extension renew an expired token itself. It is **off by default**:

- Refresh tokens rotate. If the renewed login cannot be written back, Claude Code may ask you to sign in again: the
  extension retries, keeps the new token in memory, and warns you. If Claude Code or another window saved a login while the
  renewal was in flight, that login is kept and nothing is overwritten, but two programs renewing the same token at the same
  moment can still sign one of them out.
- It uses Claude Code's own OAuth client id, detected from the installed Claude Code extension (or set with
  `claudeLimitsMeter.clientId`).
- It never writes to the macOS Keychain, so it has no effect on a login stored there.
- Only your User settings can switch it on: a workspace's `.vscode/settings.json` is ignored for it, so a repository cannot
  enable it.
- When a renewal rewrites a credentials file that other users could read, the file is made readable by you only (mode 600).

## Where it connects

Only `api.anthropic.com` (the usage) and, with renewal on, `console.anthropic.com`. There is no telemetry. No setting or
environment variable of the installed extension changes where a token is sent: only a VS Code test host can point the
extension at a fake API, and only one on the same machine.

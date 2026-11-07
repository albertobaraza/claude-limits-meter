# Claude Usage Status Bar

Shows your [Claude Code](https://code.claude.com) usage limits, the **5-hour session** and the **7-day weekly** window, in the VS Code status bar.

> **Unofficial.** This is an independent project, not affiliated with or endorsed by Anthropic. It uses an undocumented usage endpoint that may change without notice.

```
✦ 42%                 ← status bar: current 5-hour session usage

Session (5h)  ████░░░░░░  42%   ⏱ 2h 13m      ← hover tooltip
Weekly  (7d)  ██░░░░░░░░  18%   ⏱ 4d 2h
```

Click the status bar item for a menu with both windows, **Refresh Now** and **Open Credentials File**. It is deliberately minimal.

## Platforms

The extension runs where your Claude Code login lives (`extensionKind: workspace`), so it works in Remote-SSH, WSL and dev containers as long as you are signed in to Claude Code **on that host**.

| Platform | Where the login is read from |
| --- | --- |
| Linux, WSL, remote hosts | `~/.claude/.credentials.json` |
| Windows | `%USERPROFILE%\.claude\.credentials.json` |
| macOS | The Keychain item `Claude Code-credentials`, then `~/.claude/.credentials.json` |

On macOS the first read may show a system prompt asking whether `security` may use the item; choose *Always Allow* to stop it reappearing.

**Test status:** developed and run on Linux (WSL). The Windows and macOS paths are covered by unit tests (the Keychain with a stubbed `security` command) and CI runs the tests on all three systems, but they have not yet been used on real Windows or macOS machines. Reports welcome.

## Install

Not on the Marketplace yet. Build and install the `.vsix` yourself:

```bash
git clone https://github.com/albertobaraza/claude-usage-statusbar.git
cd claude-usage-statusbar
npm ci
npm run package                 # produces claude-usage-statusbar-<version>.vsix
code --install-extension claude-usage-statusbar-*.vsix
```

## When the token expires

Claude Code's access token lasts a few hours and Claude Code renews it whenever it is used. The extension re-reads your login on every check, so it picks up a renewed token by itself. If you have not used Claude Code for a while the item shows `!` until you do.

If you would rather renew from here, turn on **`claudeUsageStatusbar.refreshExpiredToken`**. It is **off by default** because:

- refresh tokens rotate: if the renewed login cannot be written back, Claude Code may ask you to sign in again (the extension retries, keeps the new token in memory, and warns you);
- it uses Claude Code's own OAuth client id, detected from the installed Claude Code extension.

It never writes to the macOS Keychain, so the option has no effect on a Keychain-stored login.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `claudeUsageStatusbar.pollIntervalSeconds` | `60` | Seconds between checks (minimum 15). Checks are skipped while the window is unfocused. |
| `claudeUsageStatusbar.refreshExpiredToken` | `false` | See above. |
| `claudeUsageStatusbar.clientId` | `""` | OAuth client id for the option above; empty means auto-detect. |

Commands: *Claude Usage: Show Menu*, *Refresh Now*, *Open Credentials File*.

## Privacy and security

- Reads your Claude Code login (file or Keychain) and sends the **access token only to `api.anthropic.com`** to read your usage. With token refresh switched on it also contacts `console.anthropic.com`. Nothing else is contacted, and there is no telemetry.
- Never writes your login unless you enable `refreshExpiredToken`, and then only in the credentials file.
- No runtime dependencies, so there is no third-party code in the extension.
- *Open Credentials File* shows the file in an editor. It contains live tokens, so be careful about screen sharing.

## Development

```bash
npm ci
npm test            # compiles, then runs the unit tests (node:test, no VS Code needed)
npm run package     # builds the .vsix
```

The logic that doesn't need VS Code lives in `src/claude.ts` and is tested in `test/`; `src/extension.ts` is only the status-bar UI.

## Related projects

[Claude Usage Bar](https://github.com/Harsh1210/claude-usage-bar) by Harsh Agarwal (MIT) covers similar ground with a different approach: it listens to Claude Code's own usage requests instead of polling, and adds colour alerts and model/context display. Its source helped confirm where Claude Code keeps its login on each platform.

## License

[MIT](LICENSE)

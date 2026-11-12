# Claude Limits Meter

Shows your [Claude Code](https://code.claude.com) usage limits, the **5-hour session** and the **7-day weekly** window, in the VS Code status bar.

> **Unofficial.** This is an independent project, not affiliated with or endorsed by Anthropic. It uses an undocumented usage endpoint that may change without notice.

```
✦ 42%                                          ← status bar: current 5-hour session usage

Session (5h) 42% · Weekly (7d) 18%             ← hover: a short summary
Last checked 14:32

Session (5h)  ████░░░░░░ 42%   ⏱ 2h 13m       ← click: the details
Weekly (7d)   ██░░░░░░░░ 18%   ⏱ 4d 2h
Last checked  14:32
```

Hover the status bar item for a short summary of both windows. Click it for the details (a bar and the time until each window resets, and when the usage was last checked), plus **Refresh Now**, **Open Credentials File** and **Settings** (this extension's settings). It is deliberately minimal.

## What the item shows

| Status bar | Meaning |
| --- | --- |
| `✦ 42%` | Your 5-hour session usage. With `claudeLimitsMeter.showWeekly` on: `✦ 5h 42% · 7d 18%`. |
| `🕒 42%` | Claude asked for a pause. The last reading is shown, and the hover says when the next check happens. It resumes by itself. |
| `✦ !` | The stored Claude token has expired. It renews the next time you use Claude Code. |
| `✦ —` | No Claude Code login found on this machine. |
| `✦ ✗` | The check failed; hover for the reason, or see the *Claude Limits Meter* channel in the Output panel. The last reading is kept in the hover. |
| `✦ …` | The first check is running. Refresh Now shows a spinning icon the same way. |

## Requirements and platforms

- VS Code 1.125 or later.
- Signed in to [Claude Code](https://code.claude.com) with a Claude account, the kind that has the 5-hour and weekly limits. With only an API key there is no login to read, and the item shows `—`.
- A trusted workspace: the extension does not run in Restricted Mode, because it reads your login and sends it to Anthropic.

The extension runs where your Claude Code login lives (`extensionKind: workspace`), so it works in Remote-SSH, WSL and dev containers as long as you are signed in to Claude Code **on that host**.

| Platform | Where the login is read from |
| --- | --- |
| Linux, WSL, remote hosts | `~/.claude/.credentials.json` |
| Windows | `%USERPROFILE%\.claude\.credentials.json` |
| macOS | The Keychain item `Claude Code-credentials`, then `~/.claude/.credentials.json` |

On macOS the first read may show a system prompt asking whether `security` may use the item; choose *Always Allow* to stop it reappearing.

**Test status:** developed and run on Linux (WSL). The Windows and macOS paths are covered by unit tests (the Keychain with a stubbed `security` command) and CI runs the tests, and loads the extension in a real VS Code, on all three systems. They have not yet been used on real Windows or macOS machines, though. Reports welcome.

## When the token expires

Claude Code's access token lasts a few hours and Claude Code renews it whenever it is used. The extension re-reads your login on every check, so it picks up a renewed token by itself. If you have not used Claude Code for a while the item shows `!` until you do.

If you would rather renew from here, turn on **`claudeLimitsMeter.refreshExpiredToken`**. It is **off by default** because refresh tokens rotate: if the renewed login cannot be written back, Claude Code may ask you to sign in again (the extension keeps the new token in memory and warns you). It never writes to the macOS Keychain, so the option has no effect on a Keychain-stored login. [How it works](docs/HOW-IT-WORKS.md#when-the-token-expires) has the details.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `claudeLimitsMeter.pollIntervalSeconds` | `60` | Seconds between checks (15 to 86400; a value outside that is clamped, and anything that is not a number means 60). Checks are skipped while the window is unfocused. |
| `claudeLimitsMeter.showWeekly` | `false` | Show the 7-day weekly usage next to the 5-hour session in the status bar (`5h 42% · 7d 18%`). Off shows the 5-hour session alone. |
| `claudeLimitsMeter.refreshExpiredToken` | `false` | See above. Read from your User settings only: a workspace's `.vscode/settings.json` cannot switch it on. |
| `claudeLimitsMeter.clientId` | `""` | OAuth client id for the option above; empty means auto-detect. User settings only, like the option above. |

## Commands

Run them from the Command Palette (Ctrl+Shift+P / Cmd+Shift+P). The last three are also in the menu that opens when you click the status bar item.

| Command | |
| --- | --- |
| `Claude Limits Meter: Show Menu` | The menu the status bar item opens: the usage with a bar and reset time for each window, when it was last checked, and the other commands. |
| `Claude Limits Meter: Refresh Now` | Asks Claude for a fresh reading, at most once every 10 seconds and not while Claude is asking you to wait. |
| `Claude Limits Meter: Open Credentials File` | Opens the Claude Code login file in an editor (a login kept in the macOS Keychain has no file to open). It contains live tokens, so be careful about screen sharing. |
| `Claude Limits Meter: Open Settings` | Opens the Settings editor filtered to this extension. |

## When Claude asks you to wait

Claude's usage endpoint answers `429` when it is asked too often. The item then shows a clock with your last reading, and the hover says when the next check happens. Checks resume by themselves, and *Refresh Now* does not ask before then. *Refresh Now* also asks Claude at most once every 10 seconds.

With several VS Code windows open on the same machine, they ask Claude about as often as one and all show the same numbers, even the windows you are not looking at. [How it works](docs/HOW-IT-WORKS.md) has the details: the waits, how the windows share what they find, and what is kept on disk.

## Privacy and security

- Reads your Claude Code login (file or Keychain) and sends the **access token only to `api.anthropic.com`** to read your usage. With token refresh switched on it also contacts `console.anthropic.com`. Nothing else is contacted, and there is no telemetry. No setting or environment variable of the installed extension changes where your token is sent (only a VS Code test host can point it at a fake API, and only one on your own machine).
- Keeps one small file in the extension's storage folder, on the machine that runs the extension, so your VS Code windows can share what they find out (the extension watches it for changes): the last reading, when a `429` says to wait until, and a one-way fingerprint of the login (a truncated SHA-256 of the access token, so a reading is never shown for another account). It holds no token, and the file is readable by you only (mode 600).
- Never writes your login unless you enable `refreshExpiredToken`, and then only in the credentials file. When it rewrites that file it leaves it readable by you only (mode 600).
- No runtime dependencies, so there is no third-party code in the extension.
- *Open Credentials File* shows the file in an editor. It contains live tokens, so be careful about screen sharing.

## Feedback and contributing

Found a bug or have an idea? [Open an issue](https://github.com/albertobaraza/claude-limits-meter/issues). To work on the extension, see [CONTRIBUTING.md](CONTRIBUTING.md); to report a vulnerability, see [SECURITY.md](SECURITY.md).

## Acknowledgements

Thanks to [Claude Usage Bar](https://github.com/Harsh1210/claude-usage-bar) by Harsh Agarwal (MIT). Reading its source helped us confirm where Claude Code keeps its login on each platform, which this extension depends on.

It covers similar ground with a different approach: it mostly listens to Claude Code's own usage responses instead of asking Anthropic itself (with a slower background poll as a fallback), and adds colour alerts and model/context display. If you want those, it is worth a look.

## License

[MIT](LICENSE)

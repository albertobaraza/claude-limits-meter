# Claude Limits Meter

Shows your [Claude Code](https://code.claude.com) usage limits, the **5-hour session** and the **7-day weekly** window, in the VS Code status bar.

> **Unofficial.** This is an independent project, not affiliated with or endorsed by Anthropic. It uses an undocumented usage endpoint that may change without notice.

```
✦ 42%                                          ← status bar: current 5-hour session usage

Session · 42% · 2h 13m                         ← hover: both windows, lined up
Weekly  · 18% · 4d 2h
Last checked 14:32

Session (5h)  ████░░░░░░ 42%   ⏱ 2h 13m       ← click: the details
Weekly (7d)   ██░░░░░░░░ 18%   ⏱ 4d 2h
Last checked  14:32
```

Hover the status bar item for both windows one above the other, with how much of each is used and the time until it resets. Click it for the same with a bar for each (and the length of each window), and when the usage was last checked, plus **Refresh Now**, **Open Usage in Browser** (Claude's own usage page, for the full detail), **Open Credentials File** and **Settings** (this extension's settings). When either window reaches 90%, the status bar text turns yellow. It is deliberately minimal.

## What the item shows

| Status bar | Meaning |
| --- | --- |
| `✦ 42%` | Your 5-hour session usage. With `claudeLimitsMeter.showWeekly` on: `⌚ 42% · 📅 18%`, a watch icon for the session and a calendar for the week in place of the sparkle (the hover and the click menu mark their rows the same way). With `claudeLimitsMeter.showResetTime` on, each window is followed by the time until it resets: `✦ 42% (2h 13m)`, or with both on `⌚ 42% (2h 13m) · 📅 18% (4d 2h)`. |
| `✦ 91%` in yellow | The 5-hour session or the 7-day week (shown or not) has reached 90%. |
| `🕒 42%` | Claude asked for a pause. The last reading is shown (`🕒 …` before the first one), and the extension retries by itself. |
| `✦ !` | The stored Claude token has expired. It renews the next time you use Claude Code. |
| `✦ no login` | No Claude Code login found on this machine. |
| `✦ ✗` | The check failed; hover for the reason, or see the *Claude Limits Meter* channel in the Output panel. The last reading is kept in the hover. |
| `✦ …` | The first check is running. Refresh Now shows a spinning icon the same way. |

## Requirements and platforms

- VS Code 1.125 or later.
- Signed in to [Claude Code](https://code.claude.com) with a Claude account, the kind that has the 5-hour and weekly limits. With only an API key there is no login to read, and the item shows `✦ no login`.
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
| `claudeLimitsMeter.pollIntervalSeconds` | `60` | Seconds between checks (60 to 86400; a value outside that is clamped, and anything that is not a number means 60). Checks are skipped while the window is unfocused. |
| `claudeLimitsMeter.showWeekly` | `false` | Show the 7-day weekly usage next to the 5-hour session in the status bar, a watch icon marking the session and a calendar the week (`⌚ 42% · 📅 18%`). Off shows the 5-hour session alone. |
| `claudeLimitsMeter.showResetTime` | `false` | Show the time until each window in the status bar resets, after its usage (`42% (2h 13m)`, or with `showWeekly` on `⌚ 42% (2h 13m) · 📅 18% (4d 2h)`). It counts down once a minute. Off shows the usage alone. |
| `claudeLimitsMeter.refreshExpiredToken` | `false` | See above. Read from your User settings only: a workspace's `.vscode/settings.json` cannot switch it on. |
| `claudeLimitsMeter.clientId` | `""` | OAuth client id for the option above; empty means auto-detect. User settings only, like the option above. |
| `claudeLimitsMeter.commandLine` | `false` | Lets scripts and coding agents read your usage; see [From scripts and coding agents](#from-scripts-and-coding-agents). User settings only, like the two above. |

## Commands

Run them from the Command Palette (Ctrl+Shift+P / Cmd+Shift+P). The last four are also in the menu that opens when you click the status bar item.

| Command | |
| --- | --- |
| `Claude Limits Meter: Show Menu` | The menu the status bar item opens: the usage with a bar and reset time for each window, when it was last checked, and the other commands. |
| `Claude Limits Meter: Refresh Now` | Asks Claude for a fresh reading, at most once every 10 seconds and not while Claude is asking you to wait. |
| `Claude Limits Meter: Open Usage in Browser` | Opens [claude.ai/settings/usage](https://claude.ai/settings/usage) in your default browser, where Claude shows your usage in full. The browser asks you to sign in to claude.ai if you are not already. The extension itself does not contact that address. |
| `Claude Limits Meter: Open Credentials File` | Opens the Claude Code login file in an editor (a login kept in the macOS Keychain has no file to open). It contains live tokens, so be careful about screen sharing. |
| `Claude Limits Meter: Open Settings` | Opens the Settings editor filtered to this extension. |

## From scripts and coding agents

A script, or a coding agent about to start a long job, can ask whether there is room left in your limits. This is **off by default**: switch on **`claudeLimitsMeter.commandLine`** in your User settings. The extension then keeps its last reading in a small folder, with a `claude-limits` command beside it:

| System | Folder |
| --- | --- |
| Linux, WSL, remote hosts | `~/.local/state/claude-limits-meter` (`$XDG_STATE_HOME/claude-limits-meter` if you set that variable) |
| macOS | `~/Library/Application Support/claude-limits-meter` |
| Windows | `%LOCALAPPDATA%\claude-limits-meter` |

```
$ node ~/.local/state/claude-limits-meter/claude-limits.cjs --fresh 120 --max-5h 90 --max-7d 95
5h 42% (resets in 2h 13m) · 7d 18% (resets in 4d 2h) · checked 8s ago
$ echo $?
0
```

The exit status is the answer: **0** there is room, **1** a limit is reached, **2** it cannot tell (no reading, a reading that is too old, or an option that is wrong). Anything but 0 means "do not start".

| Option | |
| --- | --- |
| `--fresh <seconds>` | The reading must be at most this old (60 or more). If it is older, the command asks the extension for a new one and waits for it. VS Code must be running, but it does not have to be focused. |
| `--max-5h <percent>` | Fail when the 5-hour session is at this percentage or above. |
| `--max-7d <percent>` | Fail when the 7-day week is at this percentage or above. |
| `--wait <seconds>` | How long to wait for a fresh reading (15 by default, 120 at most). |
| `--json` | Print one line of JSON instead of text: `status` (`ok`, `limit`, `stale` or `none`), the reading and its age. |

Good to know:

- The command needs [Node.js](https://nodejs.org) on your `PATH`. On Linux and macOS the file is executable, so it also runs without the `node` in front.
- With no option it prints the last reading, whatever its age. Use `--fresh` when the answer matters: VS Code does not check while it is not focused, which is exactly when an agent is working by itself.
- A program can make the extension ask Claude at most once a minute, the same pace as the status bar's own checks, and never while Claude is asking it to wait.
- The command reads that folder and nothing else. It never reads your Claude login and never uses the network: only the extension does.
- If you would rather read the file yourself, the reading is in `usage.json` in that folder: `checkedAt`, and `percent` and `resetsAt` for `fiveHour` and `sevenDay`.
- Switching the setting off removes the folder. Uninstalling the extension while it is on leaves the folder behind: delete it by hand.

## When Claude asks you to wait

Claude's usage endpoint answers `429` when it is asked too often. The item then shows a clock with your last reading. Checks resume by themselves, and *Refresh Now* does not ask before then. *Refresh Now* also asks Claude at most once every 10 seconds.

With several VS Code windows open on the same machine, they ask Claude about as often as one and all show the same numbers, even the windows you are not looking at. [How it works](docs/HOW-IT-WORKS.md) has the details: the waits, how the windows share what they find, and what is kept on disk.

## Privacy and security

- Reads your Claude Code login (file or Keychain) and sends the **access token only to `api.anthropic.com`** to read your usage. With token refresh switched on it also contacts `console.anthropic.com`. Nothing else is contacted, and there is no telemetry. No setting or environment variable of the installed extension changes where your token is sent (only a VS Code test host can point it at a fake API, and only one on your own machine).
- *Open Usage in Browser* hands `https://claude.ai/settings/usage` to your browser and nothing else: no token, no reading and no identifier is added to the address, and the extension does not request that page.
- Keeps one small file in the extension's storage folder, on the machine that runs the extension, so your VS Code windows can share what they find out (the extension watches it for changes): the last reading, when a `429` says to wait until, and a one-way fingerprint of the login (a truncated SHA-256 of the access token, so a reading is never shown for another account). It holds no token, and the file is readable by you only (mode 600).
- With `commandLine` switched on (it is off by default), keeps a second small folder in your user state folder for other programs: the last reading, a launcher for the `claude-limits` command and, for a moment, a request for a fresh reading. It holds no token and no fingerprint of one, and is readable by you only (mode 700). Any program running as you can read it, and can make the extension ask Claude for a reading at most once a minute.
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

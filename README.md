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
git clone https://github.com/albertobaraza/claude-limits-meter.git
cd claude-limits-meter
npm ci --ignore-scripts
npm run package                 # produces claude-limits-meter-<version>.vsix
code --install-extension claude-limits-meter-*.vsix
```

## When the token expires

Claude Code's access token lasts a few hours and Claude Code renews it whenever it is used. The extension re-reads your login on every check, so it picks up a renewed token by itself. If you have not used Claude Code for a while the item shows `!` until you do.

If you would rather renew from here, turn on **`claudeLimitsMeter.refreshExpiredToken`**. It is **off by default** because:

- refresh tokens rotate: if the renewed login cannot be written back, Claude Code may ask you to sign in again (the extension retries, keeps the new token in memory, and warns you). If Claude Code or another window saved a login while the renewal was in flight, that login is kept and nothing is overwritten, but two programs renewing the same token at the same moment can still sign one of them out;
- it uses Claude Code's own OAuth client id, detected from the installed Claude Code extension.

It never writes to the macOS Keychain, so the option has no effect on a Keychain-stored login.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `claudeLimitsMeter.pollIntervalSeconds` | `60` | Seconds between checks (15 to 86400; a value outside that is clamped, and anything that is not a number means 60). Checks are skipped while the window is unfocused. |
| `claudeLimitsMeter.showWeekly` | `false` | Show the 7-day weekly usage next to the 5-hour session in the status bar (`5h 42% · 7d 18%`). Off shows the 5-hour session alone. |
| `claudeLimitsMeter.refreshExpiredToken` | `false` | See above. Read from your User settings only: a workspace's `.vscode/settings.json` cannot switch it on. |
| `claudeLimitsMeter.clientId` | `""` | OAuth client id for the option above; empty means auto-detect. User settings only, like the option above. |

Commands: *Claude Limits Meter: Show Menu*, *Refresh Now*, *Open Credentials File*, *Open Settings*.

## When Claude rate limits the bar

The usage endpoint answers `429` when it is asked too often, for example by clicking *Refresh Now* several times in a row. The extension is careful not to make that worse:

- *Refresh Now* asks the API at most once every 10 seconds; in between it just shows what it already has.
- After a `429` the item shows a clock icon with the last reading, and the tooltip says when the next check happens. It waits for the time Claude asks for (`Retry-After`), or 2 minutes when Claude gives none, doubling on every further `429` up to 30 minutes. *Refresh Now* does not ask again before that, and the normal checks resume by themselves.
- Claude's usage endpoint sends `Retry-After: 0` with its `429`s, which is not a wait. A `Retry-After` of under 5 seconds counts as no hint, so the 2 minutes (and the doubling) apply.
- **Several VS Code windows** on the same machine (and so the same login) ask Claude about as often as one. Every window runs its own copy of the extension, so they share what they find out through a small file: a window that just took a reading lets the others show it, and a window told to wait by a `429` makes the others wait too, so switching windows never asks again in the middle of a wait. Every window also watches that file, so all of them show the newest reading as soon as any one takes it, an unfocused window included (it still sends no request of its own). *Refresh Now* still asks for a fresh reading unless another window took one in the last 10 seconds.

## Privacy and security

- Reads your Claude Code login (file or Keychain) and sends the **access token only to `api.anthropic.com`** to read your usage. With token refresh switched on it also contacts `console.anthropic.com`. Nothing else is contacted, and there is no telemetry. No setting or environment variable of the installed extension changes where your token is sent (only a VS Code test host can point it at a fake API, and only one on your own machine).
- Keeps one small file in the extension's storage folder, on the machine that runs the extension, so the windows can share what they find out (and watches that folder to know when a window wrote it): the last reading, when a `429` says to wait until, and a one-way fingerprint of the login (a truncated SHA-256 of the access token, so a reading is never shown for another account). It holds no token, and the file is readable by you only (mode 600).
- Never writes your login unless you enable `refreshExpiredToken`, and then only in the credentials file. When it rewrites that file it leaves it readable by you only (mode 600).
- No runtime dependencies, so there is no third-party code in the extension.
- *Open Credentials File* shows the file in an editor. It contains live tokens, so be careful about screen sharing.

## Development

```bash
bash scripts/setup.sh                    # dependencies and git hooks
npm test                                 # unit tests (node:test, no VS Code needed)
npm run test:coverage                    # the same, with the coverage gate CI enforces
xvfb-run -a npm run test:integration     # loads the extension in a real VS Code, against a fake Claude API (no xvfb-run off Linux)
xvfb-run -a -s "-screen 0 1280x800x24" npm run test:ui   # installs the .vsix and checks what the real window shows
npm run test:integration:docker          # both of those in a clean Linux container
npm run package                          # builds the .vsix
./scripts/run.sh                         # VS Code in your browser with the extension, asking a mock Claude you steer from a web page (Docker)
```

Press **F5** in VS Code to run the extension in a development window, or run `./scripts/run.sh` to try it against a mock Claude
in Docker: a VS Code on http://localhost:8788 with the packaged extension, and a control page on http://localhost:4010 where you
change what the usage API answers (a reading, 429, 401, 500) and the login on the machine, and watch the status bar react.
Nothing real is involved: no Claude login and no call to Anthropic. The logic that does not need VS Code lives in
`src/claude.ts`, `src/state.ts` and `src/view.ts` and is unit-tested; `src/extension.ts` is only the status-bar glue.

Contributions go through pull requests (nothing is pushed to `main`); [CONTRIBUTING.md](CONTRIBUTING.md) has the branch,
commit and changelog conventions, [docs/RELEASING.md](docs/RELEASING.md) how releases are made, and
[SECURITY.md](SECURITY.md) how to report a vulnerability.

## Acknowledgements

Thanks to [Claude Usage Bar](https://github.com/Harsh1210/claude-usage-bar) by Harsh Agarwal (MIT). Reading its source helped us confirm where Claude Code keeps its login on each platform, which this extension depends on.

It covers similar ground with a different approach: it listens to Claude Code's own usage requests instead of polling, and adds colour alerts and model/context display. If you want those, it is worth a look.

## License

[MIT](LICENSE)

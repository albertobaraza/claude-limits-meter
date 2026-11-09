---
name: run
description: "Run this VS Code extension to see a change working: open a development window with it loaded, start the live Docker environment (VS Code in a browser and a mock Claude), check it against the live usage endpoint, or run it in a headless real VS Code. USE FOR: run the extension, see it working, try it, does it work, check the change in the real app, run.sh. DO NOT USE FOR: the unit tests alone (npm test) or releasing (see the release skill)."
allowed-tools: Bash(npm run *) Bash(npm test) Bash(xvfb-run *) Bash(code *) Bash(node scripts/smoke.js) Bash(./scripts/run.sh*) Read
---

# Run Skill

The extension is a status-bar item inside VS Code, so "running" it means one of four things. Pick by what needs proving.

## 1. Does the change work against the real endpoint? (no UI)

```bash
npm run smoke
```

Uses this machine's own Claude Code login, read-only (token renewal is off), asks the real usage endpoint and prints the
two bars and their reset countdowns. It never prints a token. Use it after a change to `claude.ts` or when Anthropic may have
changed the endpoint. It makes one request to `api.anthropic.com`, as the extension does every minute. It answers
`token result: none` or `expired` honestly when there is no usable login.

## 2. Does it load and behave in a real VS Code? (headless)

```bash
xvfb-run -a npm run test:integration                      # latest stable VS Code
VSCODE_VERSION=1.85.0 xvfb-run -a npm run test:integration   # the oldest version package.json promises
```

Downloads VS Code into `.vscode-test/` the first time (~350 MB, gitignored). Runs in a throwaway profile with an empty `HOME`,
where the suite writes a fake login, and the only network is a fake Claude API on the loopback: it walks the extension through
no login, a reading, 429, 401, 500 and a renewed login and reads what the status-bar item shows. It never touches your login.
On macOS or Windows leave off `xvfb-run`. A VS Code terminal sets `VSCODE_*` and `ELECTRON_RUN_AS_NODE` variables; the runner
strips them (see CLAUDE.md: never run the `code` CLI from here without doing the same).

```bash
xvfb-run -a -s "-screen 0 1280x800x24" npm run test:ui     # the packaged .vsix in the real window: hover, menu, screenshots
npm run test:integration:docker                            # both of the above in a clean container
```

`test:ui` writes screenshots to `.vscode-test/screenshots`: read them to see what the user sees.

## 3. Watch it live against a mock Claude, in Docker (no login, no network, nothing real)

```bash
./scripts/run.sh          # blocks: Ctrl+C stops and removes everything; ./scripts/run.sh down from another terminal
```

VS Code in the browser on http://localhost:8788 with the packaged extension installed (the release build, built from this
checkout), and a mock Claude with a control page on http://localhost:4010 where the usage API's answer (a reading, 429, 401,
500) and the login on the machine (valid, expired, none) are changed live. The terminal follows what the extension asks. Run
it again after a change to `src/`. Run from Claude, start it in the background and read its output for the banner; the user
opens the two URLs. It mounts nothing of the host: never add a mount of `~/.claude`. `VSCODE_PORT` and `MOCK_PORT` change the
ports.

## 4. See the status bar with your own eyes, with your real login

```bash
npm run compile
code --extensionDevelopmentPath="$PWD"
```

(or press **F5** in VS Code). A second window opens with the extension loaded and this machine's real login: the item shows
`✦ <percent> DEV` bottom right on an orange background (any build that is not the installed one marks itself, so it cannot be
mistaken for the installed extension); hover for the summary, click for the details. Reload it with *Developer: Reload Window* after a code
change, or run `npm run watch` in another terminal. In WSL or a remote window, `code` opens the window on the Windows side
and loads the extension from the remote, which is the case `extensionKind: workspace` exists for. This one is for the user to
run: from a VS Code terminal the `code` command forwards to that VS Code (`VSCODE_IPC_HOOK_CLI`), so Claude should not run it.

VS Code has no API to read a status-bar item, so a change to what the item *says* is tested in `src/view.ts` (pure;
`test/unit/view.test.js` asserts the exact text), and the integration suite reads it through the test hooks of a development
build (`TestApi`).

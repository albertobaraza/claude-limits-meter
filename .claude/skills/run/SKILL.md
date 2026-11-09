---
name: run
description: "Run this VS Code extension to see a change working: open a development window with it loaded, check it against the live usage endpoint, or run it in a headless real VS Code. USE FOR: run the extension, see it working, try it, does it work, check the change in the real app. DO NOT USE FOR: the unit tests alone (npm test) or releasing (see the release skill)."
allowed-tools: Bash(npm run *) Bash(npm test) Bash(xvfb-run *) Bash(code *) Bash(node scripts/smoke.js) Read
---

# Run Skill

The extension is a status-bar item inside VS Code, so "running" it means one of three things. Pick by what needs proving.

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
so it uses no login and makes no network call. On macOS or Windows leave off `xvfb-run`. A VS Code terminal sets
`ELECTRON_RUN_AS_NODE`; the runner clears it.

## 3. See the status bar with your own eyes

```bash
npm run compile
code --extensionDevelopmentPath="$PWD"
```

(or press **F5** in VS Code). A second window opens with the extension loaded and this machine's real login: the item shows
`✦ <percent> DEV` bottom right on an orange background (any build that is not the installed one marks itself, so it cannot be
mistaken for the installed extension); hover for the summary, click for the details. Reload it with *Developer: Reload Window* after a code
change, or run `npm run watch` in another terminal. In WSL or a remote window, `code` opens the window on the Windows side
and loads the extension from the remote, which is the case `extensionKind: workspace` exists for.

The screen cannot be read from a script (VS Code exposes no API to read a status-bar item), so when a change affects what
the item *says*, test `src/view.ts` instead: it is pure and `test/unit/view.test.js` asserts the exact text.

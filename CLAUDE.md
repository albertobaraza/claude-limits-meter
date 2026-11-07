# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

An unofficial VS Code extension that shows a Claude Code login's **5-hour session** and **7-day weekly** usage in the
status bar (`README.md` has the user-facing description). It reads Claude Code's own login (a credentials file, or the
macOS Keychain) and asks Anthropic's undocumented `/api/oauth/usage` endpoint for the numbers. It is a small,
dependency-free TypeScript extension: there is no server and no runtime dependency, and keeping it that way is part of its
security story.

## Setup

```bash
bash scripts/setup.sh      # checks Node (22+), installs dependencies and the git hooks
```

## Commands

```bash
npm run compile            # tsc -> out/
npm run typecheck          # tsc --noEmit
npm test                   # unit tests (node:test, no VS Code needed); also what the pre-push hook runs
npm run test:coverage      # the same with the coverage gate CI enforces (90% lines, 85% branches, 80% functions)
npm run test:package       # what `vsce package` would ship: exactly the files it should, nothing else
xvfb-run -a npm run test:integration   # loads the extension in a real VS Code (drop xvfb-run off Linux);
                                       # VSCODE_VERSION=1.85.0 for the oldest supported version
npm run package            # builds claude-usage-statusbar-<version>.vsix
```

To see a change working, open the folder in VS Code and press **F5** (`.vscode/launch.json`), or use the `run` skill.
Running from a VS Code terminal sets `ELECTRON_RUN_AS_NODE`, which `test/integration/run.js` clears.

## Architecture

Four modules in `src/`, three of them with no `vscode` import so plain node tests them:

- **`claude.ts`**: where the login is read from (macOS Keychain, then `~/.claude/.credentials.json`; the file only on
  Linux, Windows, WSL and remote hosts), the opt-in token renewal, the usage request, and the formatting helpers
  (`bar`, `pctText`, `timeLeft`). `ClaudeClient` takes every environment-dependent thing (paths, URLs, platform, `exec`,
  clock) as an option, which is how the tests run it against a mock server and a stubbed `security` command.
- **`state.ts`**: the `State` (`loading | ok | noCreds | expired | error`, plus the last good reading) and `check()`, which
  turns one request into the next state and never throws.
- **`view.ts`**: a `State` as status-bar text, tooltip Markdown and click-menu entries. Pure strings.
- **`extension.ts`**: the VS Code glue only: the status-bar item, the timer (60 s, skipped while the window is
  unfocused), the commands and the settings. Keep logic out of it; it is covered by the integration test, not the unit tests.

`extensionKind` is `workspace`: the extension must run where Claude Code's login is (WSL, Remote-SSH, a container), not on
the UI side.

### Rules that are not negotiable

- **Never log, display or put a token in an error.** `HttpError` carries a status code and no response body, on purpose.
  The Output channel shows messages, never credentials.
- **Never write to the macOS Keychain, and never renew a Keychain login.** Refresh tokens rotate; renewing without being
  able to store the new one logs Claude Code out. Renewal (`refreshExpiredToken`) is off by default and file-only.
- **If a renewed login cannot be written back, keep it in memory and warn**: the old refresh token is already dead.
- **The login is re-read on every check**, so a token Claude Code renewed meanwhile is picked up with no action here.
- **No runtime dependencies.** `devDependencies` only. A new runtime dependency needs a reason in the PR.
- **The only hosts contacted** are `api.anthropic.com` (usage) and, when renewal is on, `console.anthropic.com`. No
  telemetry. `README.md` ("Privacy and security") says so; change one, change the other.
- Anything shown from an error goes through `escapeMarkdown` (the tooltip is trusted Markdown with command links).
- Windows and macOS are first-class: no shell-outs except `security` through `execFile` (no shell), paths through
  `path`, and no assumption about file modes (`chmod` is a no-op on Windows).

## Tests

`test/unit/` mirrors `src/` and `scripts/` (run against the compiled `out/`); `test/integration/` is the real-VS-Code
smoke test (`suite.js` runs inside VS Code with no framework). A change to `claude.ts`, `state.ts` or `view.ts` comes with
a test; the coverage gate in CI fails below the thresholds. There is no linter: `tsc` in strict mode is the static check.

## Conventions

There are two ways of working. In **interactive mode** (the default), Claude never runs `git push`, period: tracked
branch or brand new, mid-skill or not, with or without confirmation (`.claude/settings.json` denies it too). Pushing is the
user's own action; if a skill needs a branch pushed before it can continue, it stops and asks the user to push it. Claude
also never merges a pull request and never publishes (`vsce publish`, `npm publish`): a merge releases, and publishing is
the user's call. **Nobody pushes to `main`**: it is reached by merging a pull request (the `no-push-to-main` and
`no-commit-to-branch` hooks, and `scripts/protect-main.sh` on GitHub once the repo is public).

Contribution workflow (branch names, commit style, hooks, changelog, PRs) is in [CONTRIBUTING.md](CONTRIBUTING.md): follow
it instead of improvising. Never add a `Co-Authored-By` trailer.

## CI/CD

- `.github/workflows/test.yaml`: on every PR and before every release. Typecheck and unit tests on Linux, macOS and Windows;
  on Linux also the coverage gate, the package-contents check and `npm audit` (high and up); and the integration test in
  a real VS Code (1.85.0 and stable on Linux, stable on macOS and Windows).
- `.github/workflows/ci.yml`: on PRs to `main`: `package.json`'s version matches the top `CHANGELOG.md` entry, and a change to
  `src/` or `package.json` has a version no release has used and a changelog entry (`scripts/release-metadata.js`); every
  commit is a conventional one-liner (`scripts/check-commit-message.js`); the pre-commit hygiene hooks; `actionlint` over
  the workflows; and a Gitleaks scan of the full history.
- `.github/workflows/release.yaml`: on push to `main`, runs `test.yaml`, then cuts `vX.Y.Z` as a GitHub release (changelog
  section as notes, `.vsix` attached) if that version has none. Publishing to the Marketplace is a second job that runs
  only when the `PUBLISH_TO_MARKETPLACE` variable is `true` and the `VSCE_PAT` secret exists (`docs/RELEASING.md`).
- `.github/dependabot.yml`: one weekly PR covering npm and the workflow actions.

Use the `changelog` skill to bump the version and add the entry before merging to `main`: both the CI check and the
release workflow depend on it. `CHANGELOG.md` is shown on the Marketplace page, so write it for users, not for developers.

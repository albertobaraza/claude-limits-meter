# Contributing

This document covers the day-to-day workflow. See the [README](README.md) for what the extension does,
[docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) for how it behaves in detail (checks, rate limits, several windows, token
renewal) and [CLAUDE.md](CLAUDE.md) for how the code is organised.

## Setup

```bash
bash scripts/setup.sh
```

It checks Node (22+), installs the dependencies and, if [pre-commit](https://pre-commit.com) is installed
(`pipx install pre-commit`), the git hooks below. Then see *Running it* to watch a change work.

## Running it

- **F5** in VS Code runs the extension in a development window (`.vscode/launch.json`). The status-bar item says `DEV`.
- `./scripts/run.sh` (Docker) starts a VS Code in your browser on http://localhost:8788 with the packaged extension, and a mock Claude with a control page on
  http://localhost:4010 where you change what the usage API answers (a reading, 429, 401, 500) and the login on the
  machine, and watch the status bar react. Nothing real is involved: no Claude login and no call to Anthropic. Ctrl+C stops it.
- To build the `.vsix` and install it in your own VS Code:

  ```bash
  npm ci --ignore-scripts
  npm run package                 # produces claude-limits-meter-<version>.vsix
  code --install-extension claude-limits-meter-*.vsix
  ```

The logic that does not need VS Code lives in `src/claude.ts`, `src/state.ts`, `src/shared.ts` and `src/view.ts` and is
unit-tested; `src/extension.ts` is only the status-bar glue. The commands that test it are under *Tests* below.

## Branching

`main` is the only long-lived branch and **nobody pushes to it**: it is reached by merging a pull request.

- Branch off `main` for all changes.
- Use the format `<issue-id-or-NO-ISSUE>/<short-description>` (e.g. `42/keychain-prompt-hint`, `NO-ISSUE/typo-fix`).
- Create branches with `--no-track` (`git checkout -b <name> --no-track`), so a later plain `git push` can never land on
  `main`. `scripts/setup.sh` also sets `branch.autoSetupMerge false` for this checkout.
- Direct commits to `main` are blocked by a pre-commit hook, and a push whose destination is `main` by a pre-push hook.
  On GitHub the same rule is branch protection, which `scripts/protect-main.sh` sets once the repository is public.

## Commit style

Every commit is a one-liner, using the same convention as the [`commit`](.claude/skills/commit) skill:

```
feat: Keychain login read on macOS
fix: expired token no longer shown as a failure
docs: token renewal explained in the README
```

Valid types: `feat`, `fix`, `chore`, `docs`, `refactor`, `style`, `test`. Split unrelated concerns into separate
commits. Never add a `Co-Authored-By` trailer. The `commit-msg` hook and CI both check this
(`scripts/check-commit-message.js`).

| Type       | Use for                                                                  |
| ---------- | ------------------------------------------------------------------------ |
| `feat`     | A new feature or capability                                              |
| `fix`      | A bug fix                                                                |
| `docs`     | Documentation-only changes                                               |
| `style`    | Cosmetic changes only (formatting, whitespace), no logic change          |
| `refactor` | Restructuring code without changing its behavior                         |
| `chore`    | Build process, CI, tooling or other maintenance that doesn't touch the extension |
| `test`     | Adding or updating tests                                                 |

> **Note:** the `commit` skill can do this for you.

## Git hooks

`bash scripts/setup.sh` installs them for the commit, commit-msg and push stages. To run the commit-stage ones against
everything: `pre-commit run --all-files`.

| Hook | Stage | Purpose |
| --- | --- | --- |
| `check-yaml`, `check-json`, `check-merge-conflict`, `check-added-large-files` | commit | Syntax and accident checks |
| `end-of-file-fixer`, `trailing-whitespace` | commit | Whitespace hygiene |
| `no-commit-to-branch` | commit | Blocks direct commits to `main` |
| `commit-message` (local) | commit-msg | `<type>: <description>` one-liner, no `Co-Authored-By` |
| `no-push-to-main` (local) | push | Blocks a push whose destination is `main`, from any branch |
| `typecheck`, `unit tests` (local) | push | `npm run typecheck`, `npm test` |

The integration test, the coverage gate and the package check run in CI, not on push.

## Tests

| Command | What it covers |
| --- | --- |
| `npm test` | Unit tests of `claude.ts`, `state.ts`, `shared.ts`, `view.ts` and the scripts, against a mock server and a stubbed `security` command |
| `npm run test:coverage` | The same, failing under 90% lines / 85% branches / 80% functions |
| `npm run test:package` | The `.vsix` holds what it should and nothing else |
| `xvfb-run -a npm run test:integration` | The extension loaded in a real VS Code with a fake login and a fake Claude API: activates, registers its commands, has its settings, and shows the right status-bar item for no login, a reading, 429, 401, 500, a renewed login, and another window's reading or 429 |
| `xvfb-run -a -s "-screen 0 1280x800x24" npm run test:ui` | The packaged `.vsix` installed in a real VS Code and driven through its window (Playwright): the status-bar item, its hover and its menu, with screenshots in `.vscode-test/screenshots` |
| `npm run test:integration:docker` | Both of the above in a clean Linux container (`test/ui/Dockerfile`, Node 22, Xvfb). A local convenience; CI uses the native runners |

Both real-VS-Code tests run on a throwaway profile and HOME, and strip the `VSCODE_*` variables a VS Code terminal sets,
so they never touch your own VS Code or your Claude login. Keep it that way: never run the `code` CLI from a test without
`cleanEnv()` (`test/integration/common.js`).

A change to the logic comes with a test. Code that needs the `vscode` API stays in `src/extension.ts` and stays thin.

## Changelog and releases

Run the `changelog` skill ([`.claude/skills/changelog`](.claude/skills/changelog)) on your branch before merging to
`main`. It updates [`CHANGELOG.md`](CHANGELOG.md) with a new entry and bumps `version` in `package.json` (and the lock
file) to match.

To do it by hand instead:

1. Add an entry directly below the intro of `CHANGELOG.md`, following
   [Keep a Changelog](https://keepachangelog.com/en/1.1.0/):

   ```markdown
   ## [X.Y.Z] - YYYY-MM-DD

   ### Added

   - ...
   ```

   Only include the sections (`Added`/`Changed`/`Fixed`/`Removed`) that have bullets, and describe each change by its
   effect for a user: the Marketplace page shows this file.

2. Bump the version to match, following [SemVer](https://semver.org/spec/v2.0.0.html): **major** for a breaking
   change, **minor** for a new feature, **patch** for anything else. When in doubt, patch.
   `npm version X.Y.Z --no-git-tag-version` sets it in `package-lock.json` too.

3. Commit those files together: `chore: bump version to X.Y.Z and update CHANGELOG`.

CI enforces this on every PR: `package.json`'s version must match the top `CHANGELOG.md` entry, and a change to `src/`
or `package.json` needs a version that has no release yet. Docs, tests and CI changes need no entry.

Once the bump lands on `main`, `release.yaml` publishes the GitHub release (and, if switched on, the Marketplace
listing) by itself. [docs/RELEASING.md](docs/RELEASING.md) has the details and how to switch Marketplace publishing on.

## Pull requests

Open a pull request against `main` using the [`pr`](.claude/skills/pr) skill (or by hand). CI runs automatically:

- [`test.yaml`](.github/workflows/test.yaml): typecheck and unit tests on Linux, macOS and Windows, the coverage gate,
  the package check, `npm audit`, the integration test in VS Code 1.125.0 and stable, and the UI test of the packaged
  `.vsix` on Linux (screenshots are kept as a build artifact).
- [`ci.yml`](.github/workflows/ci.yml): release metadata, commit messages, file hygiene, `actionlint` on the workflows,
  and Gitleaks over the full history.

The [`ci`](.claude/skills/ci) skill reports how those jobs are doing. [Dependabot](.github/dependabot.yml) opens one
weekly PR covering npm and the workflow actions.

### Title

A plain description of the branch's overall change, under 70 characters.

### Description

GitHub pre-fills the description with the `Summary`/`Test plan` [template](.github/pull_request_template.md); fill it in
reflecting the branch's net effect, and keep the test plan to manual-verification steps only: skip anything already
covered by CI. If the branch name starts with an issue number (`42/...`), start the description with `Resolves #42`.

> **Note:** the `pr` skill can do all of this for you.

## Claude Code

The project carries instructions for Claude Code in [CLAUDE.md](CLAUDE.md) and skills in `.claude/skills/`: `commit`,
`pr`, `changelog`, `ci`, `run`, `release`, `todo` and `security-audit` (see "Security review" below). By default Claude works with you: its skills confirm before
committing or opening a pull request, and **you push**. `.claude/settings.json` denies Claude `git push`, `gh pr merge`
and publishing.

The `todo` skill keeps a local, untracked `TODO.md` at the repo root as a scratch backlog: it turns the entries into
GitHub issues (on the "Claude" project board, with a priority) and clears them from the file.

## Security review

Claude Code's built-in `/security-review` reads only the pending diff, so it cannot ask how the checks we already have
combine into a way in. For that this repo carries Cloudflare's
[`security-audit` skill](https://github.com/cloudflare/security-audit-skill) (MIT) in
[`.claude/skills/security-audit`](.claude/skills/security-audit), an unchanged copy pinned to the upstream commit named in
its [`UPSTREAM.md`](.claude/skills/security-audit/UPSTREAM.md), which also says how to update it. It tells an agent to
run things, so read what changed upstream before moving the pin. (If the built-in stops with "ambiguous argument
'origin/HEAD...'", the clone has no remote HEAD: `git remote set-head origin main` sets it, locally and without the network.)

**Who is lower-trust here**, which the skill asks before it calls anything a vulnerability:

- the network, and whatever answers for `api.anthropic.com` and `console.anthropic.com` (a proxy, a captive portal);
- the repository open in the window: its `.vscode/settings.json` and files are written by someone other than the user;
- other accounts on a shared machine (who can read the credentials file), and anyone who can open a pull request or run the
  release workflow.

Other extensions and anything else running as the user are not a boundary: they can already read `~/.claude`
([`SECURITY.md`](SECURITY.md), "Out of scope"). [`CLAUDE.md`](CLAUDE.md) ("Rules that are not negotiable") and
`SECURITY.md` ("In scope") say what we promise about tokens, and decide what we fix.

**Run `/security-audit` on any branch that touches** `src/claude.ts`, `src/extension.ts`, `package.json`'s settings,
`.github/workflows/` or `scripts/`, and point it at the checklists that fit the change. They are in the skill's folder:

| Change | Checklist |
| --- | --- |
| The login: reading the credentials file or the Keychain, writing a renewed one back | [`DESKTOP-MOBILE-AND-LOCAL-IPC.md`](.claude/skills/security-audit/DESKTOP-MOBILE-AND-LOCAL-IPC.md) (local-file and credential-store classes) |
| The requests to Anthropic: the token refresh, the usage call, redirects, what an error or response may carry | [`WEB-PROTOCOL-AND-AUTH.md`](.claude/skills/security-audit/WEB-PROTOCOL-AND-AUTH.md) (token and key exposure; the identity classes mostly do not apply, we are a client) |
| Workflows, `release.yaml`, trusted publishing, Dependabot, the `.vsix` contents (`.vscodeignore`) | [`SUPPLY-CHAIN-AND-RELEASE.md`](.claude/skills/security-audit/SUPPLY-CHAIN-AND-RELEASE.md) (CI, release authorization, plugin trust) |
| Text from outside shown in the tooltip or menu | [`ATTACK-CLASSES.md`](.claude/skills/security-audit/ATTACK-CLASSES.md) (injection); the browser-only classes in `CLIENT-SIDE.md` do not apply |

Memory safety, the RPC, cloud, AI and data-isolation checklists do not apply here.

The skill's bar is higher than `SECURITY.md`'s scope, and that is on purpose. It confirms a finding only when a
lower-trust principal crosses a boundary and gets something; a gap that needs a network position, or that is only missing
hardening, comes back as `needs_validation` or not at all. It also runs the target's code only inside an OS-enforced
sandbox, and without one it says what it could not check: `npm test` and `npm run test:integration` are how a fix is
proven here. Three rules from the skill hold for any security review, whatever tool does it:

- **Only confirm a boundary that actually fails.** Name who is lower-trust, what they send, the control that should
  stop them, and what they get. A guess about how it is deployed is a question to check, not a finding.
- **Severity needs impact.** It cannot be higher than what was shown, and harm only to the person who caused it is not
  a vulnerability.
- **A missing defence-in-depth layer is not a finding.** A mutable dependency, a missing header or a best practice not
  followed is only one when it opens a path that ends somewhere that matters.

**A full audit** (ask Claude to "security audit this codebase": the skill's complete six-phase run over the whole repo,
with its output left in its default folder, `~/security-audit-skill/claude-limits-meter/`, outside the repo and never
committed) is costly: do not run it for every PR. The `quick` profile fits a repo this size. Run it again after a big
change to the attack surface, such as a new request, a new place the login is written, or a change to the release
workflow, and keep the run folder between runs, since each run reads the last one's ledger and goes after what it missed.
Confirmed findings become issues of their own; the ones it cannot settle (`needs_validation`) become questions.

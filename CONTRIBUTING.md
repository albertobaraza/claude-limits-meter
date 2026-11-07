# Contributing

This document covers the day-to-day workflow. See the [README](README.md) for what the extension does and
[CLAUDE.md](CLAUDE.md) for how the code is organised.

## Setup

```bash
bash scripts/setup.sh
```

It checks Node (20+), installs the dependencies and, if [pre-commit](https://pre-commit.com) is installed
(`pipx install pre-commit`), the git hooks below. Press **F5** in VS Code to run the extension in a development window.

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
| `npm test` | Unit tests of `claude.ts`, `state.ts`, `view.ts` and the scripts, against a mock server and a stubbed `security` command |
| `npm run test:coverage` | The same, failing under 90% lines / 85% branches / 80% functions |
| `npm run test:package` | The `.vsix` holds what it should and nothing else |
| `xvfb-run -a npm run test:integration` | The extension loaded in a real VS Code: activates, registers its commands, has its settings |

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
  the package check, `npm audit`, and the integration test in VS Code 1.85.0 and stable.
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
`pr`, `changelog`, `ci`, `run` and `release`. By default Claude works with you: its skills confirm before committing or
opening a pull request, and **you push**. `.claude/settings.json` denies Claude `git push`, `gh pr merge` and publishing.

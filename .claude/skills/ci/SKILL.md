---
name: ci
description: "Check the CI status for the current branch, and fix any failure locally: pull the actual error from the failing job, reproduce it locally, edit the code, and verify the fix. USE FOR: check CI, CI status, did CI pass, check the pipeline, check build status, why did CI fail, fix CI. DO NOT USE FOR: creating a PR (see the pr skill), committing or pushing the fix (stop once it's verified locally, see the commit skill)."
allowed-tools: Bash(git *) Bash(gh pr *) Bash(gh run *) Bash(gh api *) Bash(gh auth *) Bash(npm run *) Bash(npm test) Bash(npx *) Bash(node scripts/*) Bash(xvfb-run *) Bash(pre-commit *) Read Edit Grep Glob
---

# CI Status Skill

Check this repo's CI status for the current branch, and fix whatever's failing.

## Repo-specific context

Workflows live in `.github/workflows/`. Don't assume which jobs exist or what triggers them: read them. Each
workflow's `on:` block decides when it runs. `test.yaml` and `ci.yml` run on pull requests only, so a branch with no PR
has no results yet. `release.yaml` runs on pushes to `main`, never on a branch.

The jobs, and the command that reproduces each one locally:

| Job (as shown on the PR) | Reproduce with |
| --- | --- |
| Unit tests (any OS) | `npm run typecheck`, then `npm test` |
| Unit tests (ubuntu): coverage gate | `npm run test:coverage` |
| Unit tests (ubuntu): package contents | `npm run test:package` |
| Unit tests (ubuntu): audit | `npm audit --audit-level=high` |
| VS Code 1.125.0 / stable | `xvfb-run -a npm run test:integration` (`VSCODE_VERSION=1.125.0` for the old one; no `xvfb-run` on macOS or Windows) |
| Changelog & version | `node scripts/release-metadata.js check-changelog` and `... check-unreleased origin/main` |
| Commit messages | `node scripts/check-commit-message.js --range origin/main..HEAD` |
| File hygiene | `pre-commit run --all-files` |
| Workflows | `actionlint` (not installed here: read the failure from the log) |
| Secrets | Gitleaks over the full history: no local repro, see below |

## Workflow

### Step 1: Get the CI status

```bash
git branch --show-current
gh pr view --json number,url,state 2>&1
```

- **A PR exists:** `gh pr checks --json name,state,bucket,link,workflow` lists every check on it.
- **No PR:** `gh run list --branch <current-branch> --limit 10 --json databaseId,workflowName,event,status,conclusion` lists any push-triggered runs. If there are none, tell the user CI hasn't run yet (the workflows are `pull_request`-only) and offer to run the `pr` skill instead of guessing at a workaround.

If everything is still pending/in progress, say so and stop. Don't busy-poll in a sleep loop. If the user wants to wait live, suggest `gh pr checks --watch` (or `gh run watch <run-id>`). A job GitHub skipped isn't a failure: note it as skipped.

### Step 2: For any failed job, get the actual error

```bash
gh run view <run-id> --log-failed
```

`--log-failed` fetches only the failing steps' output. Read the actual failing step/assertion, not just "job X failed".

### Step 3: Reproduce and fix each failure locally

The failing step's own `run:` *is* the local repro: it's the exact command CI ran. Run it locally first, to confirm you're looking at the same problem, before editing anything. A few things that can lead to:

- If the check is "version doesn't match the changelog" or "this version is already released", the fix is running the `changelog` skill, not hand-editing either file.
- If a commit message is rejected, the commit has to be reworded. That rewrites history on the branch, so don't do it: tell the user which commits and why, and let them decide.
- If it's a secret-scan finding (Gitleaks), don't just delete the flagged line. Report the file/line and let the user decide whether it's a real secret (which needs rotating, not just removing) or a false positive.
- If the integration test fails only on macOS or Windows, there's no local repro on this machine: read the log and reason from the platform difference (paths, line endings, file modes, `security`).
- If it depends on secrets or permissions only CI has (publishing, releases), there's no local repro: report the error instead of guessing at a fix.

Once reproduced, edit the code, then re-run the exact same command until it passes. If the job's check is broader than the one failure reported, re-run its full command, not just the narrowest repro of that one error.

### Step 4: Report

Summarize per job: pass/fail/pending/skipped. For anything fixed in Step 3, say what was changed and confirm the local command now passes. For anything not fixed (no local repro, or the fix needs judgment you can't make), give the specific error pulled from Step 2: failing test name, type error, advisory id. Not just "the job failed, see logs".

## Notes

- This skill fixes failures locally and verifies them with the matching local command. It does not commit or push. Once a fix is verified, stop and let the user decide when to commit (see the `commit` skill).
- If `gh auth status` fails, tell the user and stop rather than working around it.

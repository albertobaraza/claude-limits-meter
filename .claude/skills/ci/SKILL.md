---
name: ci
description: "Check the CI status for the current branch, and fix any failure locally: pull the actual error from the failing job, reproduce it locally, edit the code, and verify the fix. USE FOR: check CI, CI status, did CI pass, check the pipeline, check build status, why did CI fail, fix CI. DO NOT USE FOR: creating a PR (see the pr skill), committing or pushing the fix (stop once it's verified locally - see the commit skill)."
allowed-tools: Bash(git *) Bash(gh pr *) Bash(gh run *) Bash(gh api *) Bash(gh auth *) Bash(npm run *) Bash(npm test) Bash(npx *) Bash(ruff *) Bash(pytest *) Bash(poetry run *) Bash(pre-commit *) Bash(shellcheck *) Read Edit Grep Glob
---

# CI Status Skill

Check this repo's CI status for the current branch, and fix whatever's failing.

## Repo-specific context

Workflows live in `.github/workflows/*.yml`. Don't assume which jobs exist or what triggers them:
read them. Each workflow's `on:` block decides when it runs: a `pull_request`-only workflow has no
results until the branch has an open PR, while a `push` one runs on every push. Path filters
(`paths:`) can also mean a workflow legitimately never ran for this branch.

A step with `uses: albertorga/ci/actions/<action>@<ref>` is a shared composite action from the
[ci](https://github.com/albertorga/ci) repo, and its one-line `uses:` isn't the actual check. If
such a job's purpose or failure isn't obvious from its name/log (Step 2 below), read its
definition at the exact ref pinned in the workflow (`actions/<action>/action.yml`, plus any script
it runs, e.g. `scripts/internal/*.sh`) from a local `ci` checkout alongside this repo if one
exists (`git -C ../ci show <ref>:actions/<action>/action.yml`), otherwise via
`gh api "repos/albertorga/ci/contents/actions/<action>/action.yml?ref=<ref>" --jq .content | base64 -d`.
Don't read `ci`'s `main` branch: it can be ahead of what this repo actually pins.

## Workflow

### Step 1: Get the CI status

```bash
git branch --show-current
gh pr view --json number,url,state 2>&1
```

- **A PR exists:** `gh pr checks --json name,state,bucket,link,workflow` lists every check on it.
- **No PR:** `gh run list --branch <current-branch> --limit 10 --json databaseId,workflowName,event,status,conclusion`
  lists any push-triggered runs. If there are none, check the workflows' `on:` blocks: if they're
  `pull_request`-only, tell the user CI hasn't run yet and offer to run the `pr` skill instead of
  guessing at a workaround.

If everything is still pending/in progress, say so and stop; don't busy-poll in a sleep loop. If
the user wants to wait live, suggest `gh pr checks --watch` (or `gh run watch <run-id>`), or offer
to check again when asked. A job GitHub skipped (a path filter, an `if:` condition, a skip
label) isn't a failure: note it as skipped.

### Step 2: For any failed job, get the actual error

```bash
gh run view <run-id> --log-failed
```

`--log-failed` fetches only the failing steps' output, not the entire run log. Read the actual
failing step/assertion, not just "job X failed".

### Step 3: Reproduce and fix each failure locally

The failing step's own `run:` (or, for a shared action, the script its `action.yml` runs; see
"Repo-specific context") *is* the local repro: it's the exact command CI ran. Run it locally
first, to confirm you're looking at the same problem, before editing anything. A few things that
command can lead to:

- If it runs inside a container or service you can't easily reproduce locally (e.g. an image
  vulnerability scan), reproduce the underlying intent instead with whatever this repo's own
  tooling provides for that (its `scripts/`, a `docker build`), rather than trying to replicate
  the CI runner.
- If the check is "does `CHANGELOG.md` have a new entry" or "does the version file match
  `CHANGELOG.md`'s latest entry", the fix is running the `changelog` skill, not hand-editing
  either file.
- If it's a secret-scan finding (e.g. Gitleaks), don't just delete the flagged line: report the
  file/line and let the user decide whether it's a real secret (which needs rotating, not just
  removing) or a false positive.
- If the check is about registry/release state (does an image/package for this version already
  exist, publishing, tagging a release) or depends on secrets/permissions only CI has, there's no
  local repro, so report the error instead of guessing at a fix.

Once reproduced, edit the code, then re-run the exact same command until it passes. If the job's
check is broader than the one failure reported (e.g. a test job covering a whole directory, not
just the file that failed), re-run its full command, not just the narrowest repro of that one
error.

### Step 4: Report

Summarize per job: pass/fail/pending/skipped. For anything fixed in Step 3, say what was changed
and confirm the local command now passes. For anything not fixed (no local repro, or the fix
needs judgment you can't make), give the specific error pulled from Step 2 (failing test name,
type error, lint rule, CVE id), not just "the job failed, see logs".

## Notes

- This skill fixes failures locally and verifies them with the matching local command - it does not commit or push. Once a fix is verified, stop there; committing and pushing it is the `commit` skill.
- If `gh auth status` fails, tell the user and stop rather than working around it.

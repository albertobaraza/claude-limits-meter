---
name: pr
description: "Create a GitHub pull request for the current branch, or refresh one that's already open. Drafts a title and a Summary/Test plan body from every commit ahead of the base branch (not just the latest), auto-links the branch's GitHub issue with a Resolves line when the branch follows this repo's <issue>/<description> naming convention, and opens it. If a PR is already open for this branch, redrafts its body from the current commit range and updates it instead of creating a duplicate. Rebases the branch onto the base if it is behind, and pushes it. Runs the changelog skill first when CI's changelog check would fail the pull request. Stops only for an anomaly (see the commit skill). USE FOR: create PR, open a PR, make a pull request, submit a PR, refresh a PR's description. DO NOT USE FOR: reviewing an existing PR (see the code-review skill), merging, or checking CI status (see the ci skill)."
allowed-tools: Bash(git *) Bash(gh pr *) Bash(gh repo *) Bash(gh issue view *) Bash(gh auth *) Bash(gh api *) Bash(grep *) Read Grep Glob Skill(changelog)
---

# Create Pull Request Skill

Open a pull request for the current branch against this repo's base branch.

## Workflow

### Step 1: Resolve the base branch

`<base>` is `main`.

If the current branch IS `<base>`, stop and tell the user a PR needs a feature branch, not `<base>` itself.

### Step 2: Check for an existing PR

Run:

```bash
gh pr list --head <current-branch> --state open --json number,url,title
```

If one is already open for this branch, note its actual link — the `url` field from the JSON
output, not just the PR number — and continue through Steps 3–7 to redraft the body from the
full commit range: commits may have landed since the PR was opened, and this is the skill's
chance to catch a body that went stale. Step 8 updates that existing PR instead of
creating a duplicate.

### Step 3: Understand the full change, not just the latest commit

Run in parallel:

```bash
git status
git diff <base>...HEAD --stat
git log <base>..HEAD --oneline
git log <base>..HEAD --pretty=format:"%s%n%b"
```

If the last command's output is empty, stop and tell the user there's nothing to open a PR for (no commits ahead of `<base>`).

Read **every** commit in the range, not just the most recent one. A PR description that only reflects the last commit misleads reviewers about everything else the branch changes.

### Step 4: Rebase onto the base, then push

```bash
git fetch origin
git rev-list --count HEAD..@{u} 2>&1      # commits the remote has that this branch lacks
git rev-list --count HEAD..origin/<base>  # commits the base has that this branch lacks
```

1. The remote branch has commits this branch lacks: an anomaly, stop and tell the user.
2. The base is ahead: `git rebase origin/<base>`. Resolve a conflict yourself only when it is mechanical: both sides'
   additions kept side by side, or this branch's release renumbered above the base's top version in `CHANGELOG.md` and
   the version file (the `changelog` skill's `<version-file>`, and its lock file when that carries the version too),
   keeping both entries. Anything where the two sides change the same logic, or where you are unsure, is an anomaly:
   `git rebase --abort`, then stop and tell the user which files conflict.
3. Push as in the `commit` skill's step 6 when there is no upstream or the branch is ahead. When the rebase rewrote
   commits already on the remote, push with `git push --force-with-lease`: the only force the skills allow, only on the
   feature branch and only straight after this rebase.
4. Nothing to rebase or push: continue.

### Step 5: Run the `changelog` skill when CI will ask for it

CI may hold a pull request to a release entry, and one opened without it fails that check on its first run. Find out
before opening it, the way the `ci` skill reads CI (its "Repo-specific context"): read `.github/workflows/*.yml` for a
job that runs on a pull request to `<base>` and checks `CHANGELOG.md` or the version file, and read a shared action
(`uses: albertorga/ci/actions/...`) at the ref the workflow pins, not from its name. No such job, or no `changelog`
skill in this repo: skip this step.

That job's own commands are the test (the `ci` skill's Step 3: a step's `run:`, or the script a shared action runs, is
its local repro). Run them against `origin/<base>`, which Step 4 just fetched. The paths come from the workflow each
time, never from a list copied here. Such a job usually asks one or both of two things:

```bash
# 1. the version file and the top entry of CHANGELOG.md say the same version
grep -m1 '^## \[' CHANGELOG.md   # set against the version in the `changelog` skill's `<version-file>`
# 2. a branch that changes a watched path (the job's own list, e.g. its `watched-paths` input) adds an entry
git diff --name-only origin/<base>...HEAD -- <watched-paths>
git diff origin/<base>...HEAD -- CHANGELOG.md | grep -E '^\+## \['
```

The `changelog` skill is needed when:

- either check would fail: the two versions differ, or a watched path changed and the branch adds no entry; or
- the entry is there and has fallen behind: a watched path changed in a commit after the last one that touched
  `CHANGELOG.md`.
  ```bash
  last=$(git log -1 --format=%H origin/<base>..HEAD -- CHANGELOG.md)
  git diff --name-only "$last"..HEAD -- <watched-paths>
  ```

An open pull request is no different: this is where the commits pushed since it was opened get their entry.

- **Not needed:** say so in one line (no watched path changed, or the entry is there and current) and continue.
- **Needed:** run the `changelog` skill now, whole and as it is written, reading its `<base>` as `origin/<base>`: the
  local `<base>` may be behind what Step 4 rebased onto, and the skill would then count the base's own commits as this
  branch's. It commits and pushes, and on a branch that already has an entry it replaces that entry in place. Then run
  the checks above once more and continue with Step 6. If the skill stopped, or the checks still fail after it, that is
  an anomaly: stop and tell the user, with the output. Never hand-edit `CHANGELOG.md` or the version file to get past
  the check.

### Step 6: Detect a linked issue from the branch name

This repo's `commit` skill names branches `<issue-id-or-NO-ISSUE>/<short-description>` (e.g.
`17/fix-artifact-registry-cleanup-policy`, `NO-ISSUE/generalize-deploy-teardown-skills`). Check:

```bash
git branch --show-current
```

- If the branch starts with digits immediately followed by `/` (e.g. `17/...`), extract the
  number and confirm an issue with that number actually exists before trusting it:
  ```bash
  gh issue view <N> --json number,state,title
  ```
  If it resolves, carry `<N>` into Step 7 — the PR body will open with `Resolves #<N>`. If the
  lookup fails (deleted issue, typo, or the number actually belongs to a PR rather than an
  issue), treat it exactly like no issue was found: skip linking silently. Never guess or fall
  back to a nearby issue number.
- If the branch starts with `NO-ISSUE/`, or doesn't match the `<digits>/` pattern at all (a
  manually named branch), there's no issue to link. Skip this step.

### Step 7: Draft the PR

- **Title**: under 70 characters, describing the branch's overall change (not just the last commit).
- **Body**: if Step 6 confirmed an issue number, start the body with `Resolves #<N>` and a blank
  line, then the structure below. Otherwise start directly at `## Summary`. The structure mirrors
  the repo's `.github/pull_request_template.md`, if it has one.

```markdown
Resolves #<N>

## Summary
- <bullet per logically distinct change, grouped by theme if the branch spans several>

## Test plan
- [ ] <manual step a reviewer still needs to do, e.g. running the feature that was fixed/changed/added>
```

Rules:
- Only ever include a `Resolves #<N>` line when Step 6 confirmed that issue exists — never add one
  speculatively, and never add more than the one issue Step 6 found.
- Reflect the **net effect** of the branch, the same way the `changelog` skill filters out intra-branch noise (a commit that only fixes a mistake introduced earlier in this same branch doesn't need its own bullet).
- The test plan is manual-verification only. Leave out anything already covered by a CI job (lint, typecheck, tests, the checks listed under CI/CD in this repo's CLAUDE.md) — reviewers can already see those pass on the PR. Only list checks that need a human, like exercising the feature that changed.
- No fluff, no restating commit hashes, no "this PR".
- **Do not** add a "Generated with Claude Code" footer, a Co-Authored-By line, or any AI-attribution text. This repo's `commit` skill forbids the same, and it applies here too.

### Step 8: Create or update the PR

**No existing PR:**

```bash
gh pr create --base <base> --head <current-branch> --title "<title>" --body "$(cat <<'EOF'
<body>
EOF
)" --assignee "@me"
```

`--assignee "@me"` assigns the PR to the authenticated user by default.

**Existing PR:** update only its body, leaving the title, assignee, and everything else as-is:

```bash
gh pr edit <current-branch> --body "$(cat <<'EOF'
<body>
EOF
)"
```

Either way, report the PR's URL.

## Notes

- Never skip hooks. Never push directly to `<base>`. Never force-push, other than Step 4's `--force-with-lease` after its own rebase. Never merge the pull request: that is the user's, after reading it.
- The only reasons to stop are the `commit` skill's anomalies, Step 5's, or `gh auth status` failing: tell the user rather than working around it.
- Step 5 is the only place this skill starts another one. It runs `changelog` because CI would fail without it, not on every pull request: a branch that changes nothing CI watches gets no release entry from here.
- The `Resolves #<N>` auto-link (Step 6) only fires off a confirmed-existing issue parsed from the
  branch name — it never fabricates or guesses a number. Refreshing an open PR's body (Step 8)
  redrafts it the same way, so a `Resolves #<N>` line is kept or added under the same rule.

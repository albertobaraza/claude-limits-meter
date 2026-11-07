---
name: pr
description: "Create a GitHub pull request for the current branch, or refresh one that's already open. Drafts a title and a Summary/Test plan body from every commit ahead of the base branch (not just the latest), auto-links the branch's GitHub issue with a Resolves line when the branch follows this repo's <issue>/<description> naming convention, and confirms with the user before opening or updating it. If a PR is already open for this branch, redrafts its body from the current commit range and offers to update it instead of creating a duplicate. Stops and asks the user to push first if the branch isn't up to date on the remote: this skill never pushes. USE FOR: create PR, open a PR, make a pull request, submit a PR, refresh a PR's description. DO NOT USE FOR: reviewing an existing PR (see the code-review skill), merging, or checking CI status (see the ci skill)."
allowed-tools: Bash(git *) Bash(gh pr *) Bash(gh repo *) Bash(gh issue view *) Bash(gh auth *) AskUserQuestion
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

If one is already open for this branch, note its actual link (the `url` field from the JSON
output, not just the PR number) and continue through Steps 3-6 to redraft the body from the
full commit range: commits may have landed since the PR was opened, and this is the skill's
chance to catch a body that went stale. Step 7 onward updates that existing PR instead of
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

### Step 4: Check the branch is pushed

Check whether the current branch tracks a remote and is up to date:

```bash
git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>&1
git status
```

- No upstream, or upstream exists but local is ahead: stop the skill. Tell the user the branch
  needs to be pushed before a PR can be opened (or refreshed) and that they need to do it
  themselves (`git push -u origin <current-branch>`).
- Already up to date: continue.

This skill never runs `git push` itself, not even with confirmation. Pushing, whether creating the
remote branch or updating it, is the user's own action.

### Step 5: Detect a linked issue from the branch name

This repo's `commit` skill names branches `<issue-id-or-NO-ISSUE>/<short-description>` (e.g.
`17/keychain-prompt-hint`, `NO-ISSUE/typo-fix`). Check:

```bash
git branch --show-current
```

- If the branch starts with digits immediately followed by `/` (e.g. `17/...`), extract the
  number and confirm an issue with that number actually exists before trusting it:
  ```bash
  gh issue view <N> --json number,state,title
  ```
  If it resolves, carry `<N>` into Step 6: the PR body will open with `Resolves #<N>`. If the
  lookup fails (deleted issue, typo, or the number actually belongs to a PR rather than an
  issue), treat it exactly like no issue was found: skip linking silently. Never guess or fall
  back to a nearby issue number.
- If the branch starts with `NO-ISSUE/`, or doesn't match the `<digits>/` pattern at all (a
  manually named branch), there's no issue to link. Skip this step.

### Step 6: Draft the PR

- **Title**: under 70 characters, describing the branch's overall change (not just the last commit).
- **Body**: if Step 5 confirmed an issue number, start the body with `Resolves #<N>` and a blank
  line, then the structure below. Otherwise start directly at `## Summary`. The structure mirrors
  the repo's `.github/pull_request_template.md`.

```markdown
Resolves #<N>

## Summary
- <bullet per logically distinct change, grouped by theme if the branch spans several>

## Test plan
- [ ] <manual step a reviewer still needs to do, e.g. pressing F5 and checking the status bar>
```

Rules:
- Only ever include a `Resolves #<N>` line when Step 5 confirmed that issue exists. Never add it
  speculatively, and never add more than the one issue Step 5 found.
- Reflect the **net effect** of the branch, the same way the `changelog` skill filters out intra-branch noise (a commit that only fixes a mistake introduced earlier in this same branch doesn't need its own bullet).
- The test plan is manual-verification only. Leave out anything already covered by a CI job (typecheck, unit tests, the integration test, the checks listed under CI/CD in CLAUDE.md): reviewers can already see those pass on the PR. Only list checks that need a human, like exercising the feature that changed.
- No fluff, no restating commit hashes, no "this PR".
- **Do not** add a "Generated with Claude Code" footer, a Co-Authored-By line, or any AI-attribution text. This repo's `commit` skill forbids the same, and it applies here too.

### Step 7: Confirm before opening or updating

- **No existing PR** (per Step 2): present the drafted title and body (including the
  `Resolves #<N>` line, if present) to the user, then use `AskUserQuestion` with two options:
  **Confirm** and **Cancel**. Do not call `gh pr create` until the user confirms.
- **Existing PR** (per Step 2): present the drafted body to the user as a proposed update to the
  open PR (the title isn't touched, only the body), then use `AskUserQuestion` with two options:
  **Confirm** and **Cancel**. Do not call `gh pr edit` until the user confirms.

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

Either way, report the PR's actual URL back to the user.

## Notes

- Never force-push. Never skip hooks. Never push directly to `<base>`. Never merge: a merge to `<base>` cuts a release.
- This skill never pushes: not the initial push, not an update push, confirmed or not. That's the user's action; the skill only checks and, if needed, asks them to do it.
- If `gh auth status` fails, tell the user and stop rather than working around it.
- The `Resolves #<N>` auto-link (Step 5) only fires off a confirmed-existing issue parsed from the
  branch name. Refreshing an open PR's body (Step 8) redrafts it the same way, so a `Resolves #<N>`
  line is kept or added under the same rule.

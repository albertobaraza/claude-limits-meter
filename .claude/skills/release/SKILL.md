---
name: release
description: "Report where a release stands after a merge to main: the release workflow's run, the GitHub release and its .vsix, and the Marketplace listing, and say what to do about anything missing. USE FOR: did the release go out, is it published, release status, why wasn't it released, check the Marketplace, what version is live. DO NOT USE FOR: preparing a release (see the changelog skill), publishing (the user does that), or CI on a branch (see the ci skill)."
allowed-tools: Bash(gh run *) Bash(gh release *) Bash(gh variable list) Bash(gh secret list) Bash(gh auth *) Bash(git tag *) Bash(git log *) Bash(npx vsce show *) Bash(node scripts/release-metadata.js *) Read
---

# Release Skill

A release happens by itself when a pull request that bumped the version is merged to `main` (`docs/RELEASING.md`). This
skill only looks, and explains. It never publishes, tags or merges (`.claude/settings.json` denies those).

## Workflow

### Step 1: What version is meant, and what exists

```bash
node scripts/release-metadata.js version
gh release list --limit 5
git tag -l 'v*' --sort=-v:refname | head -5
```

If `package.json`'s version has no release, either the merge is still running or it didn't bump (go to Step 2).

### Step 2: The workflow run

```bash
gh run list --workflow release.yaml --limit 5 --json databaseId,status,conclusion,headSha,event,createdAt
```

- **In progress:** say so and stop. Don't poll in a loop.
- **Failed:** `gh run view <id> --log-failed`. Usual causes: the test workflow failed on the merged commit (fix forward with a PR);
  `check-changelog` failed (version and changelog disagree: a PR that fixes them); nothing to publish.
- **Succeeded but no release:** the version already had a release (the merge did not change `src/` or `package.json`). That is
  correct for docs, tests and CI changes. If it *should* have released, the PR forgot the bump: the `changelog` skill, a new PR.

### Step 3: The release

```bash
gh release view v<version> --json tagName,name,publishedAt,assets --jq '{tagName,publishedAt,assets:[.assets[].name]}'
```

It should hold `claude-usage-statusbar-<version>.vsix`, and its notes should equal the matching `CHANGELOG.md` section.

### Step 4: The Marketplace, if switched on

```bash
gh variable list
gh secret list
```

- `PUBLISH_TO_MARKETPLACE` is not `true`: publishing is off (the default). Say so; it is the user's choice to turn on.
- It is `true` and `VSCE_PAT` is listed: check the live version with `npx vsce show <publisher>.<name> --json` (the `versions[0].version`).
  If it is behind the release, the publish job failed or hasn't run: `gh run view <id> --log-failed`, then the user can retry with
  `gh workflow run release.yaml`. A `401`/`403` in the log is an expired or wrongly scoped token (`docs/RELEASING.md` has the scopes).

### Step 5: Report

One line per stage (workflow, GitHub release, Marketplace): done, in progress, off, or failed with the specific error. For
anything the user must do (renew a token, merge a fix), say exactly what.

---
name: changelog
description: "Prepare a new changelog release entry before merging a branch to main. Reads commits since main, infers the version bump (major/minor/patch) from commit content, updates CHANGELOG.md, updates the version in package.json (and package-lock.json), then creates a final changelog commit. Merging that to main is what releases it. USE FOR: release, changelog, version bump, bump version, new release, prepare release, merge to main. DO NOT USE FOR: creating feature branches, running tests, or publishing."
allowed-tools: Bash(git log *) Bash(git show *) Bash(git diff *) Bash(git branch *) Bash(git add *) Bash(git commit *) Bash(npm version *) Bash(node scripts/release-metadata.js *) Bash(date *) Read Edit
---

# Changelog Release Skill

Prepare a changelog release entry for the current branch before merging to the base branch. `CHANGELOG.md` is read by the
extension's users (the Marketplace page shows it), so an entry says what changed *for them*, not how it was built.
Merging the bump to `main` is what cuts the release (`.github/workflows/release.yaml`), so this skill's output matters.

## Workflow

### Step 1: Resolve conventions

**Important:** All git commands must run from the root of the repository where this skill is installed. If the current working directory is a different repo, switch to the correct one before proceeding.

`<base>` is `main`.
`<version-file>` is `package.json`.

If the current branch IS `<base>`, stop and tell the user this skill must be run from a feature branch, not `<base>` itself.

### Step 2: Discover commits since the base branch

```bash
git log <base>..HEAD --oneline
```

If the output is empty, stop and tell the user there are no commits ahead of `<base>`: nothing to release.

### Step 3: Infer the version bump type

Read the full diff and commit messages carefully:

```bash
git log <base>..HEAD --pretty=format:"%s%n%b"
```

**First, filter out intra-branch noise.** Before deciding the bump type or drafting bullets, identify commits that have no net effect on `<base>`:

- A commit that fixes a mistake introduced by an earlier commit *on this same branch* (e.g. "fix path added in previous commit"). Both the original mistake and its fix cancel out: omit both from the changelog and do not let them influence the bump type.
- A feature that was added and then fully reverted within the branch: omit both.
- Use the commit message wording and the diff context to judge: if a `fix:` commit's diff only touches code that didn't exist on `<base>` before this branch, it is intra-branch noise.

Also exclude this branch's own prior `chore: bump version to ... and update CHANGELOG` commit(s), if any (see Step 4). That commit is this skill's own previous output, not a new change.

Only the **net changes** relative to `<base>` determine the bump type and the changelog content.

Decide the bump type:

| Signal in commits | Bump |
|---|---|
| Breaking change: a setting or command removed or renamed, a different place the login is read from, a raised minimum VS Code | **major** |
| New feature: a new setting, command, platform or thing shown | **minor** |
| Bug fix, documentation, refactor with no new features, dependency update | **patch** |

While the version is `0.x`, a breaking change may bump the minor instead. When in doubt, default to **patch**.

**Does it ship at all?** Only `src/` and `package.json` ship. If the net changes touch neither (docs, tests, CI, tooling), stop and tell the user: such a branch needs no release, and CI does not ask for one.

### Step 4: Read the baseline version and detect a prior in-branch release

Always read the baseline version from `<base>`, not the working tree, because the working tree may already carry an unreleased bump from an earlier run of this skill on the same branch:

```bash
git show <base>:package.json | grep -m1 '"version"'
```

Then check whether this skill already ran on this branch:

```bash
git diff <base>...HEAD -- CHANGELOG.md
```

- **No diff, or the diff doesn't touch the topmost `## [` entry**: first run on this branch. Step 6 inserts a brand new entry above whatever is currently topmost.
- **The topmost `## [` entry in the working tree doesn't exist in `<base>`'s CHANGELOG.md**: this skill already ran on this branch, and that entry is still unreleased. Do not stack a second version bump on top of it. Step 6 replaces that entry in place, using the bump type computed from **all** net changes since `<base>` (Step 3).

Compute the new version by applying the bump to `<base>`'s version (never to whatever version is currently in the working tree):
- **major**: increment X, reset Y and Z to 0
- **minor**: increment Y, reset Z to 0
- **patch**: increment Z

The exception is a `<base>` version that has no release yet (`git tag -l v<version>` prints nothing, and `<base>`'s changelog has it): then that version is still free and is the one to use, with the entry added to it.

### Step 5: Draft the changelog entry

The changelog follows two standards:
- **[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)**: entry structure, section names, and writing style
- **[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)**: version bump rules

Read the existing `CHANGELOG.md` to match the established writing style. Use today's date (`date +%Y-%m-%d`) for the entry header.

Rules:
- Only include sections (`### Added`, `### Changed`, `### Fixed`, `### Removed`) that have at least one bullet.
- Write bullets in the same terse style as existing entries. No fluff, no "this commit", no author names.
- Describe each change by its effect for someone using the extension, not by how it was implemented.
- Omit changelog, version bump, docs, test, CI and tooling commits from the bullet list.
- Omit intra-branch noise identified in Step 3.

Proceed directly to updating the files and creating the commit. Do not ask for confirmation first.

### Step 6: Update CHANGELOG.md

- **First run** (per Step 4): insert the new entry directly after the intro, above the previous topmost `## [` entry.
- **Re-run** (per Step 4): replace the existing topmost `## [` entry (heading and body) with the freshly drafted one, in place, leaving exactly one heading with no stale entry left behind.

The entry format is exactly this (CI and the release workflow parse the heading):

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added

- ...

### Fixed

- ...
```

### Step 7: Update the version in package.json

Set the new version with npm, which updates `"version"` in both `package.json` and `package-lock.json` together. Editing `package.json` by hand leaves the lock file behind:

```bash
npm version X.Y.Z --no-git-tag-version --allow-same-version
```

`--no-git-tag-version` stops npm from committing or tagging (the release workflow tags), and `--allow-same-version` keeps a re-run from failing when the version is unchanged.

Then verify, which is the same check CI runs:

```bash
node scripts/release-metadata.js check-changelog
```

### Step 8: Create the changelog commit

Stage only the files this skill changed and create the commit:

```bash
git add CHANGELOG.md package.json package-lock.json
git commit -m "chore: bump version to X.Y.Z and update CHANGELOG"
```

Do not push. Tell the user the commit was created, show the changelog entry that was written, and confirm the branch is ready to merge. On a re-run (per Step 4), this creates a new commit whose content supersedes the prior changelog commit's: that's expected, never amend the old one.

## Error handling

- If `package.json` is not found, tell the user and stop.
- If `CHANGELOG.md` is not found, offer to create it with the standard header before proceeding.
- Never amend existing commits. Always create a new one.

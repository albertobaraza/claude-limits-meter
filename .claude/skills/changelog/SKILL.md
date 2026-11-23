---
name: changelog
description: "Prepare a new changelog release entry before merging a branch to main. Reads commits since main, infers the version bump (major/minor/patch) from commit content, updates CHANGELOG.md (and, where the repo keeps them, the release notes its users read, in plain words) and the version in package.json (and package-lock.json), then creates a final changelog commit and pushes it. USE FOR: release, changelog, version bump, bump version, new release, prepare release, merge to main. DO NOT USE FOR: creating feature branches, running tests, or deploying."
---

# Changelog Release Skill

Prepare a changelog release entry for the current branch before merging to the base branch.

## Workflow

### Step 1 – Resolve conventions

**Important:** All git commands must run from the root of the repository where this skill is installed. If the current working directory is a different repo, switch to the correct one before proceeding.

`<base>` is `main`.
`<version-file>` is `package.json`.
`<public-notes>` is `none`.

If the current branch IS `<base>`, stop and tell the user this skill must be run from a feature branch, not `<base>` itself.

### Step 2 – Discover commits since the base branch

Run the following to get all commits on this branch not yet on `<base>`:

```bash
git log <base>..HEAD --oneline
```

If the output is empty, stop and tell the user there are no commits ahead of `<base>`: nothing to release.

### Step 3 – Infer the version bump type

Read the full diff and commit messages carefully:

```bash
git log <base>..HEAD --pretty=format:"%s%n%b"
```

**First, filter out intra-branch noise.** Before deciding the bump type or drafting bullets, identify commits that have no net effect on `<base>`:

- A commit that fixes a mistake introduced by an earlier commit *on this same branch* (e.g. "fix path added in previous commit", "add missing import forgotten earlier", "fix CI variable introduced in this branch"). Both the original mistake and its fix cancel out: omit both from the changelog and do not let them influence the bump type.
- A feature that was added and then fully reverted within the branch: omit both.
- Use the commit message wording and the diff context to judge: if a `fix:` commit's diff only touches code that didn't exist on `<base>` before this branch, it is intra-branch noise.

Also exclude this branch's own prior `chore: bump version to ... and update CHANGELOG` commit(s),
if any (see Step 4). That commit is this skill's own previous output, not a new change, so it
must not influence the bump type or appear in the drafted bullets.

Only the **net changes** relative to `<base>` determine the bump type and the changelog content.

Apply these rules to decide the bump type:

| Signal in commits | Bump |
|---|---|
| Breaking change, API removal, major refactor that changes public interface | **major** |
| New feature, new public function/class/command, new pipeline, new entity | **minor** |
| Bug fix, documentation, refactor with no new features, dependency update | **patch** |

When in doubt, default to **patch**.

### Step 4 – Read the baseline version and detect a prior in-branch release

Always read the baseline version from `<base>`, not the working tree: the working tree may
already carry an unreleased bump from an earlier run of this skill on the same branch:

```bash
git show <base>:<version-file> | grep -m1 '"version"'
```

Then check whether this skill already ran on this branch:

```bash
git diff <base>...HEAD -- CHANGELOG.md
```

- **No diff, or the diff doesn't touch the topmost `## [` entry**: first run on this branch.
  Proceed normally: Step 6 inserts a brand new entry above whatever is currently topmost.
- **The topmost `## [` entry in the working tree doesn't exist in `<base>`'s CHANGELOG.md**: this
  skill already ran on this branch, and that entry is still unreleased (only on this branch, not
  yet on `<base>`). Do not stack a second version bump on top of it. Instead, Step 6 replaces that
  entry in place, using the bump type computed from **all** net changes since `<base>` (Step 3),
  not just the changes made since the prior run.

Compute the new version by applying the bump from Step 3 to `<base>`'s version (never to whatever
version is currently in the working tree's `<version-file>`):
- **major**: increment X, reset Y and Z to 0
- **minor**: increment Y, reset Z to 0
- **patch**: increment Z

### Step 5 – Draft and apply the changelog entry

The changelog follows two standards:
- **[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)**: entry structure, section names, and writing style
- **[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)**: version bump rules

Read the existing `CHANGELOG.md` to match the established writing style.

Use today's date (from the `currentDate` context or `date +%Y-%m-%d`) for the entry header.

Draft the new entry based on the **net changes** identified in Step 3. Rules:
- Only include sections (`### Added`, `### Changed`, `### Fixed`, `### Removed`) that have at least one bullet.
- Write bullets in the same terse style as existing entries: no fluff, no "this commit", no author names.
- Describe each change by its effect, not the mechanics of how it was implemented. This is
  about phrasing, not exclusion: every net change belongs, including an internal-only fix, as
  long as it actually affects behavior (per SemVer, a "bug fix" is by definition an internal
  change that fixes incorrect behavior).
- Omit any changelog, version bump, or docs-only commits from the bullet list.
- Omit intra-branch noise identified in Step 3: these have no impact on `<base>` and do not belong in the changelog.

### Step 6 – Update CHANGELOG.md

- **First run** (per Step 4): insert the new entry directly after the `# Changelog` header block
  (after the preamble lines that end before the first `## [` entry).
- **Re-run** (per Step 4): replace the existing topmost `## [` entry (heading and body) with the
  freshly drafted one, in place, leaving exactly one heading with no stale entry left behind.

The entry format is:

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added

- ...

### Fixed

- ...
```

### Step 7 – Write the public entry (if `<public-notes>` is not `none`)

`<public-notes>` names where the product tells its own users what changed, in their words (a What's new page, release
notes in the app; one file per language it speaks). When it is `none`, skip this step. A release then has two accounts
of the same changes: `CHANGELOG.md`, for whoever works on the repo, and this one, for whoever uses the product, told in
another voice: a title and a few plain sentences for each change a user would notice, not the engineering bullets.

Read the first entries of each file to match their format and voice, and the test that holds them, if there is one (to
`CHANGELOG.md`'s versions and dates, to each other, to a style): its rules come with the files' format.

**What goes in a release**

- **Same release as Step 6:** the same version and date. First run (per Step 4): insert the entry at the top of every
  file. Re-run: replace the topmost entry in place if its version is the one unreleased on this branch, so there is
  never a second one stacked above it.
- **Only what a user can see or do differently.** Leave out CI, deploys, scripts, docs, tests, refactors, file formats
  and internal names. A fix to something a user never saw is not news to them.
- **If nothing in the release is visible to a user**, add no entry to any file, and say so in the final report. Never
  write an entry to fill the gap.

**How each change is told** (lead with what the reader can now do, in the words of someone using the product)

- **What kind of change it is to the reader**, where the format names kinds: new (something they can do that they could
  not), improved (something they already did, now better), changed (works differently, or is gone, without being
  better). A bug that is mended is not an item but a fix.
- **A title is a name, not a sentence:** sentence case, no full stop. For something new, say what they can do, starting
  with a verb; for the rest, name the thing.
- **The text says what it is and why it matters,** benefit first, to the reader (you) and in the present tense. It is
  never shortened to drop a fact the reader needs (what is kept about them, a limit, what to do). It is the change as a
  user would meet it, reworded from the `CHANGELOG.md` bullet and not copied from it; several bullets of one idea are
  one item.
- **Fixes are batched,** a sentence each, with no title: what was wrong and what happens now.
- **No jargon, and the names the product uses today,** read from its user-facing text (its message catalogs, its
  screens), not from the code.
- **Each language is written for its own readers,** in the register the product already uses, not translated word by
  word, and each file speaks only its own language.

Print every entry in the final report.

### Step 8 – Update version in `<version-file>`

Set it with npm, which updates `package.json` and `package-lock.json` together (`--no-git-tag-version` stops npm from
committing or tagging, `--allow-same-version` keeps a re-run from failing):

```bash
npm version X.Y.Z --no-git-tag-version --allow-same-version
```

Verify the edit looks correct before committing.

### Step 9 – Create the changelog commit

Stage only the files this skill changed (the `<public-notes>` files only when Step 7 wrote an entry) and create the
commit:

```bash
git add CHANGELOG.md <version-file> package-lock.json   # plus the <public-notes> files Step 7 wrote
git commit -m "chore: bump version to X.Y.Z and update CHANGELOG"
```

### Step 10 – Push

Push the branch as in the `commit` skill's step 6; its limits and anomalies apply.

Tell the user the commit was created and pushed, show the changelog entry that was written (and the public entries,
or that the release had nothing for a user), and confirm the branch is ready to merge. On a re-run (per Step 4), this creates a new commit whose content supersedes the prior changelog commit's. That's expected; never amend the old one (see below).

## Error handling

- If `<version-file>` is not found, tell the user and stop.
- If `CHANGELOG.md` is not found, offer to create it with a standard header before proceeding.
- If a `<public-notes>` file is not found, tell the user and stop: Step 7 has nowhere to write.
- Never amend existing commits; always create a new one.

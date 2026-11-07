---
name: commit
description: Stage and commit all changes using the project's commit style. Trigger when the user says "commit", "make a commit", "commit the changes", "save the changes", "git commit", or any similar phrasing asking to record current work into git history.
allowed-tools: Bash(git status) Bash(git diff) Bash(git branch *) Bash(git checkout *) Bash(git add *) Bash(git commit *) AskUserQuestion
---

Stage and commit all changes. Follow the rules and steps below strictly.

## Format rules

Every commit is a **one-liner**:
```
feat: Keychain login read on macOS
fix: typo corrected in config
```

Valid types: `feat`, `fix`, `chore`, `docs`, `refactor` (logic restructure), `style` (cosmetic only), `test`. CI and tooling changes are `chore`.

Never write "Co-Authored-By" lines. The `commit-msg` hook and CI reject them, and any subject that is not `<type>: <description>`.

## Never push

Never run `git push`, regardless of how the user phrases the request ("commit and push", "push this up", etc.). Pushing is the user's call to make, not Claude's, and `.claude/settings.json` denies it. Create the commit(s) and stop there; if the user's message also asked for a push, tell them the commit is ready and that they'll need to push it themselves.

Never bypass the git hooks (`--no-verify`). If a hook rejects the commit, fix what it names and commit again.

## 1. Check what changed

Run `git status` and `git diff` to understand what changed.

## 2. Resolve the branch

Check the current branch with `git branch --show-current`. `<base>` is `main`. Never commit
directly to `<base>`: if the current branch is `<base>`, resolve a feature branch first (see
below), then continue to step 3. Otherwise, go straight to step 3.

### If on the base branch

1. Ask the user for the GitHub issue number behind this work, using `AskUserQuestion` with a
   `NO-ISSUE` option. The user can instead type an issue number via "Other" (e.g. `42`).
2. From the diff already gathered in step 1, generate a short kebab-case description of the
   change (e.g. `add-run-skill`).
3. Create and switch to the branch locally. This never touches the remote, same as the commit
   itself. Always add `--no-track`, so the new branch starts with no upstream at all no matter
   what local git config is in play: it must never end up tracking `<base>`'s upstream, since a
   later plain `git push` would then land straight on `<base>`:
   ```bash
   git checkout -b <issue-id-or-NO-ISSUE>/<short-description> --no-track
   ```
4. Verify it actually worked before doing anything else: run `git branch --show-current` again
   and confirm it prints the new branch name, not `<base>`. If the checkout failed (e.g. a branch
   with that name already exists) and you're still on `<base>`, stop and tell the user instead of
   continuing. Never fall through to staging or committing while still on `<base>`.
5. Continue to step 3 on this new branch.

## 3. Group into logical commits

Group the changes into logical commits: aim for 2-4 focused commits rather than one large one.

**Prefer multiple focused commits over one large commit.** When changes span logically distinct concerns (different features, different layers, different bug fixes), split them into separate commits, each staged and committed independently.

Ask yourself: *can these changes be described by more than one clear sentence?* If yes, split.

Examples of good splits:
- Logic change in `src/claude.ts` → one commit; the test for it → another
- Two unrelated bug fixes → two commits
- New feature + unrelated chore → two commits

Only bundle everything into one commit if the changes are truly inseparable (e.g. a rename that touches 20 files, or a single atomic feature with tightly coupled parts).

## 4. Confirm the plan

Present the planned commits as a numbered list in your response text, before calling the tool.
Then call `AskUserQuestion` with a short question (e.g. "Proceed with these commits?") and
exactly two options labeled **Confirm** and **Cancel**, with no descriptions. Never embed the
commit list itself in the question or option text. Do not proceed until the user selects an
option.

Example list before the question:
```
1. feat: expired state shown in the status bar: state.ts, view.ts
2. test: expired state covered: state.test.js, view.test.js
3. docs: expired state explained: README.md
```

## 5. Stage and commit

Before doing anything else in this step, run `git branch --show-current` one more time and
confirm it is still not `<base>`. If it somehow is, stop immediately rather than committing.

If the user selects **Cancel**, stop. If they select **Confirm**, for each group: stage only
those files with `git add <files>`, then commit using a HEREDOC so formatting is preserved:

```bash
git commit -m "$(cat <<'EOF'
<message here>
EOF
)"
```

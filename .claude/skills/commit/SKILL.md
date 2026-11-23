---
name: commit
description: Stage and commit all changes using the project's commit style, then push the feature branch; stops only for an anomaly (see Anomalies). Trigger when the user says "commit", "make a commit", "commit the changes", "save the changes", "git commit", "commit and push", or any similar phrasing asking to record current work into git history.
allowed-tools: Bash(git status) Bash(git diff) Bash(git branch *) Bash(git checkout *) Bash(git add *) Bash(git commit *) Bash(git push *) Bash(git rev-parse *) Bash(git log *) Bash(git fetch *) AskUserQuestion
---

Stage and commit all changes, then push the feature branch. Follow the rules and steps below strictly.

## Format rules

Every commit is a **one-liner**:
```
feat: ABC added to XYZ
fix: typo corrected in config
```

Valid types: `feat`, `fix`, `chore`, `docs`, `refactor` (logic restructure), `style` (cosmetic only), `test`.

Never write "Co-Authored-By" lines.

## Limits

Never push to `<base>` or to a branch that tracks it, never force-push (the `pr` skill's rebase is the one exception),
never skip hooks (`--no-verify`), never amend a pushed commit, never merge a pull request.

Auto mode (`test -f "$(git rev-parse --git-common-dir)/auto-mode"` succeeds, or the brief says so; see the `auto`
skill, if this repo has it) changes one thing here: in step 2 the issue number is the one the work was started for (or
`NO-ISSUE`).

## 1. Check what changed

Run `git status` and `git diff` to understand what changed.

## 2. Resolve the branch

Check the current branch with `git branch --show-current`. `<base>` is `main`. Never commit
directly to `<base>` — if the current branch is `<base>`, resolve a feature branch first (see
below), then continue to step 3. Otherwise, go straight to step 3.

### If on the base branch

1. Take the GitHub issue number from the conversation if it names one. Otherwise ask with `AskUserQuestion` and a
   `NO-ISSUE` option; the user can type a number via "Other" (e.g. `42`).
2. From the diff already gathered in step 1, generate a short kebab-case description of the
   change (e.g. `add-run-skill`).
3. Create and switch to the branch locally — this never touches the remote, same as the commit
   itself. Always add `--no-track`, so the new branch starts with no upstream at all no matter
   what local git config is in play — it must never end up tracking `<base>`'s upstream, since a
   later plain `git push` would then land straight on `<base>`:
   ```bash
   git checkout -b <issue-id-or-NO-ISSUE>/<short-description> --no-track
   ```
4. Verify it actually worked before doing anything else: run `git branch --show-current` again
   and confirm it prints the new branch name, not `<base>`. If the checkout failed (e.g. a branch
   with that name already exists) and you're still on `<base>`, stop and tell the user instead of
   continuing — never fall through to staging or committing while still on `<base>`.
5. Continue to step 3 on this new branch.

## 3. Group into logical commits

Group the changes into logical commits — aim for 2–4 focused commits rather than one large one.

### Splitting into multiple commits

**Prefer multiple focused commits over one large commit.** When changes span logically distinct concerns — different features, different layers (backend vs frontend), different bug fixes — split them into separate commits, each staged and committed independently.

Ask yourself: *can these changes be described by more than one clear sentence?* If yes, split.

Examples of good splits:
- Backend API change → one commit; frontend consuming it → another
- Two unrelated bug fixes → two commits
- New feature + unrelated chore → two commits

Only bundle everything into one commit if the changes are truly inseparable (e.g. a rename that touches 20 files, or a single atomic feature with tightly coupled frontend/backend).

## 4. Print the plan

Print the planned commits as a numbered list, then go on to step 5:
```
1. feat: rotation detection and resolve-rotation endpoint — analyze.py, curate.py, state.py
2. feat: rotation UI with cache-busting — Curate.tsx, api.ts
3. fix: DD/MM/YYYY date format — StandardizeCards.tsx
```

## 5. Stage and commit

Before doing anything else in this step, run `git branch --show-current` one more time and
confirm it is still not `<base>`. If it somehow is, stop immediately rather than committing.

For each group, stage only its files with `git add <files>`, then commit using a HEREDOC:

```bash
git commit -m "$(cat <<'EOF'
<message here>
EOF
)"
```

## 6. Push

Check that the branch is not `<base>` and does not track it (`git rev-parse --abbrev-ref --symbolic-full-name @{u}`;
no upstream is fine), then push:

```bash
git push -u origin <current-branch>   # no upstream yet
git push                              # otherwise
```

The repo's pre-push hooks run here, when it has any and they are installed (the `stages: [pre-push]` hooks in
`.pre-commit-config.yaml`: `no-push-to-main`, plus whatever checks the repo runs on push). Report what was pushed in
one line.

## Anomalies

Stop and tell the user, without working around it, when:

- **Before committing:** on `<base>` with no issue number; a detached HEAD, or a merge, rebase or cherry-pick in
  progress; a change that looks like a secret (`.env`, a key, a token), data or generated output the repo keeps out of
  git on purpose, or a large or binary file nobody asked for; changes that plainly belong to other work.
- **A hook fails:** if the cause is plainly in this change (a lint or type error, a test it broke), fix it, make a new
  commit and push again, at most twice. Otherwise stop with the output.
- **The push fails:** rejected as non-fast-forward, the branch behind or diverged from its remote, no `origin`,
  authentication or permission failure, or the branch's pull request already merged or closed. Never answer with a
  force, a pull or a rebase.
- **`git status` is not clean after committing** for a reason you cannot explain.

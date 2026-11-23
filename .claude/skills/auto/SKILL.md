---
name: auto
description: "Switch auto mode on or off, or say whether it is on. While it is on, Claude picks open issues by priority on its own and works each in a subagent of its own, with the same skills the owner would use (commit, changelog, pr, ci), then goes on to the next, keeping one report in uncommitted/reports/ of what was done and the open points to review with the owner; an issue that cannot go on without the owner is parked there and the loop goes on with the others, never asking directly; given an issue number (/auto on 42), it works that one issue and stops. USE FOR: auto mode, /auto on, /auto on <issue>, /auto off, /auto status, work on the issues by yourself, resolve issue N by yourself, pick the next task yourself, keep going. DO NOT USE FOR: one task the owner is driving, merging or deploying (never done in auto mode), turning TODO.md into issues (see the todo skill)."
---

# Auto mode

Auto mode stands in for the owner's manual steps: choosing the next issue, starting the work, and watching CI. Everything
else is done by the same skills, under the same rules as when the owner drives (the `commit`, `changelog`, `pr` and `ci`
skills, CONTRIBUTING.md and CLAUDE.md). Auto mode has no git rules of its own.

`<base>` is `main`.
`<board>` is `6` and `<board-owner>` is `albertorga`: this repo's GitHub project board, **Claude**
(https://github.com/orgs/albertorga/projects/6), the one the `todo` skill uses, whose **Priority** field (`Urgent`/`High`/`Medium`/`Low`) orders the work.

`/auto on [N]`, `/auto off`, `/auto status`, and `/auto` alone to resume a loop whose flag is already on (a new session,
say). `N` is the number of an issue (`42` or `#42`): the one issue to resolve, chosen by the owner, after which the
loop stops. It is never a count of issues or of pull requests. Without it, issues are picked by Priority, one after
another, until something in step 5 stops the loop.

## The flag

Auto mode is on while this file exists. It is inside `.git`, so it is never committed and a worktree finds the same one:

```bash
FLAG="$(git rev-parse --git-common-dir)/auto-mode"
test -f "$FLAG" && echo on || echo off
```

`on`: write it, over one that is already there, with the start time, the issue named (if any), a count of pull
requests opened and the path of this run's report (`started=...`, `issue=N`, `done=0`, `report=...`; see "The report"),
and create the report. `off`: delete it (the report stays). `status`: print whether it exists, its lines, the report's
path and its Open points headings, and the open pull requests of mine (`gh pr list --author @me --state open`).

"Auto mode is on" means exactly this file exists, or the brief a worker was given says so.

## The report

Every run of auto mode keeps **one** report, a Markdown file at the root of the main checkout (not a worktree's), in
`uncommitted/reports/` (ignored by git, so it is never committed):

```bash
ROOT="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
REPORT="$ROOT/uncommitted/reports/auto-$(date -u +%Y-%m-%d-%H%M).md"
```

One issue named (`/auto on 42`) or many picked, it is the same single file for the whole run; `/auto` resuming a run
whose flag is on goes on writing the report the flag names. Only this session (the loop) writes it: a worker in its
worktree never touches it, and hands its points back in its reply (step 3), so several worktrees never write one file.

It has two sections, and under Open points a subsection per issue, headed by its identifier (`### #42 Title`, or
`### NO-ISSUE <branch>` for work that has none), where everything to look at together with the owner accumulates:

```markdown
# Auto mode, started 2026-11-19 10:30 UTC

## Summary

- #42 Title: PR #50 (link), CI green. 1 open point.
- #37 Title: parked, a blocking point waits on the owner (see its open points).
- #39 Title: PR #51 (link), CI green.
- Skipped when picking: #31 (a decision, "Decide..."), #35 (needs an account outside the repo).
- Stopped: no issue left that passes the tests. Answer #37's blocking point, then `/auto` carries it on.

## Open points

### #42 Title

- **To review.** The question, what was done meanwhile and why, the other options. Where: PR #50.

### #37 Title

- **Blocking.** The question, the options and a recommendation, and what is done so far. Where: branch
  `37/...`, worktree `<path>`, nothing pushed.
```

- **Summary**: one line per issue the run touched (pull request and the state of its CI, skipped, failed, parked), the
  issues left out when picking with the reason (step 2), and at the end why the loop stopped and how to resume.
  Rewrite it as the run goes on, so it always says where things are.
- **Open points**: only ever added to, never rewritten or dropped: a new point goes at the end of its issue's
  subsection, made when the issue first has one. Each point says whether it is **Blocking** or **To review**, the
  question, what was chosen or done meanwhile, the options with a recommendation, and where it can be seen (pull
  request, branch, worktree). A `FAILED` result is always an open point, with what was tried and the last error.

Write the report after every result (step 4) and before stopping (step 5), so that it is whole whenever the owner reads
it, and name its path in the message that ends the loop.

## What auto mode never does

Whatever the issue says: merge a pull request (a merge is what releases or deploys), deploy or tear down (the `deploy`
and `teardown` skills, where this repo has them), touch anything that lives outside the repo (a cloud project, a console,
a third party's account), read `.env`, print a secret, close an issue without a pull request, or edit what CLAUDE.md
calls non-negotiable.

## The loop

Run these cycles in this session. Before the first, `git fetch origin`, and make sure the working tree is clean
(if not, stop and say so).

### 1. Housekeeping

For each open pull request of mine that is `CONFLICTING` or failing (`gh pr list --author @me --state open --json
number,headRefName,mergeable,statusCheckRollup`), the cause is usually that the owner merged another one and the
version moved. Hand it to a worker (step 3) as a "refresh": run the `pr` skill on the branch, which rebases it onto
`<base>` and pushes it. A conflict it cannot resolve is a blocking point: it goes into the report under that pull
request's issue, the pull request is left as it is, and the loop goes on.

Then read the report for **Blocking** points the owner has answered (an answer under the point, or given in the
session). Each answered one is carried on before anything new is picked, as step 4 says, one at a time.

With an issue named, only that issue's own pull request is looked at here (one that says `Resolves #N`, or whose branch
starts `N/`); the others are left as they are.

### 2. Pick

`gh issue list --state open --limit 200 --json number,title,body,issueType,blockedBy` and
`gh project item-list <board> --owner <board-owner> --format json --limit 500` for Priority, keeping only the board
items whose `content.repository` is this repo (a board can hold several repos' issues, and their numbers overlap).
Take the first by Priority (Urgent, High, Medium, Low; lowest number first within one) that passes every test:

- It has a Priority. An issue without one is untriaged: leave it.
- No open pull request covers it (`gh pr list --state open --search "<number>"`, or a branch starting `<number>/`).
- Nothing open blocks it (`blockedBy`).
- It is not parked: no **Blocking** point of it in the report waits for an answer.
- It is work to do, not a choice to make: skip a title that starts with Decide, Explore, Brainstorm, Design or Rethink,
  and a body that asks for options or a recommendation before code.
- It can be done in the repo: skip what needs a cloud console, a third party's account or permission, a deploy, a
  measurement on the live product, or a legal opinion.
- It has not been tried and failed in this loop.

Keep the skipped ones with the reason in one line each, for the report's Summary. If nothing passes, stop (step 5).

**With an issue named** (`issue=N` in the flag), that issue is the pick, and the list above is not read: the owner chose
it, so it needs no Priority, and its title and what it asks for are not tested (a worker that finds a choice to make
goes on with its recommendation, or answers `NEEDS_DECISION` when it cannot go on without one, and one that finds work
outside the repo answers `SKIPPED`). Read it with
`gh issue view N --json number,title,body,state,issueType,blockedBy`, and stop (step 5), saying which, when:

- there is no issue with that number, or it is a pull request, or it is closed;
- an open pull request already covers it (after step 1 has refreshed one of mine that was stale);
- something open blocks it (`blockedBy`): name what.

Never pick another issue in its place.

### 3. Work

Start a subagent (`Agent`, `isolation: "worktree"`, general-purpose) with the brief below, the issue's number, title and
body, and the line "Auto mode is ON". It runs in the background; when its notification arrives, handle the result.
Never work two issues at once: they all bump the same version.

**Brief for the worker**, in this order:

1. Read the issue, CLAUDE.md and CONTRIBUTING.md, and the docs the issue points at. If the issue is already done, is
   not what its title says, or cannot be done in the repo (it needs a cloud console, a third party's account or
   permission, a deploy, a measurement on the live product or a legal opinion), stop with `SKIPPED` and why.
2. `git fetch origin <base> && git checkout -b <issue>/<short-kebab-description> --no-track origin/<base>`; then
   whatever a fresh checkout needs before its checks can run (CLAUDE.md's "Setup").
3. Do the work. For a bug, write the test that fails first, where the repo has tests. Follow CLAUDE.md's rules, the
   non-negotiable ones above all. Keep to the issue: no cleanups beside it.

   When something is the owner's call, tell which kind it is:
   - **It can wait for review**, because the choice can be undone in the pull request, which the owner reads before
     merging anyway: a product choice the issue leaves open, wording, a detail of the design, a change to what is
     shown that the issue does not settle. Go on with your recommendation, and keep the point (the question, what you
     chose and why, the other options) for the reply. Nothing else stops.
   - **It cannot go on without the owner**: a rule in CLAUDE.md that the issue seems to contradict, a change to what
     is stored about users or kept from a third party that the issue does not settle, a destructive or irreversible
     step, something only the owner can do or reach, or options so far apart that doing one would waste the work.
     Stop there and answer `NEEDS_DECISION` (step 7).
4. Run the checks CLAUDE.md's "Commands" and CONTRIBUTING.md name for a change like this one (lint, typecheck, tests,
   `pre-commit run --all-files`), the way CI runs them. When CONTRIBUTING.md has a "Security review" section, do what
   it asks of a branch that touches the paths it names.
5. The `commit` skill, the `changelog` skill (where this repo has one), then the `pr` skill. The pull request says
   `Resolves #<issue>`.
6. `gh pr checks <pr> --watch`. On a failure, follow the `ci` skill to find and reproduce the cause, fix it, then the
   `commit` skill, and watch again. At most three rounds.
7. Reply with one of these as the first line, then a few lines of detail, then `Open points:` and the points kept in
   step 3, one per line (or `Open points: none`):
   - `PR <url> green`
   - `NEEDS_DECISION` and the question, the options and a recommendation, what is done so far, the branch and the
     worktree's path (step 3 says when). Push nothing; leave the work in the worktree.
   - `FAILED` and what was tried, with the last error (CI still red after three rounds, a test it cannot make
     pass, a command refused by permissions or authentication, or any anomaly the `commit` skill lists).
   - `SKIPPED` and why.

### 4. After the result

First write the report: the issue's line in Summary, and the worker's open points, each as **To review**, at the end of
the issue's subsection.

- `PR ... green`: add 1 to `done` in the flag, print one line (`#N -> PR url`, and how many open points), go to cycle 1.
  If the issue was named, that was the whole loop: delete the flag and stop.
- `SKIPPED`: note it and pick again. If the issue was named, delete the flag and stop.
- `FAILED`: an open point with what was tried and the last error, and do not pick that issue again in this loop. Two
  failures in a row: stop. If the issue was named, stop at the first, and leave the flag, so that `/auto` tries it again.
- `NEEDS_DECISION`: add the question as a **Blocking** point (the options, the recommendation, what is done, the
  branch and the worktree), and park the issue: its work stays in its worktree, nothing is pushed, and it is not
  picked again until the owner answers. Never ask with `AskUserQuestion` or otherwise wait on the owner: the report is
  where the question waits. Go to cycle 1 and work the next issue meanwhile; a parked issue is not running, so this is
  still one issue at a time, and it does not count as a failure. If the issue was named, there is nothing else to do:
  stop, and leave the flag.

  **Carrying on a parked issue**, once the owner has answered (under the point in the report, or in the session; read
  at step 1): add the answer under the point, then send it to the same worker (`SendMessage`) if it is still
  reachable, or else start a worker with the brief, the answer and the line "Carry on in the worktree `<path>`, on
  the branch `<branch>`; rebase onto `origin/<base>` first", without `isolation`. Handle its result as above.

### 5. Stop

Stop when: no issue passes the tests (parked ones included) and no answered blocking point is left to carry on, the
named issue is done, parked or cannot be worked, two failures in a row (a blocking point, parked or for review, never
stops the loop on its own), the owner types something, `gh`/`git` authentication or permissions fail (do not work around them),
or the usage limits are close: the 5-hour session limit at 90% or the weekly limit at 95%. Check them before each
cycle (before picking an issue, and before sending a worker on after a decision), never in the middle of a worker's
run ("Reading the usage" below). If there is no way to read it, say so and ask the owner for the figures before each
cycle instead of assuming there is room. Name the limit that stopped the loop in the report. Leave the flag in place unless
the owner turned it off or the named issue ended with a green pull request or a `SKIPPED`, and say which. Bring the
report's Summary up to date (why the loop stopped, and how to resume: `/auto`, or `/auto on [N]` when the flag is gone),
then end with a short message: the report's full path, the pull requests opened (number, link, state of CI), what is
blocking and on what, and how many points are waiting to review together.

### Reading the usage

The [claude-limits-meter](https://github.com/albertobaraza/claude-limits-meter) VS Code extension (0.7.0 or later)
answers this from the shell when its `claudeLimitsMeter.commandLine` setting is on: it keeps its last reading in a
folder of the user's state, with a `claude-limits` command beside it, and the exit status is the answer.

```bash
CL="${XDG_STATE_HOME:-$HOME/.local/state}/claude-limits-meter/claude-limits.cjs"   # macOS: ~/Library/Application Support/claude-limits-meter/
test -f "$CL" && node "$CL" --fresh 120 --max-5h 90 --max-7d 95
```

- `0`: there is room; go on.
- `1`: a limit is reached; stop, and put the line it printed (both figures and when they reset) in the report.
- `2`, or no command there: it cannot tell (no reading, one too old, VS Code not running). Use the next way the session
  has of reading it, and failing that ask the owner, as above.

Always pass `--fresh`: VS Code does not check while it is not focused, which is exactly when auto mode runs. The
command reads only that folder: never the Claude login, and never the network.

## Notes

- Pull requests pile up unmerged, each branched from `<base>` and each with its own version. That is why housekeeping
  runs first: the owner's merge of one makes the next stale.
- A merge to `<base>` is what releases or deploys. Auto mode never merges; the owner does, after reading the pull
  request.
- The loop works only while a session is running it; the flag outlasts the session but nothing continues alone.

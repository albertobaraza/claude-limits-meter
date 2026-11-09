---
name: todo
description: "Turn the entries in the repo's TODO.md into GitHub issues, reusing or enriching existing issues that already cover the same scope, then clear the TODO file and list the open issues. USE FOR: todo, ticket, tickets, turn the TODO into issues, sync the TODO with GitHub, create issues from the TODO, what's open. DO NOT USE FOR: starting a feature branch (see the commit skill), opening a PR (see the pr skill)."
allowed-tools: Bash(find *) Bash(gh issue *) Bash(gh repo view *) Bash(gh project *) Bash(gh api graphql *) Read Write Edit
---

Sync the entries in `TODO.md` with this repo's GitHub issues and its project board. Follow the steps
below in order.

`<board>` is `6` and `<board-owner>` is `albertorga`: the project board **Claude**
(https://github.com/orgs/albertorga/projects/6), with one custom field, **Priority**
(`Urgent`/`High`/`Medium`/`Low`). Every step below references `<board>` and `<board-owner>`. The board
belongs to the `albertorga` organization while this repo is under a personal account, which is also why
`type` is a label here and not a GitHub issue type (issue types exist only on organization repos).

## 1. Find the TODO file

Look for it in the current repo:

```bash
find . -iname 'TODO.md' -not -path './.git/*' -not -path '*/node_modules/*'
```

Read it. If there's none, or it has no entries, skip to step 6 (still list the open issues). If
there's more than one, use all of them and say which files you used.

Each `##` heading starts one entry; its title is the heading text. Immediately below the heading,
a bullet list of `key: value` lines (keys: `type`, `priority`, `parent`, `blocked by`, `blocks`,
`relates to`) is that entry's properties; read it per `TODO.md`'s own preamble, which documents the
valid values. The first line that isn't such a bullet ends the property list; everything from there
to the next `##` heading (or end of file) is the entry's body text.

## 2. Load the existing issues and project items

```bash
gh issue list --state all --limit 200 --json number,title,body,state,labels,parent,blockedBy,blocking
gh project item-list <board> --owner <board-owner> --format json --limit 200
```

Open and closed issues both count: a closed issue that covers the entry means it's already been done
or decided, so don't recreate it. Tell the user about that match and leave the entry for them to
decide on (don't delete it in step 5).

From the project item list, note each issue's current `priority` (by its `content.number`): an entry
that omits `priority` gets `low` only on an issue that has none (step 4), and setting one again
is otherwise harmless. From the
issue list, note each issue's current `parent` and `blockedBy`/`blocking` issue numbers; you must
check these before setting or adding to them, since GitHub rejects a relationship that already
exists. `relates to` has no such restriction (step 4), so it needs no pre-check.

## 3. Match each entry, then act on title and body

Compare each entry to the issues by **scope**, not by wording: same feature or same problem, even
if phrased differently. Only call it a match when the scope is very similar. A related-but-distinct
issue is not a match; create a new one instead (its `relates to`, `parent`, `blocked by` or `blocks`
property, if any, records the relation; see step 4).

For each entry:

- **Match, closed issue** → leave the entry in place (don't delete it in step 5), tell the user it's
  already covered by issue #N, and don't touch that issue. Skip properties and relationships for it
  too.
- **Match, open issue, nothing new in the entry** → no title/body edit needed, but still apply its
  properties (step 4).
- **Match, open issue, entry adds context** (extra requirements, constraints, details the issue's
  body lacks) → update the issue with `gh issue edit <n> --body-file <file>`, merging the entry's
  extra info into the existing body. Keep what's already there, add the new info (a short bullet or
  paragraph), don't duplicate. Never drop existing text. Leave the title unless the entry clearly
  shows it's wrong. Then apply properties (step 4).
- **No match** → create it:
  ```bash
  gh issue create --title "<title>" --body-file <file>
  ```
  Write a short, clear title in sentence form (not the raw heading verbatim, unless it already reads
  that way) and a concise body from the entry's free text. Then apply properties (step 4).

Use the scratchpad directory for any temp body files.

Keep a running map, for every entry, of: outcome (created / enriched / matched, no change / closed
match left untouched) and the issue number it landed on (or none, for a closed match). You'll need
this map in step 4 to resolve `blocked by`/`blocks` references to other TODO entries.

## 4. Apply properties

For every entry that was created or enriched (i.e. has an issue number from step 3), apply its
declared properties to that issue. Setting `type` or `priority` is idempotent, safe to re-apply even
if already set. The relationships (`parent`, `blocked by`, `blocks`) are not: GitHub errors if you
set one that's already there, so check the current state from step 2 first. `relates to` is the one
exception among relationships: adding a duplicate is a harmless no-op, so it needs no check.

Any reference in `parent`, `blocked by`, `blocks` or `relates to` first needs resolving to an issue
number:
- `#N` → that issue number directly.
- A quoted title → look it up in this run's entry→issue-number map (step 3). If it resolves to no
  issue (e.g. the referenced entry was a closed-issue match left untouched, or the title doesn't
  match any entry), skip that one reference and note it in the final report; don't guess.

- **`type`** (default `task` if the entry omits it): it is a label here, not a GitHub issue type.
  `bug` → label `bug`, `feature` → label `enhancement`, `task` → no label (nothing to do). Add it:
  ```bash
  gh issue edit <n> --add-label <label>
  ```
  Only ever add; don't remove labels the issue already has.
- **`priority`** (default `low` if the entry omits it, so no issue the skill touches is left without
  one): capitalize it (`urgent` → `Urgent`, etc.), add the issue to the project board, and set the
  field:
  ```bash
  gh project item-add <board> --owner <board-owner> --url <issue-url>
  gh project item-edit <board> --owner <board-owner> --url <issue-url> --field "Priority" --value "<Priority>"
  ```
  The default only fills a gap: when the entry omits `priority` and the issue already has one on the
  board (step 2), leave it as it is. Never lower an issue's priority to `Low` because the entry said
  nothing. If the board refuses the issue (it is an organization board and the repo is a personal
  one), don't retry in another way: note it in the final report and carry on with the other
  properties.
- **`parent`**: resolve its one reference. If it already equals that issue's current `parent` from
  step 2, skip. Otherwise:
  ```bash
  gh issue edit <n> --parent <target>
  ```
- **`blocked by` / `blocks`**: resolve each comma-separated reference. For each one not already in
  that issue's current `blockedBy` (for `blocked by`) or `blocking` (for `blocks`) set from step 2,
  add it:
  ```bash
  gh issue edit <n> --add-blocked-by <target>
  gh issue edit <n> --add-blocking <target>
  ```
- **`relates to`**: resolve each comma-separated reference, then add each one; no state to check
  first. `gh` has no flag for this relationship, so call the GraphQL mutation directly, by node ID
  rather than issue number (`gh issue view <n> --json id --jq .id` gets one):
  ```bash
  gh api graphql -f query='mutation($a:ID!,$b:ID!){addRelatesTo(input:{issueId:$a,relatedIssueId:$b}){issue{number}}}' -f a="<this issue's node id>" -f b="<target's node id>"
  ```

## 5. Clear the TODO file

Delete every entry that landed on an issue number in step 3 (created, enriched, or matched an open
issue with nothing new to add). Deleting an entry means removing its `##` heading through to (not
including) the next `##` heading or end of file. Leave closed-issue matches in place, since they got
no issue number, so that decision isn't lost. Keep the `# TODO` heading and its preamble either way,
so the file stays valid.

Do this only after the GitHub operations for those entries succeeded.

## 6. Report

First, one short line per entry saying what happened (created #N / enriched #N / matched #N, no
change / already covered by closed #N), plus a line for any property or relationship that couldn't
be applied and why.

Then list **all open issues** (`gh issue list --state open --limit 100 --json number,title,url`),
grouped by their Priority field from the project board
(`gh project item-list <board> --owner <board-owner> --format json --limit 200`, matched by
`content.number`). Use a two-level list: the top level is a
`###` heading per priority, ordered `Urgent`, `High`, `Medium`, `Low`, then a final `### No
priority` section for issues with no Priority value (or not on the board at all) — always last,
regardless of how many issues fall there. Within each section, sort by issue number, in exactly this
shape, with the issue number as a markdown link to the issue and no separate URL line:

```
### Urgent

- [#4](https://github.com/<owner>/<repo>/issues/4) Token renewal loses the login on a failed write

### High

- [#5](https://github.com/<owner>/<repo>/issues/5) Show the reset time in the status bar text

### No priority

- [#6](https://github.com/<owner>/<repo>/issues/6) Some untriaged issue
```

Omit a priority section entirely when no open issue falls in it (including dropping `### No
priority` when every open issue is prioritized). Take the real numbers, titles, URLs and priorities
from `gh`, not from this example. Then stop: leave it open for the user to pick an issue and start a
feature branch on their own. Don't create a branch, and don't suggest one beyond a single closing
line like "Pick one when you want to start a branch."

#!/usr/bin/env bash
# Makes main reachable only through a pull request that has passed CI, on GitHub's side (the git hooks in
# .pre-commit-config.yaml are the same rule on your own machine, and only as good as their installation).
#
#   scripts/protect-main.sh            prints what it would set
#   scripts/protect-main.sh --apply    sets it
#
# Branch protection is free for public repositories only. On a private repository of a free account GitHub
# answers 403 ("Upgrade to GitHub Pro or make this repository public"): run this the day the repository
# goes public. If a check below is renamed in a workflow, rename it here too, or the merge button waits
# forever for a check that no longer exists.

echo ""
echo "Running script '${BASH_SOURCE[0]}'"

set -euo pipefail

REPO="${REPO:-albertobaraza/claude-limits-meter}"

# The job names of test.yaml and ci.yml, as they appear on a pull request.
CHECKS=(
    "Unit tests (ubuntu-latest)"
    "Unit tests (macos-latest)"
    "Unit tests (windows-latest)"
    "VS Code 1.125.0 (ubuntu-latest)"
    "VS Code stable (ubuntu-latest)"
    "VS Code stable (macos-latest)"
    "VS Code stable (windows-latest)"
    "Changelog & version"
    "Commit messages"
    "File hygiene"
    "Workflows"
    "Secrets"
)

contexts="$(printf '%s\n' "${CHECKS[@]}" | node -e "
  const lines = require('fs').readFileSync(0, 'utf8').split('\n').filter(Boolean);
  process.stdout.write(JSON.stringify(lines));
")"

payload="$(cat <<JSON
{
  "required_status_checks": { "strict": true, "contexts": ${contexts} },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 0, "dismiss_stale_reviews": true },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
)"

echo "  repository: ${REPO}"
echo "  rule for main:"
echo "${payload}" | node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync(0, 'utf8')), null, 2).replace(/^/gm, '    '))"

if [ "${1:-}" != "--apply" ]; then
    echo ""
    echo "  Dry run. Add --apply to set it."
    echo ""
    echo "End of script '${BASH_SOURCE[0]}'"
    exit 0
fi

echo "${payload}" | gh api -X PUT "repos/${REPO}/branches/main/protection" --input - > /dev/null
gh repo edit "${REPO}" --delete-branch-on-merge > /dev/null
echo "  [ok] main is protected; merged branches are deleted"

echo ""
echo "End of script '${BASH_SOURCE[0]}'"

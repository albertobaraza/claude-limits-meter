#!/usr/bin/env bash

echo ""
echo "Running script '${BASH_SOURCE[0]}'"

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if ! command -v node &> /dev/null; then
    echo "  [!!] Node.js not found. Install Node 22 or newer, then re-run this script." >&2
    exit 1
fi
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 22 ]; then
    echo "  [!!] Node $(node --version) is too old: the tests need Node 22 or newer (glob arguments to node --test)." >&2
    exit 1
fi
echo "  [ok] Node $(node --version)"

npm ci --ignore-scripts

if ! command -v gh &> /dev/null; then
    echo "  [!!] GitHub CLI (gh) not found. Only needed for the pr and ci skills." >&2
fi

# A new branch must never track origin/main: a later plain `git push` would then land on main.
git config branch.autoSetupMerge false
echo "  [ok] New branches no longer track the branch they were started from"

if command -v pre-commit &> /dev/null; then
    echo "  [ok] pre-commit $(pre-commit --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
    pre-commit install --install-hooks --hook-type pre-commit --hook-type commit-msg --hook-type pre-push
    echo "  [ok] Git hooks installed (see .pre-commit-config.yaml): hygiene and message check on commit, typecheck and tests on push, and no push to main"
else
    echo "  [!!] pre-commit not found, so nothing stops a commit or push to main on this machine." >&2
    echo "  [!!] Install it (pipx install pre-commit), then re-run this script." >&2
fi

echo ""
echo "  claude-limits-meter: setup complete"
echo ""
echo "  Run the extension: open this folder in VS Code and press F5."
echo "  Run the tests:     npm test"
echo ""
echo "End of script '${BASH_SOURCE[0]}'"

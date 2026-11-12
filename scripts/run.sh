#!/usr/bin/env bash
# Runs Claude Limits Meter locally, always containerized, via test/live/compose.yml: the extension in a VS Code you open
# in the browser, asking a mock Claude that you steer from a web page. Nothing real is involved: no Claude login, no
# call to Anthropic.
#
#   ./scripts/run.sh          VS Code on http://localhost:8788 with the extension installed (a .vsix built from this
#                             checkout, the same file a release ships) and the mock's control page on http://localhost:4010.
#                             Change what the API answers (a reading, 429, 401, 500) and the login on the machine (valid,
#                             expired, none) on the page, and watch the status bar. The terminal follows the requests the
#                             extension makes. Ctrl+C stops everything and removes it.
#   ./scripts/run.sh down     the same stop, from another terminal.
#
# After a change to src/, run it again: the image is rebuilt (the dependencies are cached, so it takes seconds) and the
# extension in the new window is the new code. VSCODE_PORT and MOCK_PORT change the two ports.
#
# The extension is not told it is being tested: it asks https://api.anthropic.com, which in the compose network is the mock,
# over TLS with a certificate the mock makes at every start. The only things shared with your machine are the two ports, on
# 127.0.0.1; your ~/.claude is never mounted. `npm run test:integration:docker` is the automated version of this.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

MODE="${1:-live}"
VSCODE_PORT="${VSCODE_PORT:-8788}"
MOCK_PORT="${MOCK_PORT:-4010}"
export VSCODE_PORT MOCK_PORT

compose() {
    docker compose --file test/live/compose.yml "$@"
}

require_docker() {
    if ! command -v docker &>/dev/null; then
        echo "Docker not found. Install it: https://docs.docker.com/get-docker/" >&2
        exit 1
    fi
}

# Everything of the project down and removed, volumes (the certificate and the fake login) included, so a start is clean.
stop() {
    trap - EXIT INT TERM
    echo
    echo "Stopping..."
    compose down --remove-orphans --volumes
}

case "$MODE" in
    live)
        require_docker
        compose down --remove-orphans --volumes
        echo "Building the extension and starting VS Code and the mock Claude (the first time downloads VS Code's image)..."
        trap stop EXIT INT TERM
        if ! compose up --build --detach --wait --quiet-pull; then
            echo >&2
            echo "It did not start. If a port is already in use, choose others: VSCODE_PORT=8800 MOCK_PORT=4011 ./scripts/run.sh" >&2
            exit 1
        fi
        cat <<BANNER

  VS Code            http://localhost:${VSCODE_PORT}     the extension is the status-bar item, bottom right
  Mock Claude        http://localhost:${MOCK_PORT}     change what the API answers, and the login, here

  Hover the status-bar item for the summary, click it for the details. It checks every 60 s while the tab is focused; Refresh Now in its menu asks sooner.
  What the extension asks is below. Ctrl+C stops everything.

BANNER
        # `logs --follow` ends on Ctrl+C, and the trap then takes everything down.
        compose logs --follow --tail 0 --no-log-prefix mock
        ;;
    down)
        require_docker
        compose down --remove-orphans --volumes
        ;;
    *)
        echo "Unknown mode '$MODE'. Use live (the default) or down." >&2
        exit 2
        ;;
esac

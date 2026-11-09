#!/usr/bin/env bash
# Starts VS Code in the browser on an empty folder, with settings that suit watching the extension. Run by the VS Code container.
set -euo pipefail

mkdir -p "$HOME/project" "$HOME/.local/share/code-server/User"

# The extension asks https://api.anthropic.com, which here is the mock, so the mock's certificate authority has to be
# trusted. NODE_EXTRA_CA_CERTS (set by compose.yml) is not enough on its own: VS Code's extension host loads the system
# certificates and hands Node that list in place of the extra ones, so the authority also goes in the system store.
sudo cp /shared-certs/ca.pem /usr/local/share/ca-certificates/mock-claude-ca.crt
sudo update-ca-certificates > /dev/null

# The extension checks every 15 s (its smallest interval) while this tab is focused, so a change on the mock shows
# within seconds. The client id is any UUID: it only matters once refreshExpiredToken is switched on, and the mock
# accepts it, so renewal can be tried with one setting.
cat > "$HOME/.local/share/code-server/User/settings.json" <<'JSON'
{
  "claudeLimitsMeter.pollIntervalSeconds": 15,
  "claudeLimitsMeter.clientId": "00000000-0000-0000-0000-000000000000",
  "workbench.startupEditor": "none",
  "workbench.colorTheme": "Default Dark Modern",
  "security.workspace.trust.enabled": false,
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false
}
JSON

exec code-server --auth none --bind-addr 0.0.0.0:8080 --disable-telemetry --disable-update-check "$HOME/project"

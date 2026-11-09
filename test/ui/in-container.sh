#!/usr/bin/env bash
# What the container runs: the extension host suite, then the UI run, each on its own virtual display, and a
# failure of either fails the container. Screenshots end up in .vscode-test/screenshots (docker.js copies them out).

screen="-screen 0 1280x800x24"
status=0

npm run compile || exit 1
xvfb-run -a -s "$screen" node test/integration/run.js || status=1
xvfb-run -a -s "$screen" node test/ui/run.js || status=1
exit $status

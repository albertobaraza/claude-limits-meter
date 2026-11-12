# VS Code in a browser with the packaged extension installed, for the live environment (test/live/compose.yml).
# code-server is VS Code served over HTTP: its extension host runs in this container, as it does in WSL, Remote-SSH or a
# dev container, which is where `extensionKind: workspace` makes the extension run. The pinned version carries the VS Code
# version after "Code": https://github.com/coder/code-server/releases

# The .vsix, built the way `npm run package` builds the one that is released.
FROM node:22-bookworm-slim AS package
WORKDIR /app
COPY package.json package-lock.json tsconfig.json .vscodeignore ./
RUN npm ci --ignore-scripts
COPY src src
COPY docs docs
COPY images images
COPY README.md CHANGELOG.md LICENSE ./
RUN npm run package

FROM codercom/code-server:4.145.2
COPY --from=package --chown=coder:coder /app/claude-limits-meter-*.vsix /home/coder/claude-limits-meter.vsix
RUN code-server --install-extension /home/coder/claude-limits-meter.vsix && rm /home/coder/claude-limits-meter.vsix

COPY --chown=coder:coder test/live/vscode/entrypoint.sh /home/coder/entrypoint.sh
ENTRYPOINT ["bash", "/home/coder/entrypoint.sh"]

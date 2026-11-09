# A clean Linux machine to run the real-VS-Code tests on: Node, a virtual display and the system libraries
# Electron needs, with nothing of yours in it. Used by `npm run test:integration:docker` (test/ui/docker.js).
#
# It is run with no mounts, so the container can never see your ~/.claude login or anything else on your machine.
# The tests build on a throwaway HOME inside it anyway, and the extension only ever talks to a fake API on the
# container's loopback (extension host suite) or to nothing (UI run).

FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates xvfb xauth fonts-dejavu-core \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
      libpango-1.0-0 libsecret-1-0 libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxkbfile1 libxrandr2 \
 && rm -rf /var/lib/apt/lists/*

# Not root: the integration tests have checks that behave differently as root, and users are not root.
RUN mkdir /app && chown node:node /app
USER node
WORKDIR /app

# Layers that change rarely come first: dependencies, then VS Code, then the sources.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --ignore-scripts

ARG VSCODE_VERSION=stable
ENV VSCODE_VERSION=${VSCODE_VERSION}
RUN node -e "require('@vscode/test-electron').downloadAndUnzipVSCode({ version: process.env.VSCODE_VERSION, cachePath: '.vscode-test' }).catch((e) => { console.error(e); process.exit(1); })"

COPY --chown=node:node . .

# Chromium cannot use its sandbox in a container, and a virtual display has no GPU: see test/integration/common.js.
ENV CLAUDE_LIMITS_METER_IT_CONTAINER=1 DONT_PROMPT_WSL_INSTALL=1

CMD ["bash", "test/ui/in-container.sh"]

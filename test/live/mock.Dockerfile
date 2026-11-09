# The mock Claude of the live environment (test/live/compose.yml): test/live/mock/server.js on the fake API of the
# integration tests. It has no dependencies, so there is nothing to install: Node, openssl for the certificate, and the
# two folders it runs from, at the paths they have in the repo.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY test/integration/fake-api.js test/integration/fake-api.js
COPY test/live/mock test/live/mock

# Root, on purpose: the container listens on 443 (the extension asks https://api.anthropic.com) and hands the login it
# writes to the VS Code container's user. It holds fake data only and is on a private network.
CMD ["bash", "test/live/mock/entrypoint.sh"]

#!/usr/bin/env bash
# Makes the certificate the mock answers with, then starts the mock. Run by the mock container.
#
# The extension asks https://api.anthropic.com and https://console.anthropic.com, which in the compose network are this
# container. It trusts them because this makes a certificate authority of its own at every start, signs a certificate for
# those two names with it, and shares only the authority's public half (ca.pem) with the VS Code container, which
# adds it to the certificates its Node trusts (NODE_EXTRA_CA_CERTS). The keys stay in this container.

set -euo pipefail

private=/mock-certs   # key.pem, cert.pem: this container only
shared=/shared-certs  # ca.pem: the volume the VS Code container reads
mkdir -p "$private" "$shared" /claude
chown 1000:1000 /claude   # the VS Code container's user must be able to write the login here when it renews it

cd "$private"
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -keyout ca.key -out ca.pem -subj "/CN=Claude Limits Meter mock CA" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout key.pem -out leaf.csr -subj "/CN=api.anthropic.com" 2>/dev/null
printf 'subjectAltName=DNS:api.anthropic.com,DNS:console.anthropic.com\nbasicConstraints=CA:FALSE\n' > leaf.ext
openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 30 -extfile leaf.ext -out cert.pem 2>/dev/null

cp ca.pem "$shared/ca.pem"
chmod 644 "$shared/ca.pem"

exec node /app/test/live/mock/server.js

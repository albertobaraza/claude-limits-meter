# Security policy

## What this extension handles

It reads your Claude Code login (`~/.claude/.credentials.json`, or the macOS Keychain item `Claude Code-credentials`)
and sends the **access token only to `api.anthropic.com`** to read your usage. If you turn on
`claudeLimitsMeter.refreshExpiredToken` it also contacts `console.anthropic.com` and rewrites the credentials file.
It has no runtime dependencies and no telemetry. The README's "Privacy and security" section is the authoritative list.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use GitHub's private reporting: the repository's
**Security** tab > **Report a vulnerability**. Include what you found, how to reproduce it and what it lets an attacker do.

You can expect an answer within a week. A fix goes out as a new version; the release notes say what was wrong once a
fixed version is available.

## In scope

- Anything that leaks, logs or sends a token somewhere other than the hosts above.
- Writing to a credentials file or the Keychain when `refreshExpiredToken` is off, or corrupting the file when it is on.
- Markdown or command injection through the status-bar tooltip.
- A packaged `.vsix` that contains more than the extension (secrets, sources, tooling).

## Out of scope

- The usage endpoint being undocumented or changing: that breaks the extension, not your security.
- Anything that requires an attacker who can already read your home directory: the login is a plain file readable by you.

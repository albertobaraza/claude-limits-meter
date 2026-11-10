#!/usr/bin/env node
// Asks the real usage endpoint, with this machine's own Claude Code login, and prints what the status bar
// would show. Read-only: token renewal is off, so nothing is ever written. A token is never printed.
//
//   npm run smoke

const { ClaudeClient, defaultOptions, bar, pctText, timeLeft } = require("../out/claude.js");

async function main() {
  const client = new ClaudeClient(
    defaultOptions({
      userAgent: "claude-limits-meter/smoke",
      refreshEnabled: () => false,
      clientId: async () => {
        throw new Error("unused: renewal is off");
      },
      onWarn: (message) => console.warn(`warning: ${message}`),
      onNote: () => {},
    }),
  );

  const token = await client.getToken();
  console.log(`token result: ${token.kind}`); // the kind, never the token
  if (token.kind !== "ok") {
    console.log(token.kind === "none" ? "No Claude Code login on this machine." : "The stored token has expired; use Claude Code once and run this again.");
    return token.kind === "none" ? 1 : 0;
  }

  const usage = await client.fetchUsage(token.token);
  for (const [label, w] of [["5h", usage.five_hour], ["7d", usage.seven_day]]) {
    const pct = w?.utilization ?? 0;
    console.log(`${label}: ${bar(pct)} ${pctText(pct)}   resets in ${timeLeft(w?.resets_at)}`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  },
);

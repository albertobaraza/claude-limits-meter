// How a State looks: the status-bar text, the hover tooltip (Markdown) and the click menu.
// Free of any `vscode` import, so it is unit-tested with plain node.

import { bar, pctText, timeLeft } from "./claude";
import { retryAt, type Snapshot, type State } from "./state";

export const SETTINGS = "claudeUsageStatusbar";

export interface StatusView {
  /** Status-bar text; may contain $(codicon) markers. */
  text: string;
  /** Tooltip, as Markdown with command links. */
  markdown: string;
}

export interface MenuEntry {
  label: string;
  description?: string;
  /** Picking the entry runs this; entries without one are informational. */
  action?: "refresh" | "openCredentials";
  separator?: true;
}

export interface Commands {
  refresh: string;
  openCredentials: string;
}

function usageLines(s: Snapshot, now: number): string[] {
  return [
    `Session (5h)  ${bar(s.fiveHour)} ${pctText(s.fiveHour)}   ⏱ ${timeLeft(s.fiveHourReset, now)}`,
    `Weekly  (7d)  ${bar(s.sevenDay)} ${pctText(s.sevenDay)}   ⏱ ${timeLeft(s.sevenDayReset, now)}`,
  ];
}

export function escapeMarkdown(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

/** "2m" until the time the rate limit lets the next check run, or "now" once it has passed. */
function retryIn(state: State, now: number): string {
  return timeLeft(new Date(retryAt(state)).toISOString(), now);
}

export function statusView(state: State, commands: Commands, now = Date.now()): StatusView {
  let text: string;
  let body: string;
  switch (state.status) {
    case "loading":
      text = "$(sparkle) …";
      body = "Loading…";
      break;
    case "noCreds":
      text = "$(sparkle) —";
      body =
        "No Claude Code login found on this machine. Sign in to Claude Code first " +
        "(run `claude` in a terminal and authenticate).";
      break;
    case "expired":
      text = "$(sparkle) !";
      body =
        "The stored Claude token has expired. It renews the next time Claude Code is used, and this bar picks it " +
        `up automatically. To renew it from here instead, enable \`${SETTINGS}.refreshExpiredToken\` ` +
        "(not available for the macOS Keychain).";
      break;
    case "rateLimited":
      text = `$(clock) ${state.snapshot ? `${Math.trunc(state.snapshot.fiveHour)}%` : "—"}`;
      body =
        `$(clock) Claude is rate limiting requests. The next check is in ${retryIn(state, now)}; ` +
        "Refresh Now will not ask sooner.";
      break;
    case "error":
      text = "$(sparkle) ✗";
      body = `$(error) ${escapeMarkdown(state.error ?? "Unknown error")}`;
      break;
    case "ok":
      text = `$(sparkle) ${Math.trunc(state.snapshot?.fiveHour ?? 0)}%`;
      body = "";
      break;
  }

  let markdown = `**Claude usage**${body ? `\n\n${body}` : ""}`;
  if (
    state.snapshot &&
    (state.status === "ok" || state.status === "error" || state.status === "expired" || state.status === "rateLimited")
  ) {
    markdown += `\n\n\`\`\`text\n${usageLines(state.snapshot, now).join("\n")}\n\`\`\``;
  }
  markdown += `\n\n[Refresh Now](command:${commands.refresh}) · [Open Credentials File](command:${commands.openCredentials})`;
  return { text, markdown };
}

export function menuEntries(state: State, now = Date.now()): MenuEntry[] {
  const entries: MenuEntry[] = [];
  const s = state.snapshot;
  if (s) {
    for (const w of [
      { label: "Session (5h)", pct: s.fiveHour, reset: s.fiveHourReset },
      { label: "Weekly (7d)", pct: s.sevenDay, reset: s.sevenDayReset },
    ]) {
      entries.push({
        label: `$(pulse) ${w.label}`,
        description: `${bar(w.pct)} ${pctText(w.pct).trim()}   ⏱ ${timeLeft(w.reset, now)}`,
      });
    }
  } else {
    entries.push({ label: "$(pulse) Usage", description: state.status === "noCreds" ? "no credentials" : "—" });
  }
  if (state.status === "rateLimited") {
    entries.push({ label: "$(clock) Rate limited", description: `next check in ${retryIn(state, now)}` });
  }
  entries.push(
    { label: "", separator: true },
    { label: "$(refresh) Refresh Now", action: "refresh" },
    { label: "$(key) Open Credentials File", action: "openCredentials" },
  );
  return entries;
}

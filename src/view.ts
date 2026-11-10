// How a State looks: the status-bar text, the hover tooltip (Markdown) and the click menu.
// Free of any `vscode` import, so it is unit-tested with plain node.

import { bar, clockTime, pctText, timeLeft } from "./claude";
import { retryAt, type Snapshot, type State } from "./state";

export const SETTINGS = "claudeLimitsMeter";

export interface StatusView {
  /** Status-bar text; may contain $(codicon) markers. */
  text: string;
  /** Hover tooltip: a short summary, as Markdown with command links. */
  markdown: string;
}

export interface ViewOptions {
  /** Show the 7-day week next to the 5-hour session in the status-bar text (the `showWeekly` setting). */
  showWeekly?: boolean;
}

export interface MenuEntry {
  label: string;
  description?: string;
  /** A second, longer line under the label. */
  detail?: string;
  /** Picking the entry runs this; entries without one are informational. */
  action?: "refresh" | "openCredentials" | "openSettings";
  separator?: true;
}

export interface Commands {
  refresh: string;
  openCredentials: string;
  openSettings: string;
}

/** The hover's summary of the two windows: the percentages only; bars and reset times are in the click menu. */
function summaryLine(s: Snapshot): string {
  return `Session (5h) **${pctText(s.fiveHour).trim()}** · Weekly (7d) **${pctText(s.sevenDay).trim()}**`;
}

/** The numbers in the status-bar text: the 5-hour session alone, or labelled next to the 7-day week. */
function usageText(fiveHour: number, sevenDay: number, showWeekly: boolean): string {
  const five = `${Math.trunc(fiveHour)}%`;
  return showWeekly ? `5h ${five} · 7d ${Math.trunc(sevenDay)}%` : five;
}

/** Text for the trusted tooltip: one line (a newline could start a fence, a heading or a list) with every Markdown mark escaped. */
export function escapeMarkdown(s: string): string {
  return s.replace(/\s+/g, " ").replace(/[\\`*_{}[\]()#+\-.!|<>~=&$]/g, "\\$&");
}

/** "2m" until the time the rate limit lets the next check run, or "now" once it has passed. */
function retryIn(state: State, now: number): string {
  return timeLeft(new Date(retryAt(state)).toISOString(), now);
}

export function statusView(
  state: State,
  commands: Commands,
  now = Date.now(),
  { showWeekly = false }: ViewOptions = {},
): StatusView {
  const s = state.snapshot;
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
      text = `$(clock) ${s ? usageText(s.fiveHour, s.sevenDay, showWeekly) : "—"}`;
      body =
        `$(clock) Claude is rate limiting requests. The next check is in ${retryIn(state, now)}; ` +
        "Refresh Now will not ask sooner.";
      break;
    case "error":
      text = "$(sparkle) ✗";
      body = `$(error) ${escapeMarkdown(state.error ?? "Unknown error")}`;
      break;
    case "ok":
      text = `$(sparkle) ${usageText(s?.fiveHour ?? 0, s?.sevenDay ?? 0, showWeekly)}`;
      body = "";
      break;
  }

  let markdown = `**Claude usage**${body ? `\n\n${body}` : ""}`;
  if (
    state.snapshot &&
    (state.status === "ok" || state.status === "error" || state.status === "expired" || state.status === "rateLimited")
  ) {
    markdown += `\n\n${summaryLine(state.snapshot)}\n\n_Last checked ${clockTime(state.snapshot.checkedAt)}_`;
  }
  markdown += `\n\n[Refresh Now](command:${commands.refresh}) · [Open Credentials File](command:${commands.openCredentials}) · [Settings](command:${commands.openSettings})`;
  return { text, markdown };
}

/** The view of a development build (F5 or a test host), marked so it is not mistaken for the installed extension. */
export function devView(view: StatusView): StatusView {
  return {
    text: `${view.text} DEV`,
    markdown: `$(beaker) **Development build**, not the installed extension\n\n${view.markdown}`,
  };
}

/** The line the menu adds under the usage when the state needs explaining (the hover has the same in Markdown). */
function menuNotice(state: State, now: number): MenuEntry | undefined {
  switch (state.status) {
    case "noCreds":
      return {
        label: "$(warning) No Claude Code login found",
        detail: "Sign in to Claude Code first: run claude in a terminal and authenticate.",
      };
    case "expired":
      return {
        label: "$(warning) Token expired",
        detail:
          "It renews the next time Claude Code is used. To renew it from here instead, enable " +
          `${SETTINGS}.refreshExpiredToken (not available for the macOS Keychain).`,
      };
    case "rateLimited":
      return { label: "$(clock) Rate limited", description: `next check in ${retryIn(state, now)}` };
    case "error":
      return { label: "$(error) Error", detail: state.error ?? "Unknown error" };
    default:
      return undefined;
  }
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
  const notice = menuNotice(state, now);
  if (notice) entries.push(notice);
  if (s) entries.push({ label: "$(history) Last checked", description: clockTime(s.checkedAt) });
  entries.push(
    { label: "", separator: true },
    { label: "$(refresh) Refresh Now", action: "refresh" },
    { label: "$(key) Open Credentials File", action: "openCredentials" },
    { label: "$(gear) Settings", action: "openSettings" },
  );
  return entries;
}

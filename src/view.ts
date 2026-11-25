// How a State looks: the status-bar text, the hover tooltip (Markdown) and the click menu.
// Free of any `vscode` import, so it is unit-tested with plain node.

import { bar, clockTime, pctText, timeLeft } from "./claude";
import type { Snapshot, State } from "./state";

export const SETTINGS = "claudeLimitsMeter";

/** From this usage, in either window, the status-bar text turns yellow. */
export const WARN_PCT = 90;

/**
 * The page where Claude shows the same usage in detail. The menu's "Open Usage in Browser" opens it in the user's own browser:
 * this extension never requests it, and it is a fixed address, not one a setting or a reading can change.
 */
export const USAGE_PAGE_URL = "https://claude.ai/settings/usage";

/**
 * The codicons that stand for the two windows wherever VS Code draws them: in the status-bar text instead of "5h" and "7d", and
 * on the hover's and the menu's rows, so the menu's "Session (5h)" and "Weekly (7d)" say what they mean. Not `$(clock)`: that
 * is the rate limit's.
 */
export const SESSION_ICON = "$(watch)";
export const WEEK_ICON = "$(calendar)";

export interface StatusView {
  /** Status-bar text; may contain $(codicon) markers. */
  text: string;
  /**
   * The reading the text shows is at or over WARN_PCT in the 5-hour session or the 7-day week (whether or not the text
   * shows the week): the item draws its text in the warning colour.
   */
  warn: boolean;
  /** Hover tooltip: a short summary, as Markdown with command links. */
  markdown: string;
  /** What a screen reader says for the item: the text in words, since the icons that label the windows are not read. */
  accessibility: string;
}

export interface ViewOptions {
  /** Show the 7-day week next to the 5-hour session in the status-bar text (the `showWeekly` setting). */
  showWeekly?: boolean;
  /** Show how long until each window in the status-bar text resets, after its usage (the `showResetTime` setting). */
  showResetTime?: boolean;
}

export interface MenuEntry {
  label: string;
  description?: string;
  /** A second, longer line under the label. */
  detail?: string;
  /** Picking the entry runs this; entries without one are informational. */
  action?: "refresh" | "openUsage" | "openCredentials" | "openSettings";
  separator?: true;
}

/** The commands the hover links to. The click menu has more entries, but a hover is only for the quick ones. */
export interface Commands {
  refresh: string;
  openSettings: string;
}

/**
 * The hover's summary of the two windows: one row each, in a table so the columns line up, with how much is used and how long
 * until it resets, each row starting with its window's icon. The bars, and the "(5h)" and "(7d)", are only in the click menu. The table has no header text (Markdown
 * wants a header row, so it is an empty one, which takes no visible room). The "·" between the columns are columns of their own:
 * in the cell of a right-aligned percentage a dot would move with the number of digits, in a column it stays in line.
 * Everything in it is a number or a duration, never text from outside.
 */
function summaryTable(s: Snapshot, now: number): string {
  return [
    "| | | | | |",
    "| :-- | :-: | --: | :-: | :-- |",
    `| ${SESSION_ICON} Session | · | **${pctText(s.fiveHour).trim()}** | · | ${timeLeft(s.fiveHourReset, now)} |`,
    `| ${WEEK_ICON} Weekly | · | **${pctText(s.sevenDay).trim()}** | · | ${timeLeft(s.sevenDayReset, now)} |`,
  ].join("\n");
}

/**
 * The numbers in the status-bar text: the 5-hour session alone, or next to the 7-day week with each marked by its icon
 * (SESSION_ICON, WEEK_ICON), each followed by the time
 * until it resets when `showResetTime` is on ("42% (2h 13m)"). A reset time the reading did not give, or could not be read, is
 * left out rather than shown as "(?)": the hover still says "?". It counts down with the extension's once-a-minute render.
 */
function usageText(s: Partial<Snapshot>, now: number, { showWeekly = false, showResetTime = false }: ViewOptions): string {
  const one = (pct: number | undefined, reset: string | null | undefined) => {
    const left = showResetTime ? timeLeft(reset, now) : undefined;
    return `${Math.trunc(pct ?? 0)}%${left && left !== "?" ? ` (${left})` : ""}`;
  };
  const five = one(s.fiveHour, s.fiveHourReset);
  return showWeekly ? `${SESSION_ICON} ${five} · ${WEEK_ICON} ${one(s.sevenDay, s.sevenDayReset)}` : five;
}

/**
 * The reading in words for a screen reader: both windows, whatever the text shows, with how long until each resets. The
 * numbers are the text's (truncated), and a reading not yet taken is 0% as in the text.
 */
function readingInWords(s: Partial<Snapshot>, now: number): string {
  const resets = (reset: string | null | undefined) => {
    const left = timeLeft(reset, now);
    return left === "?" ? "reset time unknown" : left === "now" ? "resets now" : `resets in ${left}`;
  };
  return (
    `session ${Math.trunc(s.fiveHour ?? 0)}%, ${resets(s.fiveHourReset)}; ` +
    `week ${Math.trunc(s.sevenDay ?? 0)}%, ${resets(s.sevenDayReset)}`
  );
}

function accessibilityLabel(state: State, now: number): string {
  const s = state.snapshot;
  switch (state.status) {
    case "loading":
      return "Claude usage: loading";
    case "noCreds":
      return "Claude usage: no Claude Code login found";
    case "expired":
      return "Claude usage: the stored token has expired";
    case "rateLimited":
      return `Claude usage, rate limited, retrying automatically: ${s ? readingInWords(s, now) : "no reading yet"}`;
    case "error":
      return "Claude usage: the check failed, hover for the reason";
    case "ok":
      return `Claude usage: ${readingInWords(s ?? {}, now)}`;
  }
}

/** Text for the trusted tooltip: one line (a newline could start a fence, a heading or a list) with every Markdown mark escaped. */
export function escapeMarkdown(s: string): string {
  return s.replace(/\s+/g, " ").replace(/[\\`*_{}[\]()#+\-.!|<>~=&$]/g, "\\$&");
}

export function statusView(
  state: State,
  commands: Commands,
  now = Date.now(),
  options: ViewOptions = {},
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
      text = "$(sparkle) no login";
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
      text = `$(clock) ${s ? usageText(s, now, options) : "…"}`;
      // No countdown: it rounds to whole minutes, so the last minute of a wait read "0m". The footer's Refresh Now link is the button.
      body = "$(clock) Claude is rate limiting requests. The extension will retry automatically.";
      break;
    case "error":
      text = "$(sparkle) ✗";
      body = `$(error) ${escapeMarkdown(state.error ?? "Unknown error")}`;
      break;
    case "ok":
      text = `$(sparkle) ${usageText(s ?? {}, now, options)}`;
      body = "";
      break;
  }

  let markdown = `**Claude usage**${body ? `\n\n${body}` : ""}`;
  if (
    state.snapshot &&
    (state.status === "ok" || state.status === "error" || state.status === "expired" || state.status === "rateLimited")
  ) {
    markdown += `\n\n${summaryTable(state.snapshot, now)}\n\n_Last checked ${clockTime(state.snapshot.checkedAt)}_`;
  }
  markdown += `\n\n[Refresh Now](command:${commands.refresh}) · [Settings](command:${commands.openSettings})`;
  // Only a state whose text shows a reading: "!", "✗", "no login" and "…" stand for no number, so they are not coloured.
  const showsReading = state.status === "ok" || state.status === "rateLimited";
  const warn = showsReading && s !== undefined && (s.fiveHour >= WARN_PCT || s.sevenDay >= WARN_PCT);
  return { text, markdown, warn, accessibility: accessibilityLabel(state, now) };
}

/** The view of a development build (F5 or a test host), marked so it is not mistaken for the installed extension. */
export function devView(view: StatusView): StatusView {
  return {
    ...view,
    text: `${view.text} DEV`,
    markdown: `$(beaker) **Development build**, not the installed extension\n\n${view.markdown}`,
    accessibility: `Development build. ${view.accessibility}`,
  };
}

/** The line the menu adds under the usage when the state needs explaining (the hover has the same in Markdown). */
function menuNotice(state: State): MenuEntry | undefined {
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
      return { label: "$(clock) Rate limited", description: "retrying automatically" };
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
      { label: `${SESSION_ICON} Session (5h)`, pct: s.fiveHour, reset: s.fiveHourReset },
      { label: `${WEEK_ICON} Weekly (7d)`, pct: s.sevenDay, reset: s.sevenDayReset },
    ]) {
      entries.push({
        label: w.label,
        description: `${bar(w.pct)} ${pctText(w.pct).trim()}   ⏱ ${timeLeft(w.reset, now)}`,
      });
    }
  } else {
    entries.push({ label: "$(pulse) Usage", description: state.status === "noCreds" ? "no credentials" : "no reading yet" });
  }
  const notice = menuNotice(state);
  if (notice) entries.push(notice);
  if (s) entries.push({ label: "$(history) Last checked", description: clockTime(s.checkedAt) });
  entries.push(
    { label: "", separator: true },
    { label: "$(refresh) Refresh Now", action: "refresh" },
    { label: "$(link-external) Open Usage in Browser", action: "openUsage" },
    { label: "$(key) Open Credentials File", action: "openCredentials" },
    { label: "$(gear) Settings", action: "openSettings" },
  );
  return entries;
}

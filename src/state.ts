// What the status bar is showing and how one check turns the previous state into the next.
// Free of any `vscode` import, so it is unit-tested with plain node.

import { HttpError, type ClaudeClient } from "./claude";

export interface Snapshot {
  fiveHour: number;
  fiveHourReset?: string | null;
  sevenDay: number;
  sevenDayReset?: string | null;
  /** When (epoch ms) this reading was taken, so the tooltip and menu can say how old the numbers are. */
  checkedAt: number;
}

export type Status =
  | "loading"
  /** A fresh reading. */
  | "ok"
  /** No Claude Code login on this machine. */
  | "noCreds"
  /** A login whose token expired and has not been renewed. */
  | "expired"
  /** Claude answered 429: no new request until `retryAt`. */
  | "rateLimited"
  | "error";

export interface State {
  status: Status;
  /** The last successful reading, kept across failures so the tooltip can still show it. */
  snapshot?: Snapshot;
  error?: string;
  /** rateLimited only: the earliest time (epoch ms) the next request may be sent. */
  retryAt?: number;
  /** rateLimited only: how many 429s in a row, which doubles the wait when the server gives no hint. */
  rateLimitStreak?: number;
}

export const INITIAL_STATE: State = { status: "loading" };

/** Two manual refreshes closer than this reuse the reading we have instead of asking the API again. */
export const MIN_REFRESH_GAP_MS = 10_000;
/** The wait after a first 429 with no Retry-After; it doubles on every further one, up to the maximum. */
export const DEFAULT_BACKOFF_MS = 2 * 60_000;
export const MAX_BACKOFF_MS = 30 * 60_000;

export const MIN_POLL_SECONDS = 15;
export const DEFAULT_POLL_SECONDS = 60;
/** A day: far above any useful interval, and far below the longest delay a timer can hold. */
export const MAX_POLL_SECONDS = 24 * 60 * 60;
/** `setTimeout` runs a delay above this (2^31-1 ms, about 24.8 days) after 1 ms instead. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The delay between checks from the `pollIntervalSeconds` setting, between 15 s and a day. Anything but a finite number
 * (a string in a hand-edited settings file) is the default. Both ends matter: `Math.max(15, "abc")` is NaN and a delay above
 * `MAX_TIMER_MS` is replaced by 1 ms, and either one makes the timer fire at once, over and over, which also turns the wait
 * after a 429 into nothing, so the extension would ask the API as fast as it answers.
 */
export function pollIntervalMs(seconds: unknown): number {
  const n = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : DEFAULT_POLL_SECONDS;
  return Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, n)) * 1000;
}

/** The parts of `WorkspaceConfiguration.inspect()` used below, so this file needs no `vscode` import. */
export interface SettingInspection<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

/**
 * A setting only the user may set: the User-settings value, else the default, else `fallback`. A value that came from
 * the workspace is never used, because a repository's `.vscode/settings.json` is written by whoever wrote the repository.
 * `ignoredWorkspaceValue` says one was there, so the caller can log that it was not used.
 */
export function userSetting<T>(
  info: SettingInspection<T> | undefined,
  fallback: T,
): { value: T; ignoredWorkspaceValue: boolean } {
  return {
    value: info?.globalValue ?? info?.defaultValue ?? fallback,
    ignoredWorkspaceValue: info?.workspaceValue !== undefined || info?.workspaceFolderValue !== undefined,
  };
}

/** The time (epoch ms) before which no request may be sent, or 0 when we are not rate limited. */
export function retryAt(state: State): number {
  return state.status === "rateLimited" ? (state.retryAt ?? 0) : 0;
}

/** How long the timer waits before the next automatic check: the interval, or longer while rate limited. */
export function nextPollDelay(state: State, intervalMs: number, now = Date.now()): number {
  return Math.min(MAX_TIMER_MS, Math.max(intervalMs, retryAt(state) - now));
}

/** The earliest time (epoch ms) a manual refresh may reach the API, given when the last check started. */
export function refreshAllowedAt(state: State, lastCheckAt: number): number {
  return Math.max(lastCheckAt + MIN_REFRESH_GAP_MS, retryAt(state));
}

/** One check. Never throws: a failure becomes the next state. */
export async function check(
  client: Pick<ClaudeClient, "getToken" | "fetchUsage">,
  prev: State,
  log: (message: string) => void = () => {},
  now: () => number = Date.now,
): Promise<State> {
  const snapshot = prev.snapshot;
  try {
    const result = await client.getToken();
    if (result.kind === "none") return { status: "noCreds", snapshot };
    if (result.kind === "expired") return { status: "expired", snapshot };

    const data = await client.fetchUsage(result.token);
    return {
      status: "ok",
      snapshot: {
        fiveHour: data.five_hour?.utilization ?? 0,
        fiveHourReset: data.five_hour?.resets_at,
        sevenDay: data.seven_day?.utilization ?? 0,
        sevenDayReset: data.seven_day?.resets_at,
        checkedAt: now(),
      },
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(message);
    // Claude rejected a token that looked valid: same situation as one that is known to have expired.
    if (e instanceof HttpError && e.status === 401) return { status: "expired", snapshot };
    if (e instanceof HttpError && e.status === 429) {
      // Believe the server's Retry-After; without one, back off exponentially so we stop adding to the load.
      const streak = (prev.status === "rateLimited" ? (prev.rateLimitStreak ?? 0) : 0) + 1;
      const wait = e.retryAfterMs ?? Math.min(DEFAULT_BACKOFF_MS * 2 ** (streak - 1), MAX_BACKOFF_MS);
      return { status: "rateLimited", snapshot, retryAt: now() + wait, rateLimitStreak: streak };
    }
    return { status: "error", error: message, snapshot };
  }
}

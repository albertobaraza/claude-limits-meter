// What the status bar is showing and how one check turns the previous state into the next.
// Free of any `vscode` import, so it is unit-tested with plain node.

import { HttpError, type ClaudeClient } from "./claude";

export interface Snapshot {
  fiveHour: number;
  fiveHourReset?: string | null;
  sevenDay: number;
  sevenDayReset?: string | null;
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

/** The time (epoch ms) before which no request may be sent, or 0 when we are not rate limited. */
export function retryAt(state: State): number {
  return state.status === "rateLimited" ? (state.retryAt ?? 0) : 0;
}

/** How long the timer waits before the next automatic check: the interval, or longer while rate limited. */
export function nextPollDelay(state: State, intervalMs: number, now = Date.now()): number {
  return Math.max(intervalMs, retryAt(state) - now);
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

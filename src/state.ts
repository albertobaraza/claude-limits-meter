// What the status bar is showing and how one check turns the previous state into the next.
// Free of any `vscode` import, so it is unit-tested with plain node.

import { HttpError, SafeError, type ClaudeClient } from "./claude";
import { loginId, type SharedRecord, type SharedStore } from "./shared";

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
  /**
   * The fingerprint (`loginId`) of the login this state was read for. Set only by a check that ran with `sharing` and got as
   * far as reading the token, so that `adoptShared` can find this login's record without reading the credentials again.
   */
  login?: string;
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

/** An errno or TLS code such as ECONNREFUSED, ENOTFOUND, UND_ERR_CONNECT_TIMEOUT or CERT_HAS_EXPIRED. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,40}$/;

function errorCode(e: Error): string | undefined {
  const cause = (e as { cause?: { code?: unknown; errors?: unknown } }).cause;
  const nested = Array.isArray(cause?.errors) ? cause.errors.map((x) => (x as { code?: unknown } | undefined)?.code) : [];
  return [(e as { code?: unknown }).code, cause?.code, ...nested].find((c): c is string => typeof c === "string" && ERROR_CODE.test(c));
}

/**
 * The text an error becomes on screen and in the log. Our own errors (`SafeError`: a status code, a fixed message) as they are;
 * a network failure by its code; anything else by its class alone. The message of any other error is somebody else's text, and
 * a library is free to quote what it was given in it (fetch does, for a header value), so it is never shown.
 */
export function describeError(e: unknown): string {
  if (e instanceof SafeError) return e.message;
  if (!(e instanceof Error)) return "Unexpected error";
  if (e.name === "TimeoutError" || e.name === "AbortError") return "Request timed out";
  if (e.message === "fetch failed") {
    const code = errorCode(e);
    return code ? `Network error (${code})` : "Network error";
  }
  return `Unexpected error (${/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(e.name) ? e.name : "Error"})`;
}

/** How the other windows of this machine take part in a check (see shared.ts). */
export interface Sharing {
  store: SharedStore;
  /** A reading another window took less than this long ago is shown as it is, instead of asking the API again. */
  reuseWithinMs: number;
}

/** A wait read from the shared file is cut to this: a corrupt file must not park the bar for days. */
const MAX_SHARED_WAIT_MS = 60 * 60_000;

/** The newer of two readings. */
const newest = (a?: Snapshot, b?: Snapshot): Snapshot | undefined => (a && b && b.checkedAt > a.checkedAt ? b : (a ?? b));

/**
 * What another window already found out, as the state of this one, when that makes a request pointless: it is rate
 * limited and the wait is not over, or it took a reading no longer ago than `reuseWithinMs`. `undefined` otherwise.
 */
function fromOtherWindow(
  other: SharedRecord,
  snapshot: Snapshot | undefined,
  at: number,
  reuseWithinMs: number,
  log: (message: string) => void,
): State | undefined {
  const limit = other.rateLimit;
  if (limit) {
    if (limit.retryAt <= at) return undefined; // the wait is over: ask again, and a further 429 goes on counting
    log(`Not asking: another window was rate limited, ${Math.ceil((limit.retryAt - at) / 1000)}s of its wait left`);
    return {
      status: "rateLimited",
      snapshot,
      retryAt: Math.min(limit.retryAt, at + MAX_SHARED_WAIT_MS),
      rateLimitStreak: limit.streak,
    };
  }
  const taken = other.snapshot?.checkedAt;
  if (taken === undefined || taken > at || at - taken >= reuseWithinMs) return undefined; // too old, or from a clock gone back
  log(`Not asking: another window took this reading ${Math.round((at - taken) / 1000)}s ago`);
  return { status: "ok", snapshot };
}

/**
 * What another window left in the shared file, as the next state of a window that is not checking right now: a 429 wait
 * this one does not know of yet, or a reading newer than the one it shows. `undefined` when there is nothing new, and always
 * for a window with no login to look the record up by (none, expired, or not read yet). This is how a window that is not
 * focused, and so does not check, keeps showing what the others found out; it never asks the API.
 */
export function adoptShared(
  state: State,
  other: SharedRecord,
  at: number,
  log: (message: string) => void = () => {},
): State | undefined {
  const { login } = state;
  if (!login || state.status === "loading" || state.status === "noCreds" || state.status === "expired") return undefined;

  const limit = other.rateLimit;
  if (limit) {
    if (limit.retryAt <= at) return undefined; // over: this window's own timer asks again
    const snapshot = newest(state.snapshot, other.snapshot);
    const until = Math.min(limit.retryAt, at + MAX_SHARED_WAIT_MS);
    if (state.status === "rateLimited" && state.retryAt === until && state.snapshot === snapshot) return undefined; // our own, or known
    log(`Another window was rate limited, ${Math.ceil((until - at) / 1000)}s of its wait left`);
    return { status: "rateLimited", login, snapshot, retryAt: until, rateLimitStreak: limit.streak };
  }

  const taken = other.snapshot?.checkedAt;
  if (!other.snapshot || taken === undefined || taken > at) return undefined; // none, or from a clock gone back
  if (state.snapshot && taken <= state.snapshot.checkedAt) return undefined; // not newer than what is on screen
  log(`Another window took a newer reading ${Math.round((at - taken) / 1000)}s ago`);
  return { status: "ok", login, snapshot: other.snapshot };
}

/**
 * One check. Never throws: a failure becomes the next state. With `sharing`, the other windows of this machine are asked
 * first (nothing is sent while one of them waits out a 429, or has just read the usage) and told after what this request
 * found, so that all of them together ask about as often as one.
 */
export async function check(
  client: Pick<ClaudeClient, "getToken" | "fetchUsage">,
  prev: State,
  log: (message: string) => void = () => {},
  now: () => number = Date.now,
  sharing?: Sharing,
): Promise<State> {
  let snapshot = prev.snapshot;
  let streak = prev.status === "rateLimited" ? (prev.rateLimitStreak ?? 0) : 0;
  let login: string | undefined;
  /** The state, tagged with the login it is for when the windows share (see `State.login`). */
  const tagged = (state: State): State => (sharing && login ? { ...state, login } : state);
  try {
    const result = await client.getToken();
    // The reading belonged to a login that is gone (a logout, or an account that is about to be replaced): not shown any more.
    if (result.kind === "none") return { status: "noCreds" };
    if (result.kind === "expired") return { status: "expired", snapshot };

    login = loginId(result.token);
    const other = sharing ? await sharing.store.read(login) : undefined;
    if (sharing && other) {
      snapshot = newest(snapshot, other.snapshot);
      streak = other.rateLimit?.streak ?? 0; // the last request anyone made is the one that counts
      const reused = fromOtherWindow(other, snapshot, now(), sharing.reuseWithinMs, log);
      if (reused) return tagged(reused);
    }

    const data = await client.fetchUsage(result.token);
    const reading: Snapshot = {
      fiveHour: data.five_hour?.utilization ?? 0,
      fiveHourReset: data.five_hour?.resets_at,
      sevenDay: data.seven_day?.utilization ?? 0,
      sevenDayReset: data.seven_day?.resets_at,
      checkedAt: now(),
    };
    await sharing?.store.write(login, { snapshot: reading });
    return tagged({ status: "ok", snapshot: reading });
  } catch (e) {
    const message = describeError(e);
    log(message);
    // Claude rejected a token that looked valid: same situation as one that is known to have expired.
    if (e instanceof HttpError && e.status === 401) return { status: "expired", snapshot };
    if (e instanceof HttpError && e.status === 429) {
      // Believe the server's Retry-After; without one (or with a useless one, see parseRetryAfter), back off
      // exponentially so we stop adding to the load.
      streak += 1;
      const wait = e.retryAfterMs ?? Math.min(DEFAULT_BACKOFF_MS * 2 ** (streak - 1), MAX_BACKOFF_MS);
      const until = now() + wait;
      if (login) await sharing?.store.write(login, { snapshot, rateLimit: { retryAt: until, streak } });
      return tagged({ status: "rateLimited", snapshot, retryAt: until, rateLimitStreak: streak });
    }
    return tagged({ status: "error", error: message, snapshot });
  }
}

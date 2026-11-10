// How one check turns the previous state into the next (src/state.ts), with a stand-in client.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  check,
  INITIAL_STATE,
  retryAt,
  nextPollDelay,
  refreshAllowedAt,
  MIN_REFRESH_GAP_MS,
  DEFAULT_BACKOFF_MS,
  MAX_BACKOFF_MS,
  pollIntervalMs,
  userSetting,
  MAX_POLL_SECONDS,
  MAX_TIMER_MS,
} = require("../../out/state.js");
const { HttpError } = require("../../out/claude.js");

const USAGE = {
  five_hour: { utilization: 36.4, resets_at: "2026-01-01T05:00:00+00:00" },
  seven_day: { utilization: 65, resets_at: "2026-01-03T00:00:00+00:00" },
};

const client = ({ token = { kind: "ok", token: "T" }, usage = USAGE, tokenError, usageError } = {}) => ({
  getToken: async () => {
    if (tokenError) throw tokenError;
    return token;
  },
  fetchUsage: async () => {
    if (usageError) throw usageError;
    return usage;
  },
});

const PREV = { status: "ok", snapshot: { fiveHour: 10, sevenDay: 20 } };

test("a good reading becomes the ok state with both windows and the time it was taken", async () => {
  const takenAt = Date.parse("2026-01-01T00:00:00Z");
  assert.deepEqual(await check(client(), INITIAL_STATE, () => {}, () => takenAt), {
    status: "ok",
    snapshot: {
      fiveHour: 36.4,
      fiveHourReset: "2026-01-01T05:00:00+00:00",
      sevenDay: 65,
      sevenDayReset: "2026-01-03T00:00:00+00:00",
      checkedAt: takenAt,
    },
  });
});

test("a failed check keeps the old reading with the time it was taken, not the time of the failure", async () => {
  const old = { fiveHour: 10, sevenDay: 20, checkedAt: 111 };
  const next = await check(client({ usageError: new Error("offline") }), { status: "ok", snapshot: old }, () => {}, () => 999);
  assert.equal(next.snapshot.checkedAt, 111);
});

test("a window the API leaves out counts as 0%", async () => {
  const next = await check(client({ usage: {} }), INITIAL_STATE);
  assert.equal(next.status, "ok");
  assert.equal(next.snapshot.fiveHour, 0);
  assert.equal(next.snapshot.sevenDay, 0);
});

test("no login gives noCreds and keeps the last reading", async () => {
  assert.deepEqual(await check(client({ token: { kind: "none" } }), PREV), { status: "noCreds", snapshot: PREV.snapshot });
});

test("an expired token gives expired, keeps the last reading and never asks for usage", async () => {
  let asked = false;
  const c = { getToken: async () => ({ kind: "expired" }), fetchUsage: async () => ((asked = true), USAGE) };
  assert.deepEqual(await check(c, PREV), { status: "expired", snapshot: PREV.snapshot });
  assert.equal(asked, false);
});

test("a 401 from the usage API is treated as an expired token", async () => {
  const next = await check(client({ usageError: new HttpError(401, "Usage fetch failed") }), PREV);
  assert.deepEqual(next, { status: "expired", snapshot: PREV.snapshot });
});

test("any other failure is an error that keeps the last reading and is logged", async () => {
  const logged = [];
  const next = await check(client({ usageError: new HttpError(500, "Usage fetch failed") }), PREV, (m) => logged.push(m));
  assert.deepEqual(next, { status: "error", error: "Usage fetch failed: HTTP 500", snapshot: PREV.snapshot });
  assert.deepEqual(logged, ["Usage fetch failed: HTTP 500"]);
});

// ── rate limiting (HTTP 429) ─────────────────────────────────────────────────

const NOW = 1_000_000;
const limited = (retryAfterMs) => client({ usageError: new HttpError(429, "Usage fetch failed", retryAfterMs) });

test("a 429 is its own state: it keeps the last reading, is logged and waits for the server's Retry-After", async () => {
  const logged = [];
  const next = await check(limited(90_000), PREV, (m) => logged.push(m), () => NOW);
  assert.deepEqual(next, { status: "rateLimited", snapshot: PREV.snapshot, retryAt: NOW + 90_000, rateLimitStreak: 1 });
  assert.deepEqual(logged, ["Usage fetch failed: HTTP 429"]);
});

test("without a Retry-After the wait starts at the default and doubles on every 429 in a row, up to the maximum", async () => {
  let state = PREV;
  const waits = [];
  for (let i = 0; i < 7; i++) {
    state = await check(limited(undefined), state, () => {}, () => NOW);
    waits.push(state.retryAt - NOW);
  }
  assert.deepEqual(waits.slice(0, 3), [DEFAULT_BACKOFF_MS, DEFAULT_BACKOFF_MS * 2, DEFAULT_BACKOFF_MS * 4]);
  assert.equal(waits[6], MAX_BACKOFF_MS, "never longer than the maximum");
  assert.equal(state.rateLimitStreak, 7);
});

test("a good reading after a 429 clears the rate limit, and the next 429 starts the backoff over", async () => {
  const hit = await check(limited(undefined), PREV, () => {}, () => NOW);
  const recovered = await check(client(), hit);
  assert.equal(recovered.status, "ok");
  assert.equal(recovered.retryAt, undefined);
  assert.equal(recovered.rateLimitStreak, undefined);
  const again = await check(limited(undefined), recovered, () => {}, () => NOW);
  assert.equal(again.retryAt - NOW, DEFAULT_BACKOFF_MS);
});

test("an error that is not a 429 in between also resets the streak", async () => {
  const hit = await check(limited(undefined), PREV, () => {}, () => NOW);
  const failed = await check(client({ usageError: new Error("offline") }), hit);
  assert.equal(failed.status, "error");
  assert.equal((await check(limited(undefined), failed, () => {}, () => NOW)).rateLimitStreak, 1);
});

test("the timer waits the interval normally and the rate limit's time when that is longer", () => {
  assert.equal(retryAt(PREV), 0);
  assert.equal(nextPollDelay(PREV, 60_000, NOW), 60_000);
  const state = { status: "rateLimited", retryAt: NOW + 5 * 60_000 };
  assert.equal(retryAt(state), NOW + 5 * 60_000);
  assert.equal(nextPollDelay(state, 60_000, NOW), 5 * 60_000);
  assert.equal(nextPollDelay(state, 60_000, NOW + 5 * 60_000 + 1), 60_000, "once it has passed, back to the interval");
});

test("a manual refresh reaches the API only after the minimum gap and after any rate limit", () => {
  assert.equal(refreshAllowedAt(PREV, NOW), NOW + MIN_REFRESH_GAP_MS);
  assert.ok(refreshAllowedAt(PREV, 0) < Date.now(), "nothing has been checked yet: no wait");
  const state = { status: "rateLimited", retryAt: NOW + 5 * 60_000 };
  assert.equal(refreshAllowedAt(state, NOW), NOW + 5 * 60_000, "the rate limit outlasts the gap");
  assert.equal(refreshAllowedAt({ ...state, retryAt: NOW + 1_000 }, NOW), NOW + MIN_REFRESH_GAP_MS, "the gap outlasts a short limit");
});

test("a failed token renewal is an error too", async () => {
  const next = await check(client({ tokenError: new HttpError(400, "Token refresh failed") }), INITIAL_STATE);
  assert.equal(next.status, "error");
  assert.match(next.error, /Token refresh failed: HTTP 400/);
});

test("something that is not an Error is still reported", async () => {
  const next = await check(client({ usageError: "boom" }), INITIAL_STATE);
  assert.deepEqual(next, { status: "error", error: "boom", snapshot: undefined });
});

test("recovering replaces an error with a fresh reading", async () => {
  const failed = await check(client({ usageError: new Error("offline") }), PREV);
  const recovered = await check(client(), failed);
  assert.equal(recovered.status, "ok");
  assert.equal(recovered.error, undefined);
  assert.equal(recovered.snapshot.fiveHour, 36.4);
});

// ── settings ─────────────────────────────────────────────────────────────────

test("the poll interval is at least 15 s, and the default when the setting is not a number", () => {
  assert.equal(pollIntervalMs(60), 60_000);
  assert.equal(pollIntervalMs(30), 30_000);
  assert.equal(pollIntervalMs(15), 15_000);
  assert.equal(pollIntervalMs(1), 15_000, "below the minimum");
  assert.equal(pollIntervalMs(0), 15_000);
  assert.equal(pollIntervalMs(-5), 15_000);
  for (const odd of ["abc", "30", "", null, undefined, NaN, Infinity, -Infinity, {}, [], true]) {
    assert.equal(pollIntervalMs(odd), 60_000, `${String(odd)} falls back to the default`);
  }
});

test("a rate limit still waits when the poll setting was nonsense (no NaN delay)", () => {
  const limited = { status: "rateLimited", retryAt: 1_000_000 + 120_000 };
  const delay = nextPollDelay(limited, pollIntervalMs("abc"), 1_000_000);
  assert.ok(Number.isFinite(delay));
  assert.equal(delay, 120_000);
});

test("a setting only the user may set comes from User settings, never from the workspace", () => {
  assert.deepEqual(userSetting({ defaultValue: false }, false), { value: false, ignoredWorkspaceValue: false });
  assert.deepEqual(userSetting({ defaultValue: false, globalValue: true }, false), { value: true, ignoredWorkspaceValue: false });
  assert.deepEqual(
    userSetting({ defaultValue: false, workspaceValue: true }, false),
    { value: false, ignoredWorkspaceValue: true },
    "a workspace value is not used, and is reported",
  );
  assert.deepEqual(userSetting({ defaultValue: false, workspaceFolderValue: true }, false), { value: false, ignoredWorkspaceValue: true });
  assert.deepEqual(
    userSetting({ defaultValue: "", globalValue: "user-id", workspaceValue: "repo-id" }, ""),
    { value: "user-id", ignoredWorkspaceValue: true },
    "the User value wins, whatever the workspace says",
  );
  assert.deepEqual(userSetting(undefined, "x"), { value: "x", ignoredWorkspaceValue: false }, "no information: the fallback");
  assert.deepEqual(userSetting({ globalValue: false, defaultValue: true }, true).value, false, "an explicit false is kept");
});

test("the poll interval has a ceiling too, so no setting can overflow the timer", () => {
  assert.equal(MAX_POLL_SECONDS, 86_400);
  assert.equal(pollIntervalMs(86_400), 86_400_000);
  assert.equal(pollIntervalMs(86_401), 86_400_000, "just over the ceiling");
  assert.equal(pollIntervalMs(2_147_483), 86_400_000, "about the largest delay a timer can hold, in seconds");
  assert.equal(pollIntervalMs(3_000_000), 86_400_000, "the value a repository's settings file could ship");
  assert.equal(pollIntervalMs(1e308), 86_400_000);
  assert.equal(pollIntervalMs(Number.MAX_VALUE), 86_400_000);
  for (const s of [15, 60, 3600, 86_400, 3e6, 1e308, -1, 0]) {
    const ms = pollIntervalMs(s);
    assert.ok(Number.isFinite(ms) && ms >= 15_000 && ms <= MAX_TIMER_MS, `${s} -> ${ms}`);
  }
});

test("the wait after a rate limit can never exceed what a timer can hold either", () => {
  assert.equal(MAX_TIMER_MS, 2_147_483_647);
  const now = 1_000_000;
  assert.equal(nextPollDelay({ status: "ok" }, 60_000, now), 60_000);
  assert.equal(nextPollDelay({ status: "rateLimited", retryAt: now + 120_000 }, 60_000, now), 120_000);
  assert.equal(nextPollDelay({ status: "ok" }, 1e12, now), MAX_TIMER_MS, "an oversized interval that did not come through pollIntervalMs");
  assert.equal(nextPollDelay({ status: "rateLimited", retryAt: now + 1e12 }, 60_000, now), MAX_TIMER_MS);
  assert.equal(nextPollDelay({ status: "rateLimited", retryAt: Infinity }, 60_000, now), MAX_TIMER_MS);
});

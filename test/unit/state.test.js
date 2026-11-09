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

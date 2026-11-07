// How one check turns the previous state into the next (src/state.ts), with a stand-in client.
const test = require("node:test");
const assert = require("node:assert/strict");
const { check, INITIAL_STATE } = require("../../out/state.js");
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

test("a good reading becomes the ok state with both windows", async () => {
  assert.deepEqual(await check(client(), INITIAL_STATE), {
    status: "ok",
    snapshot: {
      fiveHour: 36.4,
      fiveHourReset: "2026-01-01T05:00:00+00:00",
      sevenDay: 65,
      sevenDayReset: "2026-01-03T00:00:00+00:00",
    },
  });
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
  const next = await check(client({ usageError: new HttpError(429, "Usage fetch failed") }), PREV, (m) => logged.push(m));
  assert.deepEqual(next, { status: "error", error: "Usage fetch failed: HTTP 429", snapshot: PREV.snapshot });
  assert.deepEqual(logged, ["Usage fetch failed: HTTP 429"]);
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

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
  describeError,
  adoptShared,
  MAX_POLL_SECONDS,
  MAX_TIMER_MS,
} = require("../../out/state.js");
const { HttpError, BadResponseError, SafeError } = require("../../out/claude.js");
const { loginId } = require("../../out/shared.js");

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

test("no login gives noCreds and drops the last reading, which belonged to the login that is gone", async () => {
  assert.deepEqual(await check(client({ token: { kind: "none" } }), PREV), { status: "noCreds" });
  const after = await check(client({ token: { kind: "none" } }), PREV);
  assert.equal(after.snapshot, undefined, "a logout must not leave the previous account's numbers in the menu");
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

test("something that is not an Error is still reported, without quoting it", async () => {
  const next = await check(client({ usageError: "boom" }), INITIAL_STATE);
  assert.deepEqual(next, { status: "error", error: "Unexpected error", snapshot: undefined });
});

test("an error's own text reaches the screen and the log only when this code wrote it", async () => {
  const SECRET = "sk-ant-oat01-SECRET";
  const quoting = new TypeError(`Headers.append: "Bearer ${SECRET}" is an invalid header value.`);
  const logged = [];
  const next = await check(client({ usageError: quoting }), INITIAL_STATE, (m) => logged.push(m));
  assert.deepEqual(next, { status: "error", error: "Unexpected error (TypeError)", snapshot: undefined });
  assert.deepEqual(logged, ["Unexpected error (TypeError)"]);
  assert.ok(![next.error, ...logged].join("\n").includes(SECRET), "nothing of the quoted token is left");
});

test("describeError: our own errors as written, a network failure by its code, anything else by its class", () => {
  const cause = (code) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code }) });
  assert.equal(describeError(new HttpError(500, "Usage fetch failed")), "Usage fetch failed: HTTP 500");
  assert.equal(describeError(new BadResponseError("Token refresh failed")), "Token refresh failed: unexpected response");
  assert.equal(describeError(new SafeError("Claude Code extension not found")), "Claude Code extension not found");
  assert.equal(describeError(cause("ECONNREFUSED")), "Network error (ECONNREFUSED)");
  assert.equal(describeError(cause("UNABLE_TO_VERIFY_LEAF_SIGNATURE")), "Network error (UNABLE_TO_VERIFY_LEAF_SIGNATURE)");
  assert.equal(describeError(Object.assign(new TypeError("fetch failed"), { cause: { errors: [{ code: "ENOTFOUND" }] } })), "Network error (ENOTFOUND)", "an AggregateError of attempts");
  assert.equal(describeError(cause("not a code, and it could say anything")), "Network error", "a cause is trusted only when it is shaped like a code");
  assert.equal(describeError(new TypeError("fetch failed")), "Network error");
  assert.equal(describeError(new DOMException("The operation was aborted due to timeout", "TimeoutError")), "Request timed out");
  assert.equal(describeError(new DOMException("aborted", "AbortError")), "Request timed out");
  assert.equal(describeError(new Error("something SECRET")), "Unexpected error (Error)");
  assert.equal(describeError(Object.assign(new Error("x"), { name: "Evil name with spaces and SECRET" })), "Unexpected error (Error)", "even the class name must look like one");
  for (const odd of ["text", 7, null, undefined, { message: "SECRET" }]) assert.equal(describeError(odd), "Unexpected error");
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

// ── the other windows of this machine (sharing) ──────────────────────────────

const LOGIN = loginId("T"); // the token the stand-in client hands out

/** A store that lives in memory, keyed by login like the file, that counts what is asked of it. */
const memoryStore = (records = {}) => ({
  records,
  reads: 0,
  writes: 0,
  async read(login) {
    this.reads++;
    return this.records[login];
  },
  async write(login, record) {
    this.writes++;
    this.records = { [login]: record }; // one record, like the file: the last write replaces it
  },
  async clear() {
    this.records = {};
  },
});

/** The stand-in client, counting the requests it is made to send. */
const counting = (options) => {
  const inner = client(options);
  const counted = { requests: 0, ...inner };
  counted.fetchUsage = async (token) => {
    counted.requests++;
    return inner.fetchUsage(token);
  };
  return counted;
};

/** A window's own, older reading (PREV's has no time, which a real one always has). */
const OLD = { status: "ok", snapshot: { fiveHour: 10, sevenDay: 20, checkedAt: NOW - 600_000 } };
const READING = { fiveHour: 50, fiveHourReset: "2026-01-01T05:00:00+00:00", sevenDay: 60, sevenDayReset: null, checkedAt: NOW - 5_000 };
const REUSE = 60_000;
const sharing = (store, reuseWithinMs = REUSE) => ({ store, reuseWithinMs });
const asked = (c, prev, store, { reuseWithinMs, logged = [] } = {}) =>
  check(c, prev, (m) => logged.push(m), () => NOW, sharing(store, reuseWithinMs));

test("another window's 429 is waited out: no request, the same wait and streak, the newest reading kept", async () => {
  const store = memoryStore({ [LOGIN]: { snapshot: READING, rateLimit: { retryAt: NOW + 90_000, streak: 2 } } });
  const c = counting();
  const logged = [];
  const next = await asked(c, OLD, store, { logged });
  assert.equal(c.requests, 0, "nothing is sent while another window is told to wait");
  assert.deepEqual(next, { status: "rateLimited", snapshot: READING, retryAt: NOW + 90_000, rateLimitStreak: 2, login: LOGIN });
  assert.match(logged.join("\n"), /another window was rate limited, 90s/);
  assert.equal(store.writes, 0);
});

test("a window that already had a newer reading keeps it when it adopts another's 429", async () => {
  const mine = { fiveHour: 70, sevenDay: 80, checkedAt: NOW - 1_000 };
  const store = memoryStore({ [LOGIN]: { snapshot: READING, rateLimit: { retryAt: NOW + 5_000, streak: 1 } } });
  const next = await asked(counting(), { status: "ok", snapshot: mine }, store);
  assert.equal(next.snapshot, mine);
});

test("a wait in the shared file that no 429 could have asked for is cut down", async () => {
  const store = memoryStore({ [LOGIN]: { rateLimit: { retryAt: NOW + 10 * 24 * 3_600_000, streak: 1 } } });
  const next = await asked(counting(), INITIAL_STATE, store);
  assert.equal(next.retryAt, NOW + 3_600_000);
});

test("when another window's wait is over, a request is sent, and a 429 to it goes on counting from that window's streak", async () => {
  const store = memoryStore({ [LOGIN]: { snapshot: READING, rateLimit: { retryAt: NOW - 1, streak: 2 } } });
  const c = counting({ usageError: new HttpError(429, "Usage fetch failed", undefined) });
  const next = await asked(c, INITIAL_STATE, store);
  assert.equal(c.requests, 1);
  assert.equal(next.rateLimitStreak, 3);
  assert.equal(next.retryAt - NOW, DEFAULT_BACKOFF_MS * 4, "2 min, 4 min, now 8 min");
  assert.equal(next.snapshot, READING, "the reading another window took is still there to show");
});

test("a reading another window took a moment ago is shown as it is, and nothing is sent", async () => {
  const store = memoryStore({ [LOGIN]: { snapshot: READING } });
  const c = counting();
  const logged = [];
  const next = await asked(c, OLD, store, { logged });
  assert.equal(c.requests, 0);
  assert.deepEqual(next, { status: "ok", snapshot: READING, login: LOGIN });
  assert.match(logged.join("\n"), /another window took this reading 5s ago/);
});

test("it clears a state that was not ok: a reading taken meanwhile by another window ends an error or a rate limit", async () => {
  const store = memoryStore({ [LOGIN]: { snapshot: READING } });
  for (const prev of [{ status: "error", error: "x", snapshot: OLD.snapshot }, { status: "rateLimited", retryAt: NOW - 1, rateLimitStreak: 3 }]) {
    const next = await asked(counting(), prev, store);
    assert.deepEqual(next, { status: "ok", snapshot: READING, login: LOGIN }, prev.status);
  }
});

test("a reading is reused only inside the window the caller names: the interval for the timer, 10 s for a manual refresh", async () => {
  const store = memoryStore({ [LOGIN]: { snapshot: READING } }); // taken 5 s ago
  const timer = counting();
  await asked(timer, OLD, store, { reuseWithinMs: 60_000 });
  assert.equal(timer.requests, 0);

  const manual = counting();
  await asked(manual, OLD, store, { reuseWithinMs: MIN_REFRESH_GAP_MS });
  assert.equal(manual.requests, 0, "5 s old is inside 10 s");

  store.records[LOGIN].snapshot = { ...READING, checkedAt: NOW - 15_000 };
  const stale = counting();
  await asked(stale, OLD, store, { reuseWithinMs: MIN_REFRESH_GAP_MS });
  assert.equal(stale.requests, 1, "15 s old is outside 10 s: the user asked for a fresh one");
  store.records[LOGIN].snapshot = { ...READING, checkedAt: NOW - 15_000 }; // (that request replaced it)
  const exactly = counting();
  await asked(exactly, OLD, store, { reuseWithinMs: 15_000 });
  assert.equal(exactly.requests, 1, "as old as the window is too old");
});

test("a reading dated in the future (a clock set back) is not reused", async () => {
  const store = memoryStore({ [LOGIN]: { snapshot: { ...READING, checkedAt: NOW + 10 * 60_000 } } });
  const c = counting();
  await asked(c, OLD, store);
  assert.equal(c.requests, 1);
});

test("a record for another login is not used: another account's reading and 429 mean nothing here", async () => {
  const store = memoryStore({ [loginId("someone-else")]: { snapshot: READING, rateLimit: { retryAt: NOW + 90_000, streak: 4 } } });
  const c = counting();
  const next = await asked(c, INITIAL_STATE, store);
  assert.equal(c.requests, 1);
  assert.equal(next.status, "ok");
  assert.equal(next.snapshot.fiveHour, 36.4, "the reading is the new one, not the other account's");
});

test("what a request finds is told to the other windows: a reading, or a 429 with its wait and the reading kept", async () => {
  const store = memoryStore();
  const ok = await asked(counting(), INITIAL_STATE, store);
  assert.deepEqual(store.records[LOGIN], { snapshot: ok.snapshot });

  const limited = await asked(counting({ usageError: new HttpError(429, "Usage fetch failed", 90_000) }), ok, store, { reuseWithinMs: 0 });
  assert.deepEqual(store.records[LOGIN], { snapshot: ok.snapshot, rateLimit: { retryAt: NOW + 90_000, streak: 1 } });
  assert.equal(limited.retryAt, NOW + 90_000);

  store.records[LOGIN].rateLimit.retryAt = NOW - 1; // the wait is over
  await asked(counting(), limited, store, { reuseWithinMs: 0 });
  assert.equal(store.records[LOGIN].rateLimit, undefined, "a reading after a 429 ends it for every window");
});

test("an error, an expired login or no login tell the other windows nothing, and a missing login is not even looked up", async () => {
  const store = memoryStore({ [LOGIN]: { snapshot: READING } });
  const before = structuredClone(store.records);
  for (const options of [
    { usageError: new Error("offline") },
    { usageError: new HttpError(500, "Usage fetch failed") },
    { usageError: new HttpError(401, "Usage fetch failed") },
  ]) {
    await asked(counting(options), OLD, store, { reuseWithinMs: 0 });
  }
  assert.equal(store.writes, 0);
  assert.deepEqual(store.records, before);

  const reads = store.reads;
  assert.deepEqual(await asked(counting({ token: { kind: "none" } }), OLD, store), { status: "noCreds" });
  assert.equal((await asked(counting({ token: { kind: "expired" } }), OLD, store)).status, "expired");
  assert.equal(store.reads, reads, "no token, nothing to look up");
});

test("without sharing a window behaves as it always did", async () => {
  const next = await check(limited(undefined), PREV, () => {}, () => NOW);
  assert.equal(next.retryAt - NOW, DEFAULT_BACKOFF_MS);
  assert.equal((await check(client(), PREV)).status, "ok");
});

test("two windows on one machine ask about as often as one", async () => {
  const store = memoryStore(); // the shared file
  const api = { requests: 0, answer: "ok" };
  const window = () => ({
    state: INITIAL_STATE,
    async poll(at, reuseWithinMs = REUSE) {
      const c = {
        getToken: async () => ({ kind: "ok", token: "T" }),
        fetchUsage: async () => {
          api.requests++;
          if (api.answer === 429) throw new HttpError(429, "Usage fetch failed", undefined);
          return USAGE;
        },
      };
      this.state = await check(c, this.state, () => {}, () => at, sharing(store, reuseWithinMs));
      return this.state;
    },
  });
  const a = window();
  const b = window();

  // A reads; the user switches to B 20 s later: B shows A's reading, no second request.
  await a.poll(NOW);
  const shown = await b.poll(NOW + 20_000);
  assert.equal(api.requests, 1);
  assert.deepEqual(shown.snapshot, a.state.snapshot);

  // A minute on, the API says no to whoever asks first (B).
  api.answer = 429;
  await b.poll(NOW + 80_000);
  assert.equal(api.requests, 2);
  assert.equal(b.state.status, "rateLimited");

  // The user switches back to A: it does not know, and does not ask; it takes B's wait.
  await a.poll(NOW + 100_000);
  assert.equal(api.requests, 2, "A did not ask during B's wait");
  assert.deepEqual([a.state.status, a.state.retryAt], ["rateLimited", b.state.retryAt]);

  // The wait is over and the API still says no: the backoff goes on from where B left it, whoever asks.
  await a.poll(b.state.retryAt + 1);
  assert.equal(api.requests, 3);
  assert.equal(a.state.rateLimitStreak, 2);
  assert.equal(a.state.retryAt - (b.state.retryAt + 1), DEFAULT_BACKOFF_MS * 2);
});

// ── following the other windows without checking (adoptShared) ───────────────

test("a state read with sharing carries the login it is for, and one read without does not", async () => {
  const store = memoryStore();
  const ok = await asked(counting(), INITIAL_STATE, store, { reuseWithinMs: 0 });
  assert.equal(ok.login, LOGIN);
  const error = await asked(counting({ usageError: new Error("offline") }), OLD, store, { reuseWithinMs: 0 });
  assert.equal(error.login, LOGIN);
  const limited = await asked(counting({ usageError: new HttpError(429, "Usage fetch failed", undefined) }), OLD, store, { reuseWithinMs: 0 });
  assert.equal(limited.login, LOGIN);
  assert.equal("login" in (await check(client(), INITIAL_STATE)), false, "no sharing, no fingerprint");
  assert.equal((await asked(counting({ token: { kind: "expired" } }), OLD, store)).login, undefined, "an expired login has none to look up");
});

const HERE = { status: "ok", login: LOGIN, snapshot: { fiveHour: 10, sevenDay: 20, checkedAt: NOW - 600_000 } };

test("a newer reading another window took is adopted, with its own time, and nothing is asked of the API", () => {
  const logged = [];
  const next = adoptShared(HERE, { snapshot: READING }, NOW, (m) => logged.push(m));
  assert.deepEqual(next, { status: "ok", login: LOGIN, snapshot: READING });
  assert.match(logged.join("\n"), /another window took a newer reading 5s ago/i);
});

test("a reading that is not newer than the one on screen, or none, changes nothing: this window's own write comes back as an event too", () => {
  assert.equal(adoptShared({ ...HERE, snapshot: READING }, { snapshot: READING }, NOW), undefined, "the same reading");
  assert.equal(adoptShared({ ...HERE, snapshot: READING }, { snapshot: { ...READING, checkedAt: READING.checkedAt - 1 } }, NOW), undefined, "an older one");
  assert.equal(adoptShared(HERE, {}, NOW), undefined, "an empty record");
});

test("a reading dated in the future (a clock set back) is not adopted", () => {
  assert.equal(adoptShared(HERE, { snapshot: { ...READING, checkedAt: NOW + 1_000 } }, NOW), undefined);
});

test("a window that has no reading yet adopts any", () => {
  const next = adoptShared({ status: "error", error: "x", login: LOGIN }, { snapshot: READING }, NOW);
  assert.deepEqual(next, { status: "ok", login: LOGIN, snapshot: READING });
});

test("a reading after a 429 ends this window's wait too, and an error gives way to it", () => {
  for (const state of [
    { status: "rateLimited", login: LOGIN, snapshot: HERE.snapshot, retryAt: NOW + 90_000, rateLimitStreak: 2 },
    { status: "error", error: "x", login: LOGIN, snapshot: HERE.snapshot },
  ]) {
    assert.deepEqual(adoptShared(state, { snapshot: READING }, NOW), { status: "ok", login: LOGIN, snapshot: READING }, state.status);
  }
});

test("another window's 429 is adopted as it stands: the same wait and streak, the newest reading kept", () => {
  const logged = [];
  const next = adoptShared(HERE, { snapshot: READING, rateLimit: { retryAt: NOW + 90_000, streak: 2 } }, NOW, (m) => logged.push(m));
  assert.deepEqual(next, { status: "rateLimited", login: LOGIN, snapshot: READING, retryAt: NOW + 90_000, rateLimitStreak: 2 });
  assert.match(logged.join("\n"), /another window was rate limited, 90s/i);

  const mine = { fiveHour: 70, sevenDay: 80, checkedAt: NOW - 1_000 };
  assert.equal(adoptShared({ ...HERE, snapshot: mine }, { snapshot: READING, rateLimit: { retryAt: NOW + 5_000, streak: 1 } }, NOW).snapshot, mine);
});

test("a wait this window already has is not adopted again, but a different one is", () => {
  const known = { status: "rateLimited", login: LOGIN, snapshot: READING, retryAt: NOW + 90_000, rateLimitStreak: 2 };
  const record = { snapshot: READING, rateLimit: { retryAt: NOW + 90_000, streak: 2 } };
  assert.equal(adoptShared(known, record, NOW), undefined, "this window's own 429, seen from the file");
  const later = adoptShared(known, { ...record, rateLimit: { retryAt: NOW + 240_000, streak: 3 } }, NOW);
  assert.deepEqual([later.retryAt, later.rateLimitStreak], [NOW + 240_000, 3], "the last request anyone made is the one that counts");
});

test("a wait that is over, or that no 429 could have asked for, is handled as when a check reads it", () => {
  assert.equal(adoptShared(HERE, { snapshot: READING, rateLimit: { retryAt: NOW - 1, streak: 2 } }, NOW), undefined, "over: the timer asks again");
  const cut = adoptShared(HERE, { rateLimit: { retryAt: NOW + 10 * 24 * 3_600_000, streak: 1 } }, NOW);
  assert.equal(cut.retryAt, NOW + 3_600_000);
});

test("a window with no login to look up, or no login at all, follows nobody", () => {
  const record = { snapshot: READING, rateLimit: { retryAt: NOW + 90_000, streak: 1 } };
  assert.equal(adoptShared({ status: "ok", snapshot: HERE.snapshot }, record, NOW), undefined, "a state from before sharing");
  for (const status of ["loading", "noCreds", "expired"]) {
    assert.equal(adoptShared({ status, login: LOGIN }, record, NOW), undefined, status);
  }
});

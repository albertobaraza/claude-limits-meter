// What the windows of one machine share (src/shared.ts): a file that is read before a request and written after it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FileSharedStore, loginId, watchSharedFile } = require("../../out/shared.js");

const SNAPSHOT = {
  fiveHour: 36.4,
  fiveHourReset: "2026-01-01T05:00:00+00:00",
  sevenDay: 65,
  sevenDayReset: null,
  checkedAt: 1_000_000,
};

/** A store in a folder that does not exist yet, like the extension's storage folder before the first write. */
function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-shared-test-"));
  const file = path.join(dir, "storage", "shared.json");
  return { store: new FileSharedStore(file), file, dir };
}

test("a record written is read back as it was, for the login it was written for", async () => {
  const { store } = makeStore();
  const record = { snapshot: SNAPSHOT, rateLimit: { retryAt: 123_456, streak: 3 } };
  await store.write("login-a", record);
  assert.deepEqual(await store.read("login-a"), record);
});

test("a record of one login is nothing for another: a reading is never shown for the wrong account", async () => {
  const { store } = makeStore();
  await store.write("login-a", { snapshot: SNAPSHOT });
  assert.equal(await store.read("login-b"), undefined);
});

test("with no file, or an unreadable one, nothing is known and nothing throws", async () => {
  const { store, file } = makeStore();
  assert.equal(await store.read("a"), undefined, "no file");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const junk of ["", "not json", "null", "[]", '"text"', "{}", '{"v":1}', JSON.stringify({ v: 2, login: "a", snapshot: SNAPSHOT })]) {
    fs.writeFileSync(file, junk);
    assert.equal(await store.read("a"), undefined, JSON.stringify(junk));
  }
});

test("a record with numbers that are not numbers is dropped piece by piece, not trusted", async () => {
  const { store, file } = makeStore();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const write = (record) => fs.writeFileSync(file, JSON.stringify({ v: 1, login: "a", ...record }));

  write({ snapshot: { ...SNAPSHOT, fiveHour: "12" }, rateLimit: { retryAt: 5, streak: 2 } });
  assert.deepEqual(await store.read("a"), { rateLimit: { retryAt: 5, streak: 2 } }, "a bad reading leaves the good rate limit");

  write({ snapshot: SNAPSHOT, rateLimit: { retryAt: "soon", streak: 2 } });
  assert.deepEqual(await store.read("a"), { snapshot: SNAPSHOT }, "a bad rate limit leaves the good reading");

  for (const streak of [0, -1, 1.5, 1001, "2", null]) {
    write({ rateLimit: { retryAt: 5, streak } });
    assert.equal(await store.read("a"), undefined, `streak ${JSON.stringify(streak)}`);
  }
  write({ snapshot: { ...SNAPSHOT, checkedAt: null } });
  assert.equal(await store.read("a"), undefined);

  write({ snapshot: { ...SNAPSHOT, fiveHourReset: 7, sevenDayReset: { x: 1 } } });
  const { snapshot } = await store.read("a");
  assert.equal(snapshot.fiveHourReset, undefined, "a reset time that is not a string is not carried");
  assert.equal(snapshot.sevenDayReset, undefined);
});

test("a write replaces the whole record: a reading after a 429 leaves no rate limit behind", async () => {
  const { store } = makeStore();
  await store.write("a", { snapshot: SNAPSHOT, rateLimit: { retryAt: 9, streak: 1 } });
  await store.write("a", { snapshot: { ...SNAPSHOT, checkedAt: 2_000_000 } });
  assert.deepEqual(await store.read("a"), { snapshot: { ...SNAPSHOT, checkedAt: 2_000_000 } });
});

test("a write creates the folder, leaves only the file behind, and keeps it to the user (not on Windows)", async () => {
  const { store, file } = makeStore();
  await store.write("a", { snapshot: SNAPSHOT });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["shared.json"], "no temporary file is left");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o077, 0, "the folder is not open to others either");
  }
});

test("the file holds no token, only the login's fingerprint", async () => {
  const { store, file } = makeStore();
  const token = "sk-ant-oat01-this-is-a-secret-access-token";
  await store.write(loginId(token), { snapshot: SNAPSHOT });
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes(token) && !text.includes("secret"));
  assert.ok(text.includes(loginId(token)));
});

test("a write that cannot be made is dropped, and leaves nothing behind", async () => {
  const { dir } = makeStore();
  // The folder the file would go in is a file: the write cannot succeed, and must not throw.
  const blocker = path.join(dir, "blocked");
  fs.writeFileSync(blocker, "x");
  const store = new FileSharedStore(path.join(blocker, "shared.json"));
  await store.write("a", { snapshot: SNAPSHOT });
  assert.equal(await store.read("a"), undefined);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["blocked"]);
});

test("clear forgets the record, and is fine when there is none", async () => {
  const { store } = makeStore();
  await store.clear();
  await store.write("a", { snapshot: SNAPSHOT });
  await store.clear();
  assert.equal(await store.read("a"), undefined);
});

test("two windows writing at once leave a whole record, never half of one", async () => {
  const { store, file } = makeStore();
  const writes = [];
  for (let i = 0; i < 20; i++) writes.push(store.write("a", { snapshot: { ...SNAPSHOT, checkedAt: i } }));
  await Promise.all(writes);
  const record = await store.read("a");
  assert.ok(record && Number.isInteger(record.snapshot.checkedAt));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["shared.json"]);
});

test("loginId tells logins apart, is stable, and is not the token", () => {
  assert.equal(loginId("token-a"), loginId("token-a"));
  assert.notEqual(loginId("token-a"), loginId("token-b"));
  assert.match(loginId("token-a"), /^[0-9a-f]{32}$/);
  assert.ok(!loginId("token-a").includes("token"));
});

// ── watching the file ────────────────────────────────────────────────────────

/** Watches `file` and counts the calls. */
const calls = (file, { debounceMs = 20 } = {}) => {
  let count = 0;
  const stop = watchSharedFile(file, () => count++, debounceMs);
  return { stop, count: () => count };
};
/** Waits for `ok()`, and fails with `what` if it is still false after `limit` ms. */
const until = async (what, ok, limit = 5_000) => {
  const end = Date.now() + limit;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.ok(ok(), `${what}: not seen within ${limit} ms`);
};
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

test("a write to the file is noticed, in a folder that did not exist when the watch began", async () => {
  const { store, file } = makeStore();
  const watching = calls(file);
  try {
    await until("the folder", () => fs.existsSync(path.dirname(file)));
    await store.write("login-a", { snapshot: SNAPSHOT });
    await until("a call", () => watching.count() >= 1);
  } finally {
    watching.stop();
  }
});

test("a burst of writes is one call, and the file read then holds the last of them", async () => {
  const { store, file } = makeStore();
  const watching = calls(file, { debounceMs: 200 });
  try {
    await until("the folder", () => fs.existsSync(path.dirname(file)));
    await settle(100); // the watch itself is set up just after the folder
    for (let i = 0; i < 5; i++) await store.write("login-a", { snapshot: { ...SNAPSHOT, fiveHour: i } });
    await until("a call", () => watching.count() >= 1);
    await settle();
    assert.equal(watching.count(), 1);
    assert.equal((await store.read("login-a")).snapshot.fiveHour, 4);
  } finally {
    watching.stop();
  }
});

test("another file in the folder is not the shared file", async () => {
  const { file } = makeStore();
  const watching = calls(file);
  try {
    await until("the folder", () => fs.existsSync(path.dirname(file)));
    await settle(100);
    fs.writeFileSync(path.join(path.dirname(file), "something-else.json"), "{}");
    await settle();
    assert.equal(watching.count(), 0);
  } finally {
    watching.stop();
  }
});

test("a watch that is stopped calls nothing, even when it is stopped before it began", async () => {
  const { store, file } = makeStore();
  const early = calls(file);
  early.stop(); // before the folder exists
  const late = calls(file);
  await until("the folder", () => fs.existsSync(path.dirname(file)));
  await settle(100);
  late.stop();
  await store.write("login-a", { snapshot: SNAPSHOT });
  await settle();
  assert.deepEqual([early.count(), late.count()], [0, 0]);
});

test("a folder that cannot be made means no watch and no error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-shared-test-"));
  const blocker = path.join(dir, "a-file");
  fs.writeFileSync(blocker, "");
  const watching = calls(path.join(blocker, "storage", "shared.json")); // a folder under a file
  await settle();
  watching.stop();
  assert.equal(watching.count(), 0);
});

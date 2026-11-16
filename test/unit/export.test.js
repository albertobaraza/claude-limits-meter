// What the extension leaves for other programs (src/export.ts): where the folder is, the usage file, the request for a
// fresh reading and the launcher.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { UsageExport, stateDir, toUsage, parseUsage, launcherSource } = require("../../out/export.js");
const { watchSharedFile } = require("../../out/shared.js");

const SNAPSHOT = {
  fiveHour: 36.4,
  fiveHourReset: "2026-01-01T05:00:00+00:00",
  sevenDay: 65,
  sevenDayReset: null,
  checkedAt: Date.parse("2026-01-01T00:00:00Z"),
};
const USAGE = {
  v: 1,
  checkedAt: "2026-01-01T00:00:00.000Z",
  fiveHour: { percent: 36.4, resetsAt: "2026-01-01T05:00:00+00:00" },
  sevenDay: { percent: 65, resetsAt: null },
};

/** The folder as it is before the setting is first switched on: not there yet. */
function makeExport() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-export-test-"));
  const dir = path.join(root, "state", "claude-limits-meter");
  return { files: new UsageExport(dir), dir, root };
}

// ── where the folder is ──

test("on Linux the folder follows XDG_STATE_HOME, and is ~/.local/state without it", () => {
  const at = (env) => stateDir({ platform: "linux", env, home: "/home/ana" });
  assert.equal(at({}), "/home/ana/.local/state/claude-limits-meter");
  assert.equal(at({ XDG_STATE_HOME: "/var/state/ana" }), "/var/state/ana/claude-limits-meter");
  assert.equal(at({ XDG_STATE_HOME: "" }), "/home/ana/.local/state/claude-limits-meter", "empty is unset");
  assert.equal(at({ XDG_STATE_HOME: "state" }), "/home/ana/.local/state/claude-limits-meter", "a relative path is not believed");
});

test("on macOS the folder is in Application Support, whatever XDG says", () => {
  const dir = stateDir({ platform: "darwin", env: { XDG_STATE_HOME: "/elsewhere" }, home: "/Users/ana" });
  assert.equal(dir, "/Users/ana/Library/Application Support/claude-limits-meter");
});

test("on Windows the folder follows LOCALAPPDATA, and is AppData\\Local without it", () => {
  const at = (env) => stateDir({ platform: "win32", env, home: "C:\\Users\\ana" });
  assert.equal(at({ LOCALAPPDATA: "D:\\Local" }), "D:\\Local\\claude-limits-meter");
  assert.equal(at({}), "C:\\Users\\ana\\AppData\\Local\\claude-limits-meter");
  assert.equal(at({ LOCALAPPDATA: "Local" }), "C:\\Users\\ana\\AppData\\Local\\claude-limits-meter", "a relative path is not believed");
});

test("with nothing passed, the folder is this machine's own and absolute", () => {
  const dir = stateDir();
  assert.ok(path.isAbsolute(dir), dir);
  assert.equal(path.basename(dir), "claude-limits-meter");
});

// ── the usage file ──

test("a reading becomes a usage file with no trace of the login", () => {
  assert.deepEqual(toUsage(SNAPSHOT), USAGE);
  assert.deepEqual(toUsage({ fiveHour: 1, sevenDay: 2, checkedAt: 0 }), {
    v: 1,
    checkedAt: "1970-01-01T00:00:00.000Z",
    fiveHour: { percent: 1, resetsAt: null },
    sevenDay: { percent: 2, resetsAt: null },
  });
});

test("a reading published is read back, in a folder made for it and readable by the user alone", async () => {
  const { files, dir } = makeExport();
  assert.equal(await files.read(), undefined, "no folder yet");
  await files.publish({ status: "ok", snapshot: SNAPSHOT });
  assert.deepEqual(await files.read(), USAGE);
  assert.deepEqual(fs.readdirSync(dir), ["usage.json"], "no temporary file is left behind");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(files.usageFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
});

test("the usage file holds the reading and nothing of the login", async () => {
  const { files } = makeExport();
  await files.publish({ status: "ok", snapshot: SNAPSHOT, login: "0123456789abcdef0123456789abcdef" });
  const text = fs.readFileSync(files.usageFile, "utf8");
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["checkedAt", "fiveHour", "sevenDay", "v"]);
  assert.doesNotMatch(text, /0123456789abcdef/);
});

test("the same reading is written once, a newer one replaces it, and a failure keeps the last one", async () => {
  const { files } = makeExport();
  await files.publish({ status: "ok", snapshot: SNAPSHOT });
  fs.rmSync(files.usageFile);
  await files.publish({ status: "ok", snapshot: SNAPSHOT });
  assert.equal(fs.existsSync(files.usageFile), false, "the reading already written is not written again");

  const newer = { ...SNAPSHOT, fiveHour: 50, checkedAt: SNAPSHOT.checkedAt + 60_000 };
  await files.publish({ status: "error", snapshot: newer, error: "x" });
  assert.equal((await files.read()).fiveHour.percent, 50, "a failed check still carries the last good reading");

  await files.publish({ status: "loading" });
  assert.equal((await files.read()).fiveHour.percent, 50, "a state with no reading changes nothing");
});

test("with no login the usage file goes: its reading was for a login that is gone", async () => {
  const { files } = makeExport();
  await files.publish({ status: "ok", snapshot: SNAPSHOT });
  await files.publish({ status: "noCreds" });
  assert.equal(await files.read(), undefined);
  await files.publish({ status: "ok", snapshot: SNAPSHOT });
  assert.deepEqual(await files.read(), USAGE, "and the same reading is written again once there is a login");
});

test("a reading that cannot be written is dropped without throwing, and tried again at the next check", async () => {
  const { files, root } = makeExport();
  fs.writeFileSync(path.join(root, "state"), "a file where the folder should go");
  await files.publish({ status: "ok", snapshot: SNAPSHOT });
  assert.equal(await files.read(), undefined);
  assert.equal(await files.installLauncher("/x/cli.js"), false);
  assert.equal(await files.request(), false);
  fs.rmSync(path.join(root, "state"));
  await files.publish({ status: "ok", snapshot: SNAPSHOT });
  assert.deepEqual(await files.read(), USAGE);
});

test("a folder that was open to others is closed, and one that is a link to somewhere else is not written to", { skip: process.platform === "win32" }, async () => {
  const open = makeExport();
  fs.mkdirSync(open.dir, { recursive: true, mode: 0o755 });
  fs.chmodSync(open.dir, 0o755);
  await open.files.publish({ status: "ok", snapshot: SNAPSHOT });
  assert.equal(fs.statSync(open.dir).mode & 0o777, 0o700);
  assert.deepEqual(await open.files.read(), USAGE);

  const linked = makeExport();
  const elsewhere = path.join(linked.root, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.mkdirSync(path.dirname(linked.dir), { recursive: true });
  fs.symlinkSync(elsewhere, linked.dir);
  await linked.files.publish({ status: "ok", snapshot: SNAPSHOT });
  assert.equal(await linked.files.installLauncher("/x/cli.js"), false, "a program would run a launcher found here");
  assert.deepEqual(fs.readdirSync(elsewhere), [], "nothing was written through the link");
});

test("anything in the usage file that is not a reading is read as none", async () => {
  const { files, dir } = makeExport();
  fs.mkdirSync(dir, { recursive: true });
  const bad = [
    "",
    "not json",
    "null",
    "[]",
    "{}",
    JSON.stringify({ ...USAGE, v: 2 }),
    JSON.stringify({ ...USAGE, checkedAt: 1767225600000 }),
    JSON.stringify({ ...USAGE, checkedAt: "yesterday" }),
    JSON.stringify({ ...USAGE, fiveHour: { percent: "36" } }),
    JSON.stringify({ ...USAGE, sevenDay: null }),
    JSON.stringify({ ...USAGE, sevenDay: { percent: null } }),
  ];
  for (const text of bad) {
    fs.writeFileSync(files.usageFile, text);
    assert.equal(await files.read(), undefined, text);
  }
  assert.deepEqual(parseUsage({ ...USAGE, fiveHour: { percent: 3, resetsAt: 7 }, extra: true }), {
    ...USAGE,
    fiveHour: { percent: 3, resetsAt: null },
  });
});

// ── the request for a fresh reading ──

test("a request cannot be left while the folder is not there: the setting is off, and nobody would answer", async () => {
  const { files, dir } = makeExport();
  assert.equal(await files.request(), false);
  assert.equal(fs.existsSync(dir), false, "and asking does not make the folder");
});

test("a request is taken by one window only, and once", async () => {
  const { files, dir } = makeExport();
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(await files.claimRequest(), false, "nothing to take");
  assert.equal(await files.request(), true);
  const windows = Array.from({ length: 5 }, () => new UsageExport(dir));
  const taken = await Promise.all(windows.map((w) => w.claimRequest()));
  assert.equal(taken.filter(Boolean).length, 1, JSON.stringify(taken));
  assert.equal(await files.claimRequest(), false, "it is gone");
});

test("a request nobody answered is taken back", async () => {
  const { files, dir } = makeExport();
  fs.mkdirSync(dir, { recursive: true });
  await files.request();
  await files.cancelRequest();
  assert.equal(await files.claimRequest(), false);
  await files.cancelRequest(); // with none left, nothing happens
});

test("a window watching the folder is told of a request, and not of the usage file being written", async () => {
  const { files, dir } = makeExport();
  let calls = 0;
  const stop = watchSharedFile(files.requestFile, () => calls++, 30);
  const until = async (what, ok) => {
    const end = Date.now() + 5_000;
    while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    assert.ok(ok(), `${what}: not seen within 5 s`);
  };
  try {
    await until("the folder", () => fs.existsSync(dir));
    await new Promise((r) => setTimeout(r, 100)); // the watch begins just after the folder is made
    await files.publish({ status: "ok", snapshot: SNAPSHOT });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(calls, 0, "the usage file is not a request");
    await files.request();
    await until("the request", () => calls >= 1);
  } finally {
    stop();
  }
});

// ── the launcher ──

test("the launcher runs the command it was written for, from any folder", async () => {
  const { files, root } = makeExport();
  const cli = path.join(root, 'ext "quoted" \\ folder', "cli.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, 'exports.main = () => { console.log("ran " + process.argv.slice(2).join(" ")); process.exitCode = 1; };');
  assert.equal(await files.installLauncher(cli), true);
  if (process.platform !== "win32") assert.equal(fs.statSync(files.launcherFile).mode & 0o777, 0o700);

  let status = 0;
  let out = "";
  try {
    out = execFileSync(process.execPath, [files.launcherFile, "--max-5h", "90"], { encoding: "utf8", cwd: os.tmpdir() });
  } catch (e) {
    status = e.status;
    out = e.stdout;
  }
  assert.equal(out.trim(), "ran --max-5h 90");
  assert.equal(status, 1, "the command's exit status is the launcher's");
});

test("a launcher whose extension is gone says so and cannot tell, instead of a stack trace", async () => {
  const { files, root } = makeExport();
  await files.installLauncher(path.join(root, "gone", "cli.js"));
  assert.throws(
    () => execFileSync(process.execPath, [files.launcherFile], { encoding: "utf8", stdio: "pipe" }),
    (e) => {
      assert.equal(e.status, 2);
      assert.match(e.stderr, /updated or removed/);
      assert.doesNotMatch(e.stderr, /MODULE_NOT_FOUND|at Module/);
      return true;
    },
  );
});

test("the launcher's path is a JSON string: no character of it can end the literal", () => {
  const source = launcherSource('/a/"); process.exit(0); ("/cli.js');
  assert.match(source, /require\("\/a\/\\"\); process\.exit\(0\); \(\\"\/cli\.js"\)\.main\(\);/);
  assert.ok(source.startsWith("#!/usr/bin/env node\n"));
});

// ── switching it off ──

test("switching off removes the three files and the folder, and leaves a folder that holds something else", async () => {
  const { files, dir } = makeExport();
  await files.publish({ status: "ok", snapshot: SNAPSHOT });
  await files.installLauncher("/x/cli.js");
  await files.request();
  await files.remove();
  assert.equal(fs.existsSync(dir), false);
  await files.remove(); // and again, with nothing there

  await files.publish({ status: "ok", snapshot: SNAPSHOT });
  assert.deepEqual(await files.read(), USAGE, "switched on again, the reading it had is written again");
  fs.writeFileSync(path.join(dir, "notes.txt"), "the user's own");
  await files.remove();
  assert.deepEqual(fs.readdirSync(dir), ["notes.txt"]);
});

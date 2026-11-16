// The command a script or an agent runs (src/cli.ts): what it prints and the exit status it answers with, against a folder
// and a clock of the test's own.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { run, parseArgs, span, readingText, EXIT, USAGE, MIN_FRESH_SECONDS, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS } = require("../../out/cli.js");
const { UsageExport } = require("../../out/export.js");

const NOW = Date.parse("2026-01-01T00:00:00Z");
const reading = (fiveHour, sevenDay, ageSeconds = 30) => ({
  fiveHour,
  fiveHourReset: "2026-01-01T02:13:00+00:00",
  sevenDay,
  sevenDayReset: "2026-01-05T02:00:00+00:00",
  checkedAt: NOW - ageSeconds * 1000,
});

/**
 * A folder with the extension's side of it played by the test, and a clock that moves only when the command sleeps.
 * `extension(files, clock)` is called at every sleep, where the real one would be answering the request.
 */
async function setup({ snapshot, on = true, extension } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cli-test-"));
  const dir = path.join(root, "claude-limits-meter");
  const files = new UsageExport(dir);
  if (on) fs.mkdirSync(dir, { recursive: true });
  if (snapshot) await files.publish({ status: "ok", snapshot });
  const clock = { now: NOW, sleeps: 0 };
  const out = [];
  const err = [];
  const deps = {
    dir,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
      clock.sleeps += 1;
      await extension?.(files, clock);
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { files, deps, clock, out, err, go: (...argv) => run(argv, deps) };
}

// ── the reading, as it is ──

test("with no options the last reading is printed, whatever its age, and there is room", async () => {
  const t = await setup({ snapshot: reading(42.9, 18, 3 * 3600) });
  assert.equal(await t.go(), EXIT.room);
  assert.deepEqual(t.out, ["5h 42% (resets in 2h 13m) · 7d 18% (resets in 4d 2h) · checked 3h 0m ago"]);
  assert.deepEqual(t.err, []);
  assert.equal(t.clock.sleeps, 0, "nothing was waited for");
  assert.equal(await t.files.claimRequest(), false, "and nothing was asked of the extension");
});

test("--json prints the reading with its age and a status", async () => {
  const t = await setup({ snapshot: reading(42.9, 18) });
  assert.equal(await t.go("--json"), EXIT.room);
  assert.deepEqual(JSON.parse(t.out[0]), {
    status: "ok",
    checkedAt: "2025-12-31T23:59:30.000Z",
    ageSeconds: 30,
    fiveHour: { percent: 42.9, resetsAt: "2026-01-01T02:13:00+00:00" },
    sevenDay: { percent: 18, resetsAt: "2026-01-05T02:00:00+00:00" },
  });
  assert.equal(t.out.length, 1);
  assert.deepEqual(t.err, [], "with --json everything is in the one line");
});

test("a window with no reset time, or one already past, is printed without a guess", () => {
  const usage = {
    v: 1,
    checkedAt: new Date(NOW - 5_000).toISOString(),
    fiveHour: { percent: 0, resetsAt: null },
    sevenDay: { percent: 99.9, resetsAt: "2025-12-31T00:00:00Z" },
  };
  assert.equal(readingText(usage, NOW), "5h 0% · 7d 99% (resets now) · checked 5s ago");
  assert.equal(readingText({ ...usage, fiveHour: { percent: 1, resetsAt: "soon" } }, NOW), "5h 1% · 7d 99% (resets now) · checked 5s ago");
});

test("a length of time is given to its two largest units", () => {
  assert.equal(span(0), "0s");
  assert.equal(span(-5_000), "0s");
  assert.equal(span(59_999), "59s");
  assert.equal(span(60_000), "1m");
  assert.equal(span(3_600_000), "1h 0m");
  assert.equal(span(26 * 3_600_000 + 59 * 60_000), "1d 2h");
});

// ── the limits ──

test("a limit that is reached fails with 1 and says which, and one that is not leaves room", async () => {
  const t = await setup({ snapshot: reading(91.5, 40) });
  assert.equal(await t.go("--max-5h", "90", "--max-7d", "95"), EXIT.limit);
  assert.deepEqual(t.err, ["claude-limits: the 5-hour session is at 91%, and the limit asked for is 90%"]);
  assert.equal(t.out.length, 1, "the reading is printed all the same");

  const week = await setup({ snapshot: reading(10, 95) });
  assert.equal(await week.go("--max-5h=90", "--max-7d=95"), EXIT.limit, "at the limit is reached");
  assert.match(week.err[0], /the 7-day week is at 95%, and the limit asked for is 95%/);

  const both = await setup({ snapshot: reading(100, 100) });
  assert.equal(await both.go("--max-5h", "90", "--max-7d", "95", "--json"), EXIT.limit);
  const said = JSON.parse(both.out[0]);
  assert.equal(said.status, "limit");
  assert.match(said.message, /5-hour session.*; the 7-day week/);

  const room = await setup({ snapshot: reading(89.9, 94.9) });
  assert.equal(await room.go("--max-5h", "90", "--max-7d", "95"), EXIT.room, "89.9 is under 90");
  assert.deepEqual(room.err, []);
});

// ── a fresh reading ──

test("a reading fresh enough is used as it is: the extension is not asked", async () => {
  const t = await setup({ snapshot: reading(20, 3, 100) });
  assert.equal(await t.go("--fresh", "120"), EXIT.room);
  assert.equal(t.clock.sleeps, 0);
  assert.equal(await t.files.claimRequest(), false);
});

test("an old reading makes the command ask, wait for the extension's answer and judge the new one", async () => {
  let claimed = false;
  const t = await setup({
    snapshot: reading(20, 3, 600),
    extension: async (files, clock) => {
      if (clock.sleeps !== 3) return; // the answer takes three looks to come
      claimed = await files.claimRequest();
      await files.publish({ status: "ok", snapshot: { ...reading(95, 3), checkedAt: clock.now } });
    },
  });
  assert.equal(await t.go("--fresh", "120", "--max-5h", "90"), EXIT.limit, "the limit is judged on the new reading, not the old");
  assert.equal(claimed, true, "the request was there for the extension to take");
  assert.equal(t.clock.sleeps, 3, "and the wait ended as soon as the reading came");
  assert.match(t.out[0], /^5h 95% .* checked 0s ago$/);
});

test("no reading at all is asked for the same way", async () => {
  const t = await setup({
    extension: (files, clock) => files.publish({ status: "ok", snapshot: { ...reading(5, 1), checkedAt: clock.now } }),
  });
  assert.equal(await t.go("--fresh", "60"), EXIT.room);
  assert.match(t.out[0], /^5h 5% /);
});

test("when nobody answers, the command gives up after --wait, cannot tell, and takes its request back", async () => {
  const t = await setup({ snapshot: reading(20, 3, 600) });
  assert.equal(await t.go("--fresh", "120", "--wait", "2", "--max-5h", "90"), EXIT.unknown);
  assert.equal(t.clock.now - NOW, 2_000, "it waited two seconds of its clock");
  assert.match(t.out[0], /^5h 20% /, "the old reading is still shown");
  assert.match(t.err[0], /no reading newer than 10m came in 2s\. Is VS Code running\?/);
  assert.equal(await t.files.claimRequest(), false, "no request is left for a VS Code opened hours later");

  const json = await setup({ snapshot: reading(99, 3, 600) });
  assert.equal(await json.go("--fresh", "120", "--wait", "0", "--max-5h", "90", "--json"), EXIT.unknown, "too old outranks the limit");
  assert.equal(JSON.parse(json.out[0]).status, "stale");
  assert.equal(JSON.parse(json.out[0]).ageSeconds, 600);
});

test("no reading and nobody to give one cannot tell, and says to look at the status bar", async () => {
  const t = await setup();
  assert.equal(await t.go("--fresh", "60", "--wait", "1", "--json"), EXIT.unknown);
  const said = JSON.parse(t.out[0]);
  assert.equal(said.status, "none");
  assert.match(said.message, /Is VS Code running, with Claude Code signed in\?/);
  assert.equal("checkedAt" in said, false);

  const plain = await setup();
  assert.equal(await plain.go("--max-5h", "90"), EXIT.unknown, "without --fresh too: no reading is not room");
  assert.deepEqual(plain.out, []);
  assert.match(plain.err[0], /Is VS Code running/, "the folder is there, so the setting is on");
});

test("with the setting off there is no folder: the command says how to switch it on, and does not wait", async () => {
  const t = await setup({ on: false });
  assert.equal(await t.go("--fresh", "120"), EXIT.unknown);
  assert.match(t.err[0], /Switch on claudeLimitsMeter\.commandLine/);
  assert.equal(t.clock.sleeps, 0);
  assert.equal(fs.existsSync(t.deps.dir), false, "and the folder is not made by asking");

  const plain = await setup({ on: false });
  assert.equal(await plain.go(), EXIT.unknown);
  assert.match(plain.err[0], /Switch on claudeLimitsMeter\.commandLine/, "the same without --fresh");
});

test("an old reading that cannot be asked about cannot tell", async () => {
  const t = await setup({ snapshot: reading(20, 3, 600) });
  fs.mkdirSync(t.files.requestFile); // a folder where the request would go: it cannot be written
  assert.equal(await t.go("--fresh", "120"), EXIT.unknown);
  assert.match(t.err[0], /too old and the extension cannot be asked/);
});

test("a reading from the future is from a clock that went back: not fresh", async () => {
  const t = await setup({ snapshot: reading(20, 3, -3600) });
  assert.equal(await t.go("--fresh", "120", "--wait", "0"), EXIT.unknown);
});

test("a reading that vanishes during the wait (the login went) leaves the old one shown as too old", async () => {
  const t = await setup({
    snapshot: reading(20, 3, 600),
    extension: (files) => files.publish({ status: "noCreds" }),
  });
  assert.equal(await t.go("--fresh", "120", "--wait", "1"), EXIT.unknown);
  assert.match(t.out[0], /^5h 20% /);
});

// ── the options ──

test("options are read in both spellings, and held to what the extension can do", () => {
  assert.deepEqual(parseArgs([]), { waitSeconds: DEFAULT_WAIT_SECONDS, json: false, help: false });
  assert.deepEqual(parseArgs(["--fresh", "300", "--max-5h=90", "--max-7d", "95.5", "--wait=5", "--json"]), {
    freshSeconds: 300,
    max5h: 90,
    max7d: 95.5,
    waitSeconds: 5,
    json: true,
    help: false,
  });
  assert.equal(parseArgs(["--fresh", "5"]).freshSeconds, MIN_FRESH_SECONDS, "the extension asks once a minute at most");
  assert.equal(parseArgs(["--wait", "9999"]).waitSeconds, MAX_WAIT_SECONDS);
  assert.equal(parseArgs(["-h"]).help, true);
});

test("an option that is wrong is refused with the usage, and is never room", async () => {
  for (const argv of [["--max-5h"], ["--max-5h", "ninety"], ["--max-5h", ""], ["--fresh", "-1"], ["--fresh="], ["--loud"], ["90"], ["--wait", "Infinity"]]) {
    assert.ok("error" in parseArgs(argv), JSON.stringify(argv));
    const t = await setup({ snapshot: reading(1, 1) });
    assert.equal(await t.go(...argv), EXIT.unknown, JSON.stringify(argv));
    assert.ok(t.err[0].startsWith("claude-limits: "), t.err[0]);
    assert.ok(t.err[0].includes(USAGE));
    assert.deepEqual(t.out, []);
  }
});

test("--help prints the usage, which names every option and the three exit statuses", async () => {
  const t = await setup();
  assert.equal(await t.go("--help"), EXIT.room);
  assert.deepEqual(t.out, [USAGE]);
  for (const text of ["--fresh", "--max-5h", "--max-7d", "--wait", "--json", "--help", "0 there is room", "1 a limit is reached", "2 cannot tell"]) {
    assert.ok(USAGE.includes(text), text);
  }
});

// ── the program, as it is run ──

/** Runs out/cli.js as a program, with the folder it reads put under `root` on whichever system this is. */
function program(root, ...argv) {
  const env = { ...process.env, HOME: root, USERPROFILE: root, XDG_STATE_HOME: path.join(root, "state"), LOCALAPPDATA: path.join(root, "state") };
  return spawnSync(process.execPath, [path.join(__dirname, "..", "..", "out", "cli.js"), ...argv], { encoding: "utf8", env });
}

test("run as a program, it reads this machine's folder and answers with its exit status", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cli-run-"));
  const { stateDir } = require("../../out/export.js");
  const dir = stateDir({ platform: process.platform, env: { XDG_STATE_HOME: path.join(root, "state"), LOCALAPPDATA: path.join(root, "state") }, home: root });

  const off = program(root, "--max-5h", "90");
  assert.equal(off.status, EXIT.unknown);
  assert.match(off.stderr, /Switch on claudeLimitsMeter\.commandLine/);

  await new UsageExport(dir).publish({ status: "ok", snapshot: { ...reading(91, 3), checkedAt: Date.now() - 1_000 } });
  const full = program(root, "--max-5h", "90");
  assert.equal(full.status, EXIT.limit);
  assert.match(full.stdout, /^5h 91% /);

  const ok = program(root, "--max-5h", "95", "--json");
  assert.equal(ok.status, EXIT.room);
  assert.equal(JSON.parse(ok.stdout).status, "ok");
});

test("the command and the folder's code load nothing that could read a login or open a connection", () => {
  const requires = (file) =>
    [...fs.readFileSync(path.join(__dirname, "..", "..", "out", file), "utf8").matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(requires("cli.js"), ["./export"]);
  assert.deepEqual(requires("export.js"), ["node:crypto", "node:fs/promises", "node:os", "node:path"]);
});

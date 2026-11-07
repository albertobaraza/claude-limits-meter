// The commit convention (CONTRIBUTING.md), as enforced by the commit-msg hook and by CI.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { check, TYPES } = require("../../scripts/check-commit-message.js");

const SCRIPT = path.join(__dirname, "..", "..", "scripts", "check-commit-message.js");

test("accepts a one-liner of every valid type", () => {
  for (const type of TYPES) assert.deepEqual(check(`${type}: something changed\n`), [], type);
});

test("rejects a missing or unknown type, a missing space and an empty description", () => {
  for (const bad of ["something changed", "feature: x", "feat:x", "feat: ", "Feat: x", "feat(scope): x", "ci: x"]) {
    assert.equal(check(bad).length, 1, bad);
  }
});

test("rejects an empty message", () => {
  assert.deepEqual(check("\n\n"), ["the commit message is empty"]);
  assert.deepEqual(check("# only a comment\n"), ["the commit message is empty"]);
});

test("rejects a Co-Authored-By trailer, whatever its case", () => {
  assert.equal(check("fix: x\n\nCo-Authored-By: Someone <a@b.c>").length, 1);
  assert.equal(check("fix: x\n\nco-authored-by: Someone <a@b.c>").length, 1);
});

test("rejects a subject over the length limit", () => {
  assert.equal(check(`fix: ${"x".repeat(100)}`).length, 1);
  assert.deepEqual(check(`fix: ${"x".repeat(90)}`), []);
});

test("ignores the comment lines git puts in the message and leaves merges and reverts alone", () => {
  assert.deepEqual(check("# Please enter the commit message\nfix: real subject\n# more\n"), []);
  assert.deepEqual(check("Merge branch 'main' into feature"), []);
  assert.deepEqual(check('Revert "feat: x"'), []);
});

test("a body is fine", () => {
  assert.deepEqual(check("fix: x\n\nLonger explanation of why."), []);
});

test("as a commit-msg hook: exit 0 for a good message file, 1 for a bad one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msg-"));
  const file = path.join(dir, "COMMIT_EDITMSG");
  fs.writeFileSync(file, "feat: fine\n");
  assert.equal(spawnSync("node", [SCRIPT, file]).status, 0);
  fs.writeFileSync(file, "nope\n");
  const bad = spawnSync("node", [SCRIPT, file], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /subject must look like/);
});

test("with --range: checks every commit in a throwaway repository", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"));
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "chore: base");
  git("commit", "-q", "--allow-empty", "-m", "feat: good one");
  git("commit", "-q", "--allow-empty", "-m", "oops not conventional");
  const run = (range) => spawnSync("node", [SCRIPT, "--range", range], { cwd: dir, encoding: "utf8" });
  assert.equal(run("HEAD~2..HEAD~1").status, 0);
  const bad = run("HEAD~2..HEAD");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /oops not conventional/);
});

test("usage error without arguments", () => {
  assert.equal(spawnSync("node", [SCRIPT]).status, 2);
});

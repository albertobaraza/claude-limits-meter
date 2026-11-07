// The rules tying package.json, CHANGELOG.md and git tags together (scripts/release-metadata.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { entries, notesFor, changelogProblems, unreleasedProblems } = require("../../scripts/release-metadata.js");

const CHANGELOG = `# Changelog

All notable changes are listed here.

## [0.2.0] - 2026-12-01

### Added

- A new thing.


### Fixed

- A bug.

## [0.1.0] - 2026-11-07

Initial version.
`;

test("entries lists versions and dates, newest first", () => {
  assert.deepEqual(entries(CHANGELOG), [
    { version: "0.2.0", date: "2026-12-01" },
    { version: "0.1.0", date: "2026-11-07" },
  ]);
});

test("notesFor returns one section without its heading and tidies blank lines", () => {
  assert.equal(notesFor(CHANGELOG, "0.2.0"), "### Added\n\n- A new thing.\n\n### Fixed\n\n- A bug.");
  assert.equal(notesFor(CHANGELOG, "0.1.0"), "Initial version.");
  assert.equal(notesFor(CHANGELOG, "9.9.9"), undefined);
});

test("package.json and the changelog agree", () => {
  assert.deepEqual(changelogProblems("0.2.0", CHANGELOG), []);
});

test("a version that differs from the top changelog entry is a problem", () => {
  assert.match(changelogProblems("0.1.0", CHANGELOG)[0], /0\.1\.0 but the top CHANGELOG\.md entry is 0\.2\.0/);
});

test("a changelog without entries, a dateless or empty entry, and a bad version are problems", () => {
  assert.match(changelogProblems("0.1.0", "# Changelog\n")[0], /no '## \[X\.Y\.Z\]/);
  assert.match(changelogProblems("0.1.0", "## [0.1.0]\n\nstuff\n").join("\n"), /has no date/);
  assert.match(changelogProblems("0.1.0", "## [0.1.0] - 2026-11-07\n\n## [0.0.1] - 2026-01-01\n- x\n").join("\n"), /is empty/);
  assert.match(changelogProblems("1.0", CHANGELOG)[0], /not X\.Y\.Z/);
});

test("a change to src/ or package.json needs an unreleased version and a changelog entry", () => {
  assert.deepEqual(unreleasedProblems("0.2.0", ["src/view.ts", "CHANGELOG.md"], false, true), []);
  assert.match(unreleasedProblems("0.2.0", ["src/view.ts", "CHANGELOG.md"], true, true)[0], /already released/);
  assert.match(unreleasedProblems("0.2.0", ["src/view.ts"], false, false)[0], /add an entry/);
  assert.equal(unreleasedProblems("0.2.0", ["package.json"], true, false).length, 2);
});

test("docs, tests, CI and tooling changes need no release", () => {
  const files = ["README.md", "test/unit/x.test.js", ".github/workflows/ci.yml", "scripts/setup.sh", "CONTRIBUTING.md", ".pre-commit-config.yaml"];
  assert.deepEqual(unreleasedProblems("0.1.0", files, true, false), []);
});

test("this repository's own package.json and CHANGELOG.md agree (the CLI, end to end)", () => {
  const script = path.join(__dirname, "..", "..", "scripts", "release-metadata.js");
  const res = spawnSync("node", [script, "check-changelog"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const notes = spawnSync("node", [script, "notes"], { encoding: "utf8" });
  assert.equal(notes.status, 0);
  assert.ok(notes.stdout.trim().length > 0);
});

test("the CLI rejects an unknown command", () => {
  const script = path.join(__dirname, "..", "..", "scripts", "release-metadata.js");
  assert.equal(spawnSync("node", [script, "nope"]).status, 2);
});

#!/usr/bin/env node
// Enforces the commit convention in CONTRIBUTING.md. One implementation for both places it runs:
//
//   node scripts/check-commit-message.js <message-file>   the commit-msg git hook
//   node scripts/check-commit-message.js --range A..B     CI, for every commit a pull request adds
//
// A commit subject is `<type>: <description>` with a type from TYPES, and there is never a
// Co-Authored-By trailer. Merge and revert commits are left alone.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const TYPES = ["feat", "fix", "chore", "docs", "refactor", "style", "test"];
const SUBJECT = new RegExp(`^(${TYPES.join("|")}): \\S`);
const MAX_SUBJECT = 100;

/** Problems with one commit message, as readable sentences; empty when it is fine. */
function check(message) {
  const lines = message
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .map((l) => l.trimEnd());
  const subject = (lines.find((l) => l.trim() !== "") ?? "").trim();
  if (/^(Merge|Revert) /.test(subject)) return [];

  const problems = [];
  if (!subject) return ["the commit message is empty"];
  if (!SUBJECT.test(subject)) {
    problems.push(`subject must look like "<type>: <description>" with <type> one of ${TYPES.join(", ")}: "${subject}"`);
  }
  if (subject.length > MAX_SUBJECT) problems.push(`subject is ${subject.length} characters, the limit is ${MAX_SUBJECT}`);
  if (lines.some((l) => /^co-authored-by:/i.test(l))) problems.push("remove the Co-Authored-By trailer");
  return problems;
}

function commitsIn(range) {
  const out = execFileSync("git", ["log", "--format=%H%x1f%B%x1e", range], { encoding: "utf8" });
  return out
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, ...rest] = entry.split("\x1f");
      return { sha: sha.slice(0, 8), message: rest.join("\x1f") };
    });
}

function main(argv) {
  let commits;
  if (argv[0] === "--range" && argv[1]) {
    commits = commitsIn(argv[1]);
  } else if (argv[0] && !argv[0].startsWith("-")) {
    commits = [{ sha: "commit", message: fs.readFileSync(argv[0], "utf8") }];
  } else {
    console.error("usage: check-commit-message.js <message-file> | --range <A..B>");
    return 2;
  }

  let failed = 0;
  for (const { sha, message } of commits) {
    for (const problem of check(message)) {
      console.error(`${sha}: ${problem}`);
      failed++;
    }
  }
  if (failed) console.error("\nSee CONTRIBUTING.md > Commit style.");
  return failed ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { check, TYPES };

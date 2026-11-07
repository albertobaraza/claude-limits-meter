#!/usr/bin/env node
// The rules that tie package.json, CHANGELOG.md and the git tags together. Used by CI and by the
// release workflow, so that each rule exists once and has tests.
//
//   node scripts/release-metadata.js check-changelog          package.json's version is CHANGELOG.md's top entry
//   node scripts/release-metadata.js check-unreleased <base>  a change under src/ (or to package.json) must carry a
//                                                             version that is not released yet, and a changelog entry
//   node scripts/release-metadata.js notes [version]          the CHANGELOG.md section of a version (default: package.json's)
//   node scripts/release-metadata.js version                  package.json's version

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SEMVER = /^\d+\.\d+\.\d+$/;
/** A change to any of these ships to users, so it needs a release entry (docs, tests and CI do not). */
const WATCHED = [/^src\//, /^package\.json$/];
const ENTRY = /^## \[(\d+\.\d+\.\d+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/;

/** The versions in a changelog, newest first, as the file lists them. */
function entries(changelog) {
  return changelog
    .split(/\r?\n/)
    .map((line) => ENTRY.exec(line))
    .filter(Boolean)
    .map((m) => ({ version: m[1], date: m[2] }));
}

/** The body of one version's section, without its heading; undefined when the version has none. */
function notesFor(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => ENTRY.exec(l)?.[1] === version);
  if (start === -1) return undefined;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function changelogProblems(version, changelog) {
  const problems = [];
  if (!SEMVER.test(version)) problems.push(`package.json version "${version}" is not X.Y.Z`);
  const [top] = entries(changelog);
  if (!top) return [...problems, "CHANGELOG.md has no '## [X.Y.Z] - YYYY-MM-DD' entry"];
  if (!top.date) problems.push(`the top CHANGELOG.md entry [${top.version}] has no date`);
  if (top.version !== version) problems.push(`package.json says ${version} but the top CHANGELOG.md entry is ${top.version}`);
  if (!notesFor(changelog, top.version)) problems.push(`the CHANGELOG.md entry for ${top.version} is empty`);
  return problems;
}

/**
 * @param changedFiles paths changed by the pull request
 * @param isReleased whether a release (git tag) already exists for the version
 * @param changelogChanged whether CHANGELOG.md is among the changed files
 */
function unreleasedProblems(version, changedFiles, isReleased, changelogChanged) {
  if (!changedFiles.some((f) => WATCHED.some((re) => re.test(f)))) return [];
  const problems = [];
  if (isReleased) {
    problems.push(`${version} is already released: run the changelog skill (or bump package.json and CHANGELOG.md) before merging`);
  }
  if (!changelogChanged) problems.push("src/ or package.json changed but CHANGELOG.md did not: add an entry");
  return problems;
}

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function readVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
}

function readChangelog() {
  return fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
}

function report(problems) {
  for (const p of problems) console.error(`error: ${p}`);
  return problems.length ? 1 : 0;
}

function main([command, arg]) {
  switch (command) {
    case "version":
      console.log(readVersion());
      return 0;
    case "check-changelog": {
      const code = report(changelogProblems(readVersion(), readChangelog()));
      if (!code) console.log(`package.json and CHANGELOG.md agree on ${readVersion()}`);
      return code;
    }
    case "check-unreleased": {
      if (!arg) {
        console.error("usage: check-unreleased <base-ref>");
        return 2;
      }
      const changed = git("diff", "--name-only", `${arg}...HEAD`).split("\n").filter(Boolean);
      const version = readVersion();
      let released = true;
      try {
        git("rev-parse", "-q", "--verify", `refs/tags/v${version}`);
      } catch {
        released = false;
      }
      return report(unreleasedProblems(version, changed, released, changed.includes("CHANGELOG.md")));
    }
    case "notes": {
      const notes = notesFor(readChangelog(), arg || readVersion());
      if (!notes) {
        console.error(`error: no CHANGELOG.md entry for ${arg || readVersion()}`);
        return 1;
      }
      console.log(notes);
      return 0;
    }
    default:
      console.error("usage: release-metadata.js version | check-changelog | check-unreleased <base-ref> | notes [version]");
      return 2;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { entries, notesFor, changelogProblems, unreleasedProblems };

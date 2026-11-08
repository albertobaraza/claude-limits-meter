#!/usr/bin/env node
// Checks what `vsce package` would put in the .vsix: what the extension needs is there, and nothing
// else (no sources, tests, CI files, Claude settings, secrets or dependencies) is.
//
//   npm run test:package

const { execFileSync } = require("node:child_process");
const path = require("node:path");

// `vsce ls` prints source names; inside the .vsix it renames README.md, CHANGELOG.md and LICENSE.
const MUST_HAVE = ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "out/extension.js", "out/claude.js", "out/state.js", "out/view.js"];
const MUST_NOT_HAVE = [
  /^src\//,
  /^test\//,
  /^scripts\//,
  /^\.github\//,
  /^\.claude\//,
  /^\.vscode\//,
  /^\.vscode-test\//,
  /^node_modules\//,
  /^\.pre-commit-config\.yaml$/,
  /^\.env/,
  /\.map$/,
  /\.vsix$/,
  /^tsconfig\.json$/,
  /^package-lock\.json$/,
  /^CLAUDE\.md$/,
  /^CONTRIBUTING\.md$/,
  /^TODO\.md$/,
];
const MAX_BYTES = 200 * 1024;

function listing() {
  const vsce = path.join(__dirname, "..", "node_modules", ".bin", process.platform === "win32" ? "vsce.cmd" : "vsce");
  const out = execFileSync(vsce, ["ls", "--no-dependencies"], { encoding: "utf8", shell: process.platform === "win32" });
  return out
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\\/g, "/"))
    .filter(Boolean);
}

/** Problems with a list of packaged paths; empty when it is right. */
function check(files) {
  const problems = [];
  const lower = new Set(files.map((f) => f.toLowerCase()));
  for (const need of MUST_HAVE) {
    if (!lower.has(need.toLowerCase())) problems.push(`missing from the package: ${need}`);
  }
  for (const f of files) {
    if (MUST_NOT_HAVE.some((re) => re.test(f))) problems.push(`must not be packaged: ${f}`);
  }
  return problems;
}

if (require.main === module) {
  const files = listing();
  const problems = check(files);
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`package contents ok (${files.length} files):\n  ${files.join("\n  ")}`);
}

module.exports = { check, MAX_BYTES };

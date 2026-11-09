// What run.js (the extension host suite) and ui/run.js (the real window) share: a throwaway
// machine to run on (HOME, profile, extensions, workspace), how VS Code is started on it, and the
// fake Claude login. Nothing here can see the real HOME or the real login.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FAKE_TOKENS } = require("./fake-api");

const ENV = {
  /** The throwaway root, so the suite can refuse to touch a login anywhere else. */
  scratch: "CLAUDE_LIMITS_METER_IT_SCRATCH",
  /** Set in the Docker image: Chromium cannot use its sandbox there, and Xvfb has no GPU. */
  container: "CLAUDE_LIMITS_METER_IT_CONTAINER",
};

/** A new temp folder holding everything a run needs. `dispose()` removes it. */
function makeScratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-usage-it-"));
  const dirs = {
    root,
    home: path.join(root, "home"),
    workspace: path.join(root, "workspace"),
    userData: path.join(root, "user-data"),
    extensions: path.join(root, "extensions"),
  };
  fs.mkdirSync(dirs.home);
  fs.mkdirSync(dirs.workspace);
  return { ...dirs, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** The environment that makes this machine's home the throwaway one (the extension finds its login from it). */
function homeEnv(scratch) {
  return { HOME: scratch.home, USERPROFILE: scratch.home, [ENV.scratch]: scratch.root };
}

/** The command-line flags every VS Code started by a test gets. */
function launchArgs(scratch) {
  return [
    scratch.workspace,
    "--disable-workspace-trust",
    "--user-data-dir",
    scratch.userData,
    "--extensions-dir",
    scratch.extensions,
    // The throwaway HOME has no login keychain, and on macOS Electron may then wait on a Keychain
    // prompt nobody can answer (the CI run hung there). The mock keychain keeps it off the real one.
    ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
    ...(process.env[ENV.container] ? ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] : []),
  ];
}

/**
 * A copy of the environment without what a VS Code terminal leaves in it. `VSCODE_IPC_HOOK_CLI` in particular
 * makes the `code` command forward to the VS Code that terminal belongs to, so an install meant for a throwaway
 * profile would land in the developer's own; `ELECTRON_RUN_AS_NODE` makes a VS Code started below behave as plain Node.
 */
function cleanEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^(vscode_|electron_run_as_node$)/i.test(name)));
}

/** Removes those variables from this process's own environment, which `runTests` passes on to the VS Code it starts. */
function scrubProcessEnv() {
  const clean = cleanEnv();
  for (const name of Object.keys(process.env)) if (!(name in clean)) delete process.env[name];
}

const loginFile = (home) => path.join(home, ".claude", ".credentials.json");

/** Writes a fake Claude Code login. Refuses unless `home` is inside the throwaway root, so it can never overwrite a real one. */
function writeLogin(home, { expired = false, accessToken = FAKE_TOKENS.access, refreshToken = FAKE_TOKENS.refresh } = {}) {
  assertThrowaway(home);
  fs.mkdirSync(path.dirname(loginFile(home)), { recursive: true });
  const expiresAt = Date.now() + (expired ? -60_000 : 3_600_000);
  fs.writeFileSync(loginFile(home), JSON.stringify({ claudeAiOauth: { accessToken, refreshToken, expiresAt } }), { mode: 0o600 });
}

function removeLogin(home) {
  assertThrowaway(home);
  fs.rmSync(loginFile(home), { force: true });
}

function readLogin(home) {
  return JSON.parse(fs.readFileSync(loginFile(home), "utf8")).claudeAiOauth;
}

function assertThrowaway(home) {
  const root = process.env[ENV.scratch];
  const rel = root && path.relative(root, home);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`refusing to touch a login in ${home}: it is not inside the throwaway folder`);
  }
}

module.exports = { ENV, cleanEnv, scrubProcessEnv, makeScratch, homeEnv, launchArgs, writeLogin, removeLogin, readLogin };

// Starts a real VS Code with this extension loaded and runs suite.js inside it.
//
//   npm run test:integration                       latest stable VS Code
//   VSCODE_VERSION=1.85.0 npm run test:integration the oldest version package.json promises
//
// VS Code is downloaded into .vscode-test/ the first time. On Linux without a display, wrap the
// command in `xvfb-run -a`. The profile, the extensions folder and HOME are throwaway, so the run
// never touches your settings or your Claude login (and makes no network call, having no login).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runTests } = require("@vscode/test-electron");

async function main() {
  // Set by VS Code's own terminals (and anything launched from them): it would make the VS Code
  // started below behave as plain Node and try to run the workspace path as a script.
  delete process.env.ELECTRON_RUN_AS_NODE;

  const root = path.resolve(__dirname, "..", "..");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "claude-usage-it-"));
  const home = path.join(scratch, "home");
  const workspace = path.join(scratch, "workspace");
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);

  try {
    await runTests({
      version: process.env.VSCODE_VERSION || "stable",
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, "suite.js"),
      extensionTestsEnv: { HOME: home, USERPROFILE: home },
      launchArgs: [
        workspace,
        "--disable-extensions",
        "--disable-workspace-trust",
        "--user-data-dir",
        path.join(scratch, "user-data"),
        "--extensions-dir",
        path.join(scratch, "extensions"),
        // The throwaway HOME has no login keychain, and on macOS Electron may then wait on a Keychain
        // prompt nobody can answer (the CI run hung there). The mock keychain keeps it off the real one.
        ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
      ],
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

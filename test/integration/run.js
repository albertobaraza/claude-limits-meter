// Starts a real VS Code with this extension loaded and runs suite.js inside it.
//
//   npm run test:integration                       latest stable VS Code
//   VSCODE_VERSION=1.125.0 npm run test:integration the oldest version package.json promises
//
// VS Code is downloaded into .vscode-test/ the first time. On Linux without a display, wrap the
// command in `xvfb-run -a`. The profile, the extensions folder and HOME are throwaway, so the run
// never touches your settings or your Claude login, and the suite writes a fake login into that HOME.
// The only network is a fake of the Claude API on the loopback (fake-api.js): the extension is pointed at
// it through TEST_ENV, which it honours only in a test host.

const path = require("node:path");
const { runTests } = require("@vscode/test-electron");
const { TEST_ENV } = require("../../out/claude.js");
const { homeEnv, launchArgs, makeScratch, scrubProcessEnv } = require("./common");
const { startFakeApi } = require("./fake-api");

async function main() {
  // Set by VS Code's own terminals (and anything launched from them): ELECTRON_RUN_AS_NODE would make the VS Code
  // started below behave as plain Node and try to run the workspace path as a script, and the VSCODE_* ones tie it to the
  // VS Code of that terminal.
  scrubProcessEnv();

  const root = path.resolve(__dirname, "..", "..");
  const scratch = makeScratch();
  const api = await startFakeApi();

  try {
    await runTests({
      version: process.env.VSCODE_VERSION || "stable",
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, "suite.js"),
      extensionTestsEnv: {
        ...homeEnv(scratch),
        [TEST_ENV.usageUrl]: api.usageUrl,
        [TEST_ENV.tokenUrl]: api.tokenUrl,
        [TEST_ENV.noKeychain]: "1", // on macOS, never ask the real Keychain for a login
      },
      launchArgs: [...launchArgs(scratch), "--disable-extensions"],
    });
  } finally {
    await api.close();
    scratch.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

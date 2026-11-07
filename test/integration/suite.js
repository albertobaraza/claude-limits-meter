// Runs inside VS Code's extension host (started by run.js). No test framework: each check is
// a named async function, and any failure makes the whole run fail.

const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

const manifest = require(path.resolve(__dirname, "..", "..", "package.json"));
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;

const checks = {
  "the extension is installed under the id the manifest promises"() {
    assert.ok(vscode.extensions.getExtension(EXTENSION_ID), `${EXTENSION_ID} not found`);
  },

  async "it activates without error"() {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    await ext.activate();
    assert.equal(ext.isActive, true);
  },

  async "every command the manifest declares is registered"() {
    const registered = new Set(await vscode.commands.getCommands(true));
    const declared = manifest.contributes.commands.map((c) => c.command);
    assert.ok(declared.length >= 3);
    for (const id of declared) assert.ok(registered.has(id), `${id} is declared but not registered`);
  },

  "settings are contributed with safe defaults"() {
    const cfg = vscode.workspace.getConfiguration("claudeUsageStatusbar");
    assert.equal(cfg.get("pollIntervalSeconds"), 60);
    assert.equal(cfg.get("refreshExpiredToken"), false, "refreshing a login must stay opt-in");
    assert.equal(cfg.get("clientId"), "");
  },

  async "Refresh Now completes with no Claude login present"() {
    await vscode.commands.executeCommand("claudeUsageStatusbar.refresh");
  },

  async "Open Credentials File completes when the file does not exist"() {
    await vscode.commands.executeCommand("claudeUsageStatusbar.openCredentials");
  },

  async "changing the poll interval is accepted"() {
    const cfg = vscode.workspace.getConfiguration("claudeUsageStatusbar");
    await cfg.update("pollIntervalSeconds", 30, vscode.ConfigurationTarget.Workspace);
    assert.equal(vscode.workspace.getConfiguration("claudeUsageStatusbar").get("pollIntervalSeconds"), 30);
  },
};

async function run() {
  let failed = 0;
  for (const [name, check] of Object.entries(checks)) {
    try {
      await check();
      console.log(`  ok   ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL ${name}\n       ${err && err.message}`);
    }
  }
  if (failed) throw new Error(`${failed} of ${Object.keys(checks).length} integration checks failed`);
}

module.exports = { run };

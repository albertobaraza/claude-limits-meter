// Runs inside VS Code's extension host (started by run.js). No test framework: each check is
// a named async function, and any failure makes the whole run fail. The checks run in order and
// build on each other: the extension is one live object, walked through the states Claude's API can put it in.

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");
const { TEST_ENV } = require("../../out/claude.js");
const { FileSharedStore, loginId } = require("../../out/shared.js");
const { readLogin, removeLogin, writeLogin } = require("./common");
const { FAKE_TOKENS, usageBody } = require("./fake-api");

const manifest = require(path.resolve(__dirname, "..", "..", "package.json"));
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;
const DEV_COLOR = "statusBarItem.warningBackground";

/** The extension's test hooks (`TestApi` in src/extension.ts), set by the second check. */
let api;

// ── the fake Claude API (fake-api.js), which lives in another process ──

const apiOrigin = () => new URL(process.env[TEST_ENV.usageUrl]).origin;

async function control(method, what, body) {
  const res = await fetch(`${apiOrigin()}/__control/${what}`, {
    method,
    body: body && JSON.stringify(body),
  });
  assert.ok(res.ok, `the fake API refused ${method} ${what}: HTTP ${res.status}`);
  return res.status === 204 ? undefined : res.json();
}

/** What the usage endpoint answers from now on. */
const answer = (status, { headers, body } = {}) => control("PUT", "script", { status, headers, body });
const requests = () => control("GET", "log");
const forgetRequests = () => control("DELETE", "log");

const inHours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
const reading = (fiveHour, sevenDay) =>
  usageBody({ fiveHour, sevenDay, fiveHourResets: inHours(2), sevenDayResets: inHours(72) });

/** Runs a check on the extension and returns what its status-bar item shows. */
async function checked() {
  await api.checkNow();
  return api.statusBar();
}

function assertIn(text, expected, what) {
  assert.ok(text.includes(expected), `${what} should contain ${JSON.stringify(expected)}, but is:\n${text}`);
}

const home = () => os.homedir();

const checks = {
  "the extension is installed under the id the manifest promises"() {
    assert.ok(vscode.extensions.getExtension(EXTENSION_ID), `${EXTENSION_ID} not found`);
  },

  async "it activates without error, and a development build hands the test its hooks"() {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    await ext.activate();
    assert.equal(ext.isActive, true);
    api = ext.exports;
    assert.equal(typeof api?.statusBar, "function", "a build that is not the installed extension exposes statusBar()");
    assert.equal(typeof api?.checkNow, "function", "...and checkNow()");
  },

  async "every command the manifest declares is registered"() {
    const registered = new Set(await vscode.commands.getCommands(true));
    const declared = manifest.contributes.commands.map((c) => c.command);
    assert.ok(declared.length >= 3);
    for (const id of declared) assert.ok(registered.has(id), `${id} is declared but not registered`);
  },

  "settings are contributed with safe defaults"() {
    const cfg = vscode.workspace.getConfiguration("claudeLimitsMeter");
    assert.equal(cfg.get("pollIntervalSeconds"), 60);
    assert.equal(cfg.get("showWeekly"), false, "the bar shows the 5-hour session alone unless asked");
    assert.equal(cfg.get("refreshExpiredToken"), false, "refreshing a login must stay opt-in");
    assert.equal(cfg.get("clientId"), "");
  },

  // ── no login yet: the throwaway HOME starts empty ──

  async "with no Claude login the item says so, marked as a development build"() {
    removeLogin(home());
    const item = await checked();
    assert.equal(item.text, "$(sparkle) — DEV");
    assert.equal(item.backgroundColor, DEV_COLOR);
    assertIn(item.tooltip, "$(beaker) **Development build**", "the tooltip");
    assertIn(item.tooltip, "No Claude Code login found", "the tooltip");
    assert.deepEqual(await requests(), [], "without a login nothing is sent anywhere");
  },

  async "Refresh Now completes with no Claude login present"() {
    await vscode.commands.executeCommand("claudeLimitsMeter.refresh");
  },

  async "Open Credentials File completes when the file does not exist"() {
    await vscode.commands.executeCommand("claudeLimitsMeter.openCredentials");
  },

  async "Open Settings completes"() {
    await vscode.commands.executeCommand("claudeLimitsMeter.openSettings");
  },

  // ── a login, and the states the API puts the item in ──

  async "a reading shows the session on the bar and both windows in the tooltip"() {
    writeLogin(home());
    await answer(200, { body: reading(42.7, 13) });
    await forgetRequests();

    const item = await checked();
    assert.equal(item.text, "$(sparkle) 42% DEV");
    assertIn(item.tooltip, "Session (5h) **42%** · Weekly (7d) **13%**", "the tooltip");
    assertIn(item.tooltip, "Last checked", "the tooltip");

    const [sent, ...rest] = await requests();
    assert.deepEqual(rest, [], "one check is one request");
    assert.equal(sent.endpoint, "usage");
    assert.equal(sent.bearer, FAKE_TOKENS.access, "the login's access token is what is sent");
    assert.equal(sent.userAgent, `claude-limits-meter/${manifest.version}`);
    assert.equal(sent.beta, "oauth-2025-04-20");
  },

  async "a 429 keeps the last reading, and Refresh Now then does not ask the API again"() {
    await answer(429, { headers: { "retry-after": "120" } });
    const item = await checked();
    assert.equal(item.text, "$(clock) 42% DEV");
    assertIn(item.tooltip, "rate limiting", "the tooltip");
    assertIn(item.tooltip, "Session (5h) **42%**", "the tooltip, still showing the last reading");

    await forgetRequests();
    await vscode.commands.executeCommand("claudeLimitsMeter.refresh");
    assert.deepEqual(await requests(), [], "inside the Retry-After the command must not reach the API");
    assert.equal(api.statusBar().text, "$(clock) 42% DEV");
  },

  async "a 401 reads as an expired login, with the last reading kept"() {
    await answer(401);
    const item = await checked();
    assert.equal(item.text, "$(sparkle) ! DEV");
    assertIn(item.tooltip, "has expired", "the tooltip");
    assertIn(item.tooltip, "Session (5h) **42%**", "the tooltip");
  },

  async "a 500 shows an error and the status, never a response body"() {
    await answer(500, { body: { error: "boom", leaked: FAKE_TOKENS.access } });
    const item = await checked();
    assert.equal(item.text, "$(sparkle) ✗ DEV");
    assertIn(item.tooltip, "Usage fetch failed: HTTP 500", "the tooltip");
    assert.ok(!item.tooltip.includes("boom") && !item.tooltip.includes(FAKE_TOKENS.access), "the body must not be shown");
  },

  async "a redirect from the API is not followed: VS Code's own fetch never sends the token on to the host it names"() {
    // The same fake answers on `localhost`, which is another origin than the 127.0.0.1 the extension was given: a followed
    // redirect would show up as a second request carrying the token.
    const elsewhere = `${new URL(apiOrigin()).protocol}//localhost:${new URL(apiOrigin()).port}/api/oauth/usage`;
    await answer(307, { headers: { location: elsewhere }, body: { redirected: true } });
    await forgetRequests();
    const item = await checked();
    assert.equal(item.text, "$(sparkle) ✗ DEV");
    assertIn(item.tooltip, "Usage fetch failed: HTTP 307", "the tooltip names the status, as for any other refusal");
    const sent = (await requests()).filter((r) => r.endpoint === "usage");
    assert.equal(sent.length, 1, `the redirect was followed: ${sent.length} requests reached the API`);
  },

  async "it recovers when the API does"() {
    await answer(200, { body: reading(55.1, 20) });
    const item = await checked();
    assert.equal(item.text, "$(sparkle) 55% DEV");
    assertIn(item.tooltip, "Session (5h) **55%** · Weekly (7d) **20%**", "the tooltip");
    assert.ok(!item.tooltip.includes("HTTP 500"), "the error is gone");
  },

  async "showWeekly adds the week to the bar text as soon as it is switched on, and removes it when off"() {
    const cfg = vscode.workspace.getConfiguration("claudeLimitsMeter");
    // The item is re-rendered by the settings-change event, which may land just after update() resolves.
    const barText = async (expected) => {
      for (let i = 0; i < 40 && api.statusBar().text !== expected; i++) await new Promise((r) => setTimeout(r, 50));
      return api.statusBar().text;
    };
    try {
      await cfg.update("showWeekly", true, vscode.ConfigurationTarget.Workspace);
      assert.equal(await barText("$(sparkle) 5h 55% · 7d 20% DEV"), "$(sparkle) 5h 55% · 7d 20% DEV");
    } finally {
      await cfg.update("showWeekly", undefined, vscode.ConfigurationTarget.Workspace);
    }
    assert.equal(await barText("$(sparkle) 55% DEV"), "$(sparkle) 55% DEV");
  },

  // ── an expired login, renewed only when the user opted in ──

  async "an expired login is not renewed by default"() {
    writeLogin(home(), { expired: true });
    await forgetRequests();
    const item = await checked();
    assert.equal(item.text, "$(sparkle) ! DEV");
    assert.deepEqual(await requests(), [], "no token request, and the expired token is never sent");
    assert.equal(readLogin(home()).refreshToken, FAKE_TOKENS.refresh, "the login is left as it was");
  },

  async "a workspace cannot switch renewal on: its .vscode/settings.json is ignored for the two settings that rewrite the login"() {
    const cfg = vscode.workspace.getConfiguration("claudeLimitsMeter");
    await cfg.update("clientId", "11111111-1111-1111-1111-111111111111", vscode.ConfigurationTarget.Workspace);
    await cfg.update("refreshExpiredToken", true, vscode.ConfigurationTarget.Workspace);
    try {
      // (a WorkspaceConfiguration is a snapshot: read it again to see what update() wrote)
      const seen = vscode.workspace.getConfiguration("claudeLimitsMeter");
      assert.equal(seen.get("refreshExpiredToken"), true, "VS Code itself does report the workspace value");
      assert.equal(seen.inspect("refreshExpiredToken").workspaceValue, true, "and says it came from the workspace");
      writeLogin(home(), { expired: true });
      await forgetRequests();
      const item = await checked();
      assert.equal(item.text, "$(sparkle) ! DEV", "the login is still reported as expired");
      assert.deepEqual(await requests(), [], "no token request: the refresh token stayed where it was");
      assert.equal(readLogin(home()).refreshToken, FAKE_TOKENS.refresh, "the login is left as it was");
    } finally {
      await cfg.update("refreshExpiredToken", undefined, vscode.ConfigurationTarget.Workspace);
      await cfg.update("clientId", undefined, vscode.ConfigurationTarget.Workspace);
    }
  },

  async "with renewal switched on in the User settings, the login is renewed, written back and used"() {
    const cfg = vscode.workspace.getConfiguration("claudeLimitsMeter");
    await cfg.update("clientId", "00000000-0000-0000-0000-000000000000", vscode.ConfigurationTarget.Global);
    await cfg.update("refreshExpiredToken", true, vscode.ConfigurationTarget.Global);
    try {
      await forgetRequests();
      const item = await checked();
      assert.equal(item.text, "$(sparkle) 55% DEV");

      const sent = await requests();
      assert.deepEqual(
        sent.map((r) => r.endpoint),
        ["token", "usage"],
        "one renewal, then the usage request",
      );
      assert.equal(sent[0].grantType, "refresh_token");
      assert.equal(sent[0].refreshToken, FAKE_TOKENS.refresh);
      assert.equal(sent[0].clientId, "00000000-0000-0000-0000-000000000000");
      assert.equal(sent[1].bearer, FAKE_TOKENS.renewedAccess, "the renewed token is the one used");

      const saved = readLogin(home());
      assert.equal(saved.accessToken, FAKE_TOKENS.renewedAccess, "the renewed login is written back for Claude Code");
      assert.equal(saved.refreshToken, FAKE_TOKENS.renewedRefresh);
      assert.ok(saved.expiresAt > Date.now() + 30 * 60_000);
    } finally {
      await cfg.update("refreshExpiredToken", undefined, vscode.ConfigurationTarget.Global);
      await cfg.update("clientId", undefined, vscode.ConfigurationTarget.Global);
    }
  },

  // ── another window of the same machine: it shares what it finds out through a file ──

  async "another window's 429 is waited out: nothing is sent, and the item says so with the reading it has"() {
    writeLogin(home());
    await answer(200, { body: reading(61.2, 24) });
    await checked(); // a reading of our own, to show while we wait
    assert.equal(api.statusBar().text, "$(sparkle) 61% DEV");

    // Play the other window: it has just been told to wait two minutes by the API.
    const otherWindow = new FileSharedStore(api.sharedFile);
    const login = loginId(readLogin(home()).accessToken);
    await otherWindow.write(login, { rateLimit: { retryAt: Date.now() + 120_000, streak: 1 } });

    await forgetRequests();
    await api.checkNow({ keepShared: true });
    assert.deepEqual(await requests(), [], "the other window's wait holds for this one too");
    const item = api.statusBar();
    assert.equal(item.text, "$(clock) 61% DEV");
    assertIn(item.tooltip, "rate limiting", "the tooltip");
    assertIn(item.tooltip, "Session (5h) **61%**", "the tooltip, still showing the last reading");

    await vscode.commands.executeCommand("claudeLimitsMeter.refresh");
    assert.deepEqual(await requests(), [], "Refresh Now does not get round it either");
  },

  async "a reading another window has just taken is shown without asking the API"() {
    const otherWindow = new FileSharedStore(api.sharedFile);
    const login = loginId(readLogin(home()).accessToken);
    await otherWindow.write(login, {
      snapshot: { fiveHour: 77, sevenDay: 33, fiveHourReset: inHours(1), sevenDayReset: inHours(48), checkedAt: Date.now() },
    });
    await forgetRequests();
    await api.checkNow({ keepShared: true });
    assert.deepEqual(await requests(), [], "no request for a reading that is seconds old");
    const item = api.statusBar();
    assert.equal(item.text, "$(sparkle) 77% DEV");
    assertIn(item.tooltip, "Session (5h) **77%** · Weekly (7d) **33%**", "the tooltip");
  },

  async "a reading that is old by now is not reused: the API is asked, and the answer is told to the other windows"() {
    const otherWindow = new FileSharedStore(api.sharedFile);
    const login = loginId(readLogin(home()).accessToken);
    await otherWindow.write(login, { snapshot: { fiveHour: 77, sevenDay: 33, checkedAt: Date.now() - 10 * 60_000 } });
    await answer(200, { body: reading(80, 40) });
    await forgetRequests();
    await api.checkNow({ keepShared: true });
    assert.equal((await requests()).length, 1);
    assert.equal(api.statusBar().text, "$(sparkle) 80% DEV");
    assert.equal((await otherWindow.read(login)).snapshot.fiveHour, 80, "the file now holds this window's reading");
  },

  async "a login that is not this one is not believed: another account's 429 does not stop this one"() {
    const otherWindow = new FileSharedStore(api.sharedFile);
    await otherWindow.write(loginId("another-accounts-token"), { rateLimit: { retryAt: Date.now() + 600_000, streak: 5 } });
    await answer(200, { body: reading(10, 5) });
    await forgetRequests();
    await api.checkNow({ keepShared: true });
    assert.equal((await requests()).length, 1);
    assert.equal(api.statusBar().text, "$(sparkle) 10% DEV");
  },

  async "changing the poll interval is accepted"() {
    const cfg = vscode.workspace.getConfiguration("claudeLimitsMeter");
    await cfg.update("pollIntervalSeconds", 30, vscode.ConfigurationTarget.Workspace);
    assert.equal(vscode.workspace.getConfiguration("claudeLimitsMeter").get("pollIntervalSeconds"), 30);
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

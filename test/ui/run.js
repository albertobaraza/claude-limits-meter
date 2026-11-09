// Drives the real VS Code window with the packaged .vsix installed, the way a user has it, and checks what the
// window really shows: the status-bar item, its hover and the menu a click opens. Screenshots of each go to
// .vscode-test/screenshots (CLAUDE_LIMITS_METER_UI_SHOTS changes it).
//
//   xvfb-run -a -s "-screen 0 1280x800x24" npm run test:ui    on Linux without a display
//   npm run test:ui                                           elsewhere
//   npm run test:integration:docker                           in a clean Linux container (this and the extension host suite)
//
// What the extension host suite (../integration) cannot see, this can: the installed .vsix is a Production build
// (no DEV marker, none of the test hooks), and the DOM is what a user sees. The price is that a Production build
// only talks to api.anthropic.com, so this run uses logins that need no network: none, and an expired one. The
// states that need an API answer are walked through by the extension host suite against a fake API.
//
// Everything runs on a throwaway profile, extensions folder and HOME. The install goes through the CLI with
// the VS Code terminal variables removed, so it cannot reach a VS Code of yours that is running.

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath } = require("@vscode/test-electron");
const { _electron } = require("playwright-core");
const { ENV, cleanEnv, homeEnv, launchArgs, makeScratch, writeLogin } = require("../integration/common");

const root = path.resolve(__dirname, "..", "..");
const manifest = require(path.join(root, "package.json"));
const EXTENSION_DIR = `${manifest.publisher}.${manifest.name}-${manifest.version}`;
const SHOTS = process.env.CLAUDE_LIMITS_METER_UI_SHOTS || path.join(root, ".vscode-test", "screenshots");

// ── building and installing ──

function packageExtension(into) {
  const vsix = path.join(into, `${manifest.name}.vsix`);
  const vsce = path.join(root, "node_modules", "@vscode", "vsce", "vsce");
  execFileSync(process.execPath, [vsce, "package", "--no-dependencies", "--out", vsix], { cwd: root, stdio: "pipe" });
  return vsix;
}

/** `code --install-extension`, into the scratch extensions folder. Throws if it went anywhere else. */
function installExtension(executable, vsix, scratch) {
  const cli = resolveCliPathFromVSCodeExecutablePath(executable);
  const result = spawnSync(
    cli,
    ["--install-extension", vsix, "--extensions-dir", scratch.extensions, "--user-data-dir", scratch.userData],
    {
      encoding: "utf8",
      shell: process.platform === "win32", // code.cmd
      env: { ...cleanEnv(), ...homeEnv(scratch), DONT_PROMPT_WSL_INSTALL: "1" },
    },
  );
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, `code --install-extension failed:\n${output}`);
  assert.ok(
    fs.existsSync(path.join(scratch.extensions, EXTENSION_DIR, "package.json")),
    `the extension did not land in ${scratch.extensions}, so it went somewhere it must not:\n${output}`,
  );
}

// ── driving the window ──

async function screenshot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** Retries `fn` until it returns something truthy, so the test waits for what the UI does by itself instead of sleeping. */
async function until(what, fn, timeout = 20_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
}

/** Opens a VS Code window on the scratch machine, runs `scenario(page)`, and always closes it. */
async function inWindow(executable, scratch, name, scenario) {
  const app = await _electron.launch({
    executablePath: executable,
    args: [...launchArgs(scratch), "--skip-welcome", "--skip-release-notes", "--disable-telemetry", "--disable-updates"],
    env: { ...cleanEnv(), ...homeEnv(scratch) },
    timeout: 60_000,
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".monaco-workbench", { timeout: 60_000 });
    await scenario(page);
  } catch (err) {
    // What the window looked like when it failed is the first thing needed to understand why.
    const page = app.windows()[0];
    if (page) {
      await screenshot(page, `${name}-FAILED`).catch(() => {});
      const items = await page.evaluate(() => [...document.querySelectorAll(".statusbar-item")].map((e) => e.outerHTML)).catch(() => []);
      err.message += `\n\nstatus bar items:\n${items.join("\n")}`;
    }
    throw err;
  } finally {
    const child = app.process();
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 10_000))]).catch(() => {});
    if (child.exitCode === null) child.kill();
  }
}

/** The extension's status-bar item, once it shows something other than the "loading" ellipsis. */
async function statusItem(page) {
  const item = page.locator('.statusbar-item[id*="claude-limits-meter"]');
  await until("the Claude Limits Meter status-bar item", async () => (await item.count()) === 1);
  await until("its first check to finish", async () => !(await item.innerText()).includes("…"));
  return item;
}

const hoverText = (page) => page.locator(".monaco-hover:visible, .workbench-hover:visible").first().innerText();

async function pickerRows(page) {
  await page.locator(".quick-input-widget:visible").waitFor();
  await until("the menu rows", async () => (await page.locator(".quick-input-list .monaco-list-row").count()) > 0);
  return page.locator(".quick-input-list .monaco-list-row").allInnerTexts();
}

/** Hover the item and return the tooltip; moves the pointer away first so a tooltip from before cannot be read. */
async function hoverTooltip(page, item, name) {
  await page.mouse.move(0, 0);
  await item.hover();
  await until("the hover", async () => (await hoverText(page)).includes("Claude usage"));
  const text = await hoverText(page);
  await screenshot(page, `${name}-hover`);
  await page.mouse.move(0, 0);
  return text;
}

/** Click the item and return the rows of the menu it opens (the menu stays open). */
async function clickMenu(page, item, name) {
  await item.click();
  const rows = await pickerRows(page);
  await screenshot(page, `${name}-menu`);
  return rows;
}

// ── scenarios ──

const scenarios = {
  async "no login"({ executable, scratch }) {
    await inWindow(executable, scratch, "no-login", async (page) => {
      const item = await statusItem(page);
      assert.equal((await item.innerText()).trim(), "—", "the item shows a dash");
      await screenshot(page, "no-login-bar");

      const tooltip = await hoverTooltip(page, item, "no-login");
      assert.match(tooltip, /No Claude Code login found on this machine/);
      assert.match(tooltip, /Refresh Now/);
      assert.match(tooltip, /Open Credentials File/);
      assert.match(tooltip, /\bSettings\b/);
      assert.doesNotMatch(tooltip, /Development build/, "an installed .vsix is not a development build");

      const rows = await clickMenu(page, item, "no-login");
      const menu = rows.join("\n");
      assert.match(menu, /Usage[\s\S]*no credentials/);
      assert.match(menu, /No Claude Code login found/);
      assert.match(menu, /Refresh Now/);
      assert.match(menu, /Open Credentials File/);
      assert.match(menu, /\bSettings\b/);

      // Picking an entry runs it: with no file to open, the user is told what to do.
      await page.locator(".quick-input-list .monaco-list-row", { hasText: "Open Credentials File" }).click();
      const toast = page.locator(".notifications-toasts:visible, .notification-toast:visible").first();
      await until("the error notification", async () => /Could not open/.test(await toast.innerText()));
      assert.match(await toast.innerText(), /Sign in to Claude Code first/);
      await screenshot(page, "no-login-open-credentials");
    });
  },

  async "expired login"({ executable, scratch }) {
    writeLogin(scratch.home, { expired: true });
    await inWindow(executable, scratch, "expired", async (page) => {
      const item = await statusItem(page);
      assert.equal((await item.innerText()).trim(), "!", "the item shows the expired mark");

      const tooltip = await hoverTooltip(page, item, "expired");
      assert.match(tooltip, /stored Claude token has expired/);
      assert.match(tooltip, /Refresh Now/);

      const menu = (await clickMenu(page, item, "expired")).join("\n");
      assert.match(menu, /Token expired/);
      assert.match(menu, /renews the next time Claude Code is used/);
    });
  },
};

async function main() {
  const only = process.argv[2];
  const scratch = makeScratch();
  process.env[ENV.scratch] = scratch.root; // lets writeLogin prove it is writing into the throwaway HOME
  let failed = 0;
  try {
    const vsix = packageExtension(scratch.root);
    const executable = await downloadAndUnzipVSCode({
      version: process.env.VSCODE_VERSION || "stable",
      cachePath: path.join(root, ".vscode-test"),
    });
    installExtension(executable, vsix, scratch);
    console.log(`  installed ${EXTENSION_DIR} from the packaged .vsix`);

    for (const [name, scenario] of Object.entries(scenarios)) {
      if (only && name !== only) continue;
      fs.rmSync(path.join(scratch.home, ".claude"), { recursive: true, force: true }); // each scenario starts with no login
      try {
        await scenario({ executable, scratch });
        console.log(`  ok   ${name}`);
      } catch (err) {
        failed++;
        console.error(`  FAIL ${name}\n       ${String(err && err.message).replace(/\n/g, "\n       ")}`);
      }
    }
  } finally {
    scratch.dispose();
  }
  console.log(`  screenshots: ${SHOTS}`);
  if (failed) throw new Error(`${failed} UI scenarios failed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

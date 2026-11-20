// The VS Code side: a status-bar item, a timer, the commands and the settings. What is shown
// is decided in state.ts / view.ts and the credentials and API in claude.ts, all testable without VS Code.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { CREDS_PATH, ClaudeClient, SafeError, defaultOptions, findClientId, testOverrides } from "./claude";
import { UsageExport, stateDir } from "./export";
import { FileSharedStore, watchSharedFile } from "./shared";
import {
  INITIAL_STATE,
  MIN_POLL_SECONDS,
  MIN_REFRESH_GAP_MS,
  adoptShared,
  check,
  nextPollDelay,
  pollIntervalMs,
  refreshAllowedAt,
  requestAllowedAt,
  retryAt,
  userSetting,
  type State,
} from "./state";
import { SETTINGS, USAGE_PAGE_URL, devView, menuEntries, statusView } from "./view";

const CMD_MENU = `${SETTINGS}.showMenu`;
const CMD_REFRESH = `${SETTINGS}.refresh`;
const CMD_OPEN_USAGE = `${SETTINGS}.openUsage`;
const CMD_OPEN_CREDS = `${SETTINGS}.openCredentials`;
const CMD_OPEN_SETTINGS = `${SETTINGS}.openSettings`;

/**
 * What `activate()` hands to a test, outside the installed extension only: VS Code has no API to read a status-bar
 * item, and the refresh command refuses to ask the API twice in 10 s, which a test that walks through the states must.
 */
export interface TestApi {
  /** What the status-bar item shows right now. */
  statusBar(): { text: string; tooltip: string; backgroundColor?: string; color?: string };
  /**
   * Waits for a check in flight, then runs a fresh one and returns once its result is on screen. It first forgets what
   * other windows left in the shared file, as if there were none, unless `keepShared` says to take it into account.
   */
  checkNow(options?: { keepShared?: boolean }): Promise<void>;
  /** The file the windows share (see shared.ts), so a test can play another window. */
  sharedFile: string;
  /**
   * Makes the last check look `ms` older than it is. A request from the command line is answered a minute after the last
   * check at the earliest, and a test cannot wait a minute.
   */
  ageLastCheck(ms: number): void;
}

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  // Anything but the installed extension (F5, --extensionDevelopmentPath, the test host) says so on screen.
  const dev = context.extensionMode !== vscode.ExtensionMode.Production;
  const name = dev ? "Claude Limits Meter (dev)" : "Claude Limits Meter";
  const log = vscode.window.createOutputChannel(name);
  const item = vscode.window.createStatusBarItem(`${context.extension.id}.usage`, vscode.StatusBarAlignment.Right, 100);
  item.name = name;
  item.command = CMD_MENU;
  if (dev) item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");

  let state: State = INITIAL_STATE;
  let inFlight: Promise<void> | undefined;
  let lastPollAt = 0;
  let timer: NodeJS.Timeout | undefined;
  /** The tooltip's Markdown as last set, so a redraw that changes nothing leaves an open hover alone. */
  let shownTooltip = "";
  /** Set on deactivation: a check still in flight must not draw, or arm the timer again, after that. */
  let disposed = false;

  const cfg = () => vscode.workspace.getConfiguration(SETTINGS);
  const intervalMs = () => pollIntervalMs(cfg().get<unknown>("pollIntervalSeconds"));
  const logLine = (message: string) => log.appendLine(`${new Date().toISOString()} ${message}`);

  // What the other windows of this machine found out, so that all of them together ask the API about as often as one.
  // The extension's storage folder is on the machine that runs the extension, where the login is.
  const sharedFile = path.join(context.globalStorageUri.fsPath, "shared.json");
  const shared = new FileSharedStore(sharedFile);

  // The settings that decide whether the login is rewritten, and under which client id, are the user's alone: a repository's
  // .vscode/settings.json must not be able to switch them on. The value comes from User settings, never the workspace.
  const warnedKeys = new Set<string>();
  const userOnly = <T>(key: string, fallback: T): T => {
    const { value, ignoredWorkspaceValue } = userSetting(cfg().inspect<T>(key), fallback);
    if (ignoredWorkspaceValue && !warnedKeys.has(key)) {
      warnedKeys.add(key);
      logLine(`Ignoring ${SETTINGS}.${key} from the workspace: it can only be set in your User settings`);
    }
    return value;
  };

  // ── client id (only needed when refreshing an expired token is switched on) ──
  async function resolveClientId(): Promise<string> {
    const override = userOnly<string>("clientId", "").trim();
    if (override) return override;

    const dirs: string[] = [];
    const claudeCode = vscode.extensions.getExtension("anthropic.claude-code");
    if (claudeCode) dirs.push(claudeCode.extensionPath);
    // Installed extensions are siblings of this one; covers Claude Code being hidden from the API.
    const parent = path.dirname(context.extensionPath);
    try {
      const siblings = (await fs.readdir(parent))
        .filter((d) => d.startsWith("anthropic.claude-code-"))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      dirs.push(...siblings.map((d) => path.join(parent, d)));
    } catch {
      // parent not readable; fall through
    }
    const id = await findClientId(dirs);
    if (!id) {
      throw new SafeError(
        "Claude Code extension not found, so the OAuth client id is unknown. " +
          `Install anthropic.claude-code or set ${SETTINGS}.clientId.`,
      );
    }
    return id;
  }

  let renewalOn = userOnly<boolean>("refreshExpiredToken", false) === true;

  // What other programs on this machine may read and ask for (export.ts), when the user switched it on. It makes the extension
  // write outside its own storage folder and take requests from whatever runs as the user, so, like renewal, it is the user's
  // alone to switch on: a workspace's value is ignored.
  const exported = new UsageExport(stateDir());
  let commandLineOn = false;
  let stopWatchingRequests: (() => void) | undefined;

  const client = new ClaudeClient({
    ...defaultOptions({
      userAgent: `claude-limits-meter/${context.extension.packageJSON.version}`,
      refreshEnabled: () => userOnly<boolean>("refreshExpiredToken", false) === true, // only a real `true`: the string "false" is not
      clientId: resolveClientId,
      onNote: logLine,
      onWarn: (message) => {
        logLine(message);
        void vscode.window.showWarningMessage(`Claude Limits Meter: ${message}`);
      },
    }),
    // Only a test host (`--extensionTestsPath`) may redirect the API to a fake one; see TEST_ENV.
    ...(context.extensionMode === vscode.ExtensionMode.Test ? testOverrides(process.env) : {}),
  });

  // ── rendering ──
  function render() {
    const commands = { refresh: CMD_REFRESH, openSettings: CMD_OPEN_SETTINGS };
    const plain = statusView(state, commands, Date.now(), { showWeekly: cfg().get<boolean>("showWeekly", false) });
    const view = dev ? devView(plain) : plain;
    item.text = view.text;
    item.color = view.warn ? new vscode.ThemeColor("terminal.ansiYellow") : undefined;
    if (view.markdown === shownTooltip) return;
    shownTooltip = view.markdown;
    const tooltip = new vscode.MarkdownString(view.markdown, true);
    tooltip.isTrusted = { enabledCommands: [CMD_REFRESH, CMD_OPEN_SETTINGS] };
    item.tooltip = tooltip;
  }

  // ── polling ──
  /**
   * `reuseWithinMs`: a reading another window took less than this long ago is shown instead of asking again. The interval
   * for the timer; less when somebody asked (the user, or a program through the command line) and wants a fresher one.
   */
  function poll(reuseWithinMs = intervalMs()): Promise<void> {
    inFlight ??= (async () => {
      lastPollAt = Date.now();
      state = await check(client, state, logLine, Date.now, { store: shared, reuseWithinMs });
      if (disposed) return;
      render();
      if (commandLineOn) await exported.publish(state);
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  /**
   * Another window wrote the shared file: show what it found out, with no request of our own. This is what keeps a window that
   * is not focused (and so does not check) in step with the others. A check in flight reads the file itself and decides.
   */
  async function followOtherWindows() {
    if (disposed || inFlight || !state.login) return;
    const record = await shared.read(state.login);
    if (!record || disposed || inFlight) return;
    const before = state;
    const next = adoptShared(before, record, Date.now(), logLine);
    if (!next) return;
    state = next;
    render();
    if (retryAt(next) !== retryAt(before)) schedule(); // a wait begins or ends: the timer has to know
  }

  function schedule() {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (disposed) return;
      if (vscode.window.state.focused) await poll(); // nobody is looking at an unfocused window
      schedule();
    }, nextPollDelay(state, intervalMs())); // longer than the interval while Claude is rate limiting us
  }

  async function refreshNow() {
    // Clicking Refresh over and over must not hammer the API (it answers 429): within the minimum gap, or
    // while rate limited, show what we have and say when the next real check can happen.
    const waitMs = refreshAllowedAt(state, lastPollAt) - Date.now();
    if (waitMs > 0) {
      logLine(`Refresh skipped: the next request may be sent in ${Math.ceil(waitMs / 1000)}s`);
      vscode.window.setStatusBarMessage(`Claude Limits Meter: next check in ${Math.ceil(waitMs / 1000)}s`, 3000);
      render();
      return;
    }
    item.text = "$(sync~spin) …";
    await poll(MIN_REFRESH_GAP_MS);
    schedule();
  }

  // ── the command line ──
  /**
   * A program left a request for a fresh reading (see cli.ts). Every window sees it, the one that takes it answers, and
   * focus does not matter: the program asking is usually at work while nobody looks at VS Code. What comes of the check
   * is written to the usage file by `poll`, which is where the program is looking.
   */
  async function answerRequest() {
    if (disposed || !commandLineOn || !(await exported.claimRequest())) return;
    const waitMs = requestAllowedAt(state, lastPollAt) - Date.now();
    if (waitMs > 0 && !inFlight) {
      logLine(`Command-line request not answered: the next request may be sent in ${Math.ceil(waitMs / 1000)}s`);
      return;
    }
    logLine("Command-line request: checking");
    await poll(MIN_POLL_SECONDS * 1000);
    schedule();
  }

  /** Follows the `commandLine` setting: the folder, its launcher and the watch for requests exist only while it is on. */
  async function applyCommandLine() {
    const on = userOnly<boolean>("commandLine", false) === true;
    if (on === commandLineOn || disposed) return;
    commandLineOn = on;
    if (!on) {
      stopWatchingRequests?.();
      stopWatchingRequests = undefined;
      await exported.remove();
      logLine(`Command line switched off: ${exported.dir} removed`);
      return;
    }
    const installed = await exported.installLauncher(path.join(context.extensionPath, "out", "cli.js"));
    logLine(installed ? `Command line switched on: ${exported.launcherFile}` : `Could not write ${exported.launcherFile}`);
    stopWatchingRequests = watchSharedFile(exported.requestFile, () => void answerRequest());
    await inFlight; // a check that began before the setting was on has not written its reading
    if (commandLineOn && !disposed) await exported.publish(state);
    void answerRequest(); // one left while no window was there to see it
  }

  // ── commands ──
  /**
   * Claude's own usage page, in the user's browser. `openExternal` hands it to the machine the window is shown on, so it also
   * works from WSL, Remote-SSH and a container, where this extension runs but there is no browser.
   */
  async function openUsage() {
    const opened = await vscode.env.openExternal(vscode.Uri.parse(USAGE_PAGE_URL));
    if (!opened) logLine(`Could not open ${USAGE_PAGE_URL} in a browser`);
  }

  async function openCredentials() {
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(CREDS_PATH));
    } catch {
      vscode.window.showErrorMessage(`Could not open ${CREDS_PATH}. Sign in to Claude Code first.`);
    }
  }

  /** The Settings editor, filtered to this extension's settings. */
  async function openSettings() {
    await vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${context.extension.id}`);
  }

  async function showMenu() {
    const actions = { refresh: refreshNow, openUsage, openCredentials, openSettings };
    type Item = vscode.QuickPickItem & { run?: () => unknown };
    const items: Item[] = menuEntries(state).map((e) => ({
      label: e.label,
      description: e.description,
      detail: e.detail,
      kind: e.separator ? vscode.QuickPickItemKind.Separator : vscode.QuickPickItemKind.Default,
      run: e.action && actions[e.action],
    }));
    const picked = await vscode.window.showQuickPick(items, { title: name, placeHolder: "Claude usage" });
    await picked?.run?.();
  }

  const stopWatching = watchSharedFile(sharedFile, () => void followOtherWindows());
  // The hover counts down to each reset, so it is drawn again every minute: with the window unfocused, or while Claude is rate
  // limiting us, no check may come for a long time, and the minutes it shows would only be right at the last one.
  const clock = setInterval(render, 60_000);

  context.subscriptions.push(
    log,
    item,
    {
      dispose: () => {
        disposed = true;
        clearTimeout(timer);
        clearInterval(clock);
        stopWatching();
        stopWatchingRequests?.();
      },
    },
    vscode.commands.registerCommand(CMD_MENU, showMenu),
    vscode.commands.registerCommand(CMD_REFRESH, refreshNow),
    vscode.commands.registerCommand(CMD_OPEN_USAGE, openUsage),
    vscode.commands.registerCommand(CMD_OPEN_CREDS, openCredentials),
    vscode.commands.registerCommand(CMD_OPEN_SETTINGS, openSettings),
    vscode.window.onDidChangeWindowState((s) => {
      // catch up right away when the window comes back after skipped polls
      const now = Date.now();
      if (s.focused && now - lastPollAt >= intervalMs() && now >= retryAt(state)) void poll().then(schedule);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SETTINGS}.pollIntervalSeconds`)) schedule();
      if (e.affectsConfiguration(`${SETTINGS}.showWeekly`)) render();
      if (e.affectsConfiguration(`${SETTINGS}.commandLine`)) void applyCommandLine();
      if (e.affectsConfiguration(`${SETTINGS}.refreshExpiredToken`)) {
        // Only the user's own value counts (see userOnly): a repository rewriting its settings file is not a reason to check.
        const on = userOnly<boolean>("refreshExpiredToken", false) === true;
        if (on !== renewalOn) {
          renewalOn = on;
          void refreshNow();
        }
      }
    }),
  );

  render();
  item.show();
  void poll().then(schedule);
  void applyCommandLine();

  if (!dev) return undefined;
  return {
    statusBar: () => ({
      text: item.text,
      tooltip: typeof item.tooltip === "string" ? item.tooltip : (item.tooltip?.value ?? ""),
      // `id` is on every ThemeColor at runtime but missing from @types/vscode.
      backgroundColor: (item.backgroundColor as { id?: string } | undefined)?.id,
      color: (item.color as { id?: string } | undefined)?.id,
    }),
    checkNow: async (options) => {
      await inFlight;
      if (!options?.keepShared) await shared.clear();
      await poll();
    },
    sharedFile,
    ageLastCheck: (ms) => {
      lastPollAt -= ms;
    },
  };
}

export function deactivate() {}

// The VS Code side: a status-bar item, a timer, the commands and the settings. What is shown
// is decided in state.ts / view.ts and the credentials and API in claude.ts, all testable without VS Code.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { CREDS_PATH, ClaudeClient, defaultOptions, findClientId } from "./claude";
import { INITIAL_STATE, check, type State } from "./state";
import { SETTINGS, menuEntries, statusView } from "./view";

const CMD_MENU = `${SETTINGS}.showMenu`;
const CMD_REFRESH = `${SETTINGS}.refresh`;
const CMD_OPEN_CREDS = `${SETTINGS}.openCredentials`;

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("Claude Limits Meter");
  const item = vscode.window.createStatusBarItem(`${context.extension.id}.usage`, vscode.StatusBarAlignment.Right, 100);
  item.name = "Claude Usage";
  item.command = CMD_MENU;

  let state: State = INITIAL_STATE;
  let inFlight: Promise<void> | undefined;
  let lastPollAt = 0;
  let timer: NodeJS.Timeout | undefined;

  const cfg = () => vscode.workspace.getConfiguration(SETTINGS);
  const intervalMs = () => Math.max(15, cfg().get<number>("pollIntervalSeconds", 60)) * 1000;
  const logLine = (message: string) => log.appendLine(`${new Date().toISOString()} ${message}`);

  // ── client id (only needed when refreshing an expired token is switched on) ──
  async function resolveClientId(): Promise<string> {
    const override = cfg().get<string>("clientId", "").trim();
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
      throw new Error(
        "Claude Code extension not found, so the OAuth client id is unknown. " +
          `Install anthropic.claude-code or set ${SETTINGS}.clientId.`,
      );
    }
    return id;
  }

  const client = new ClaudeClient(
    defaultOptions({
      userAgent: `claude-limits-meter/${context.extension.packageJSON.version}`,
      refreshEnabled: () => cfg().get<boolean>("refreshExpiredToken", false),
      clientId: resolveClientId,
      onWarn: (message) => {
        logLine(message);
        void vscode.window.showWarningMessage(`Claude Usage: ${message}`);
      },
    }),
  );

  // ── rendering ──
  function render() {
    const view = statusView(state, { refresh: CMD_REFRESH, openCredentials: CMD_OPEN_CREDS });
    const tooltip = new vscode.MarkdownString(view.markdown, true);
    tooltip.isTrusted = { enabledCommands: [CMD_REFRESH, CMD_OPEN_CREDS] };
    item.text = view.text;
    item.tooltip = tooltip;
  }

  // ── polling ──
  function poll(): Promise<void> {
    inFlight ??= (async () => {
      lastPollAt = Date.now();
      state = await check(client, state, logLine);
      render();
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (vscode.window.state.focused) await poll(); // nobody is looking at an unfocused window
      schedule();
    }, intervalMs());
  }

  async function refreshNow() {
    item.text = "$(sync~spin) …";
    await poll();
    schedule();
  }

  // ── commands ──
  async function openCredentials() {
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(CREDS_PATH));
    } catch {
      vscode.window.showErrorMessage(`Could not open ${CREDS_PATH}. Sign in to Claude Code first.`);
    }
  }

  async function showMenu() {
    const actions = { refresh: refreshNow, openCredentials };
    type Item = vscode.QuickPickItem & { run?: () => unknown };
    const items: Item[] = menuEntries(state).map((e) => ({
      label: e.label,
      description: e.description,
      kind: e.separator ? vscode.QuickPickItemKind.Separator : vscode.QuickPickItemKind.Default,
      run: e.action && actions[e.action],
    }));
    const picked = await vscode.window.showQuickPick(items, { title: "Claude Usage", placeHolder: "Claude usage" });
    await picked?.run?.();
  }

  context.subscriptions.push(
    log,
    item,
    { dispose: () => clearTimeout(timer) },
    vscode.commands.registerCommand(CMD_MENU, showMenu),
    vscode.commands.registerCommand(CMD_REFRESH, refreshNow),
    vscode.commands.registerCommand(CMD_OPEN_CREDS, openCredentials),
    vscode.window.onDidChangeWindowState((s) => {
      // catch up right away when the window comes back after skipped polls
      if (s.focused && Date.now() - lastPollAt >= intervalMs()) void poll().then(schedule);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SETTINGS}.pollIntervalSeconds`)) schedule();
      if (e.affectsConfiguration(`${SETTINGS}.refreshExpiredToken`)) void refreshNow();
    }),
  );

  render();
  item.show();
  void poll().then(schedule);
}

export function deactivate() {}

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  CREDS_PATH,
  ClaudeClient,
  HttpError,
  bar,
  defaultOptions,
  findClientId,
  pctText,
  timeLeft,
} from "./claude";

const CFG = "claudeUsageStatusbar";
const CMD_MENU = `${CFG}.showMenu`;
const CMD_REFRESH = `${CFG}.refresh`;
const CMD_OPEN_CREDS = `${CFG}.openCredentials`;

interface Snapshot {
  fiveHour: number;
  fiveHourReset?: string | null;
  sevenDay: number;
  sevenDayReset?: string | null;
}

type Status = "loading" | "ok" | "noCreds" | "expired" | "error";

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("Claude Usage Status Bar");
  const item = vscode.window.createStatusBarItem(`${context.extension.id}.usage`, vscode.StatusBarAlignment.Right, 100);
  item.name = "Claude Usage";
  item.command = CMD_MENU;

  let status: Status = "loading";
  let snapshot: Snapshot | undefined; // last successful reading, kept across errors
  let errorMessage = "";
  let inFlight: Promise<void> | undefined;
  let lastPollAt = 0;
  let timer: NodeJS.Timeout | undefined;

  const cfg = () => vscode.workspace.getConfiguration(CFG);
  const intervalMs = () => Math.max(15, cfg().get<number>("pollIntervalSeconds", 60)) * 1000;

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
          `Install anthropic.claude-code or set ${CFG}.clientId.`,
      );
    }
    return id;
  }

  const client = new ClaudeClient(
    defaultOptions({
      userAgent: `claude-usage-statusbar/${context.extension.packageJSON.version}`,
      refreshEnabled: () => cfg().get<boolean>("refreshExpiredToken", false),
      clientId: resolveClientId,
      onWarn: (message) => {
        log.appendLine(`${new Date().toISOString()} ${message}`);
        void vscode.window.showWarningMessage(`Claude Usage: ${message}`);
      },
    }),
  );

  // ── rendering ──
  function lines(s: Snapshot) {
    return [
      `Session (5h)  ${bar(s.fiveHour)} ${pctText(s.fiveHour)}   ⏱ ${timeLeft(s.fiveHourReset)}`,
      `Weekly  (7d)  ${bar(s.sevenDay)} ${pctText(s.sevenDay)}   ⏱ ${timeLeft(s.sevenDayReset)}`,
    ];
  }

  function render() {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: [CMD_REFRESH, CMD_OPEN_CREDS] };

    switch (status) {
      case "loading":
        item.text = "$(sparkle) …";
        md.appendMarkdown("**Claude usage**\n\nLoading…");
        break;
      case "noCreds":
        item.text = "$(sparkle) —";
        md.appendMarkdown(
          "**Claude usage**\n\nNo Claude Code login found on this machine. Sign in to Claude Code first " +
            "(run `claude` in a terminal and authenticate).",
        );
        break;
      case "expired":
        item.text = "$(sparkle) !";
        md.appendMarkdown(
          "**Claude usage**\n\nThe stored Claude token has expired. It renews the next time Claude Code " +
            `is used, and this bar picks it up automatically. To renew it from here instead, enable \`${CFG}.refreshExpiredToken\` ` +
            "(not available for the macOS Keychain).",
        );
        break;
      case "error":
        item.text = "$(sparkle) ✗";
        md.appendMarkdown(`**Claude usage**\n\n$(error) ${escapeMd(errorMessage)}`);
        break;
      case "ok":
        item.text = `$(sparkle) ${Math.trunc(snapshot!.fiveHour)}%`;
        md.appendMarkdown("**Claude usage**");
        break;
    }
    if (snapshot && (status === "ok" || status === "error" || status === "expired")) {
      md.appendMarkdown("\n\n").appendCodeblock(lines(snapshot).join("\n"), "text");
    }
    md.appendMarkdown(`\n\n[Refresh Now](command:${CMD_REFRESH}) · [Open Credentials File](command:${CMD_OPEN_CREDS})`);
    item.tooltip = md;
  }

  // ── polling ──
  async function doPoll() {
    lastPollAt = Date.now();
    try {
      const result = await client.getToken();
      if (result.kind !== "ok") {
        status = result.kind === "none" ? "noCreds" : "expired";
        return;
      }
      const data = await client.fetchUsage(result.token);
      snapshot = {
        fiveHour: data.five_hour?.utilization ?? 0,
        fiveHourReset: data.five_hour?.resets_at,
        sevenDay: data.seven_day?.utilization ?? 0,
        sevenDayReset: data.seven_day?.resets_at,
      };
      status = "ok";
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) {
        status = "expired"; // Claude rejected a token that looked valid
      } else {
        status = "error";
        errorMessage = e instanceof Error ? e.message : String(e);
      }
      log.appendLine(`${new Date().toISOString()} ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      render();
    }
  }

  function poll(): Promise<void> {
    inFlight ??= doPoll().finally(() => {
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
    type Entry = vscode.QuickPickItem & { run?: () => unknown };
    const entries: Entry[] = [];
    if (snapshot) {
      const windows = [
        { label: "Session (5h)", pct: snapshot.fiveHour, reset: snapshot.fiveHourReset },
        { label: "Weekly (7d)", pct: snapshot.sevenDay, reset: snapshot.sevenDayReset },
      ];
      for (const w of windows) {
        entries.push({
          label: `$(pulse) ${w.label}`,
          description: `${bar(w.pct)} ${pctText(w.pct).trim()}   ⏱ ${timeLeft(w.reset)}`,
        });
      }
    } else {
      entries.push({ label: "$(pulse) Usage", description: status === "noCreds" ? "no credentials" : "—" });
    }
    entries.push(
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: "$(refresh) Refresh Now", run: refreshNow },
      { label: "$(key) Open Credentials File", run: openCredentials },
    );
    const picked = await vscode.window.showQuickPick(entries, { title: "Claude Usage", placeHolder: "Claude usage" });
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
      if (e.affectsConfiguration(`${CFG}.pollIntervalSeconds`)) schedule();
      if (e.affectsConfiguration(`${CFG}.refreshExpiredToken`)) void refreshNow();
    }),
  );

  render();
  item.show();
  void poll().then(schedule);
}

export function deactivate() {}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

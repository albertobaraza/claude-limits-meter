// Credential lookup, optional token refresh, usage API and formatting. Deliberately
// free of any `vscode` import so it can be unit-tested with plain node (see test/).

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const CREDS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";

/** Runs a command without a shell and resolves with its stdout. */
export type ExecFn = (file: string, args: string[]) => Promise<string>;

const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { timeout: 5000, encoding: "utf8", windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    ),
  );

export interface ClaudeOptions {
  credsPath: string;
  tokenUrl: string;
  usageUrl: string;
  userAgent: string;
  platform: NodeJS.Platform;
  /** Keychain account name Claude Code stores its login under (macOS). */
  username: string;
  exec: ExecFn;
  /** Evaluated on every check so a settings change applies immediately. */
  refreshEnabled: () => boolean;
  /** Resolved lazily: only needed when an expired token is actually refreshed. */
  clientId: () => Promise<string>;
  /** Called when something needs the user's attention (e.g. a refreshed token could not be saved). */
  onWarn: (message: string) => void;
  now: () => number;
}

export function defaultOptions(
  o: Pick<ClaudeOptions, "userAgent" | "refreshEnabled" | "clientId" | "onWarn">,
): ClaudeOptions {
  return {
    credsPath: CREDS_PATH,
    tokenUrl: TOKEN_URL,
    usageUrl: USAGE_URL,
    platform: process.platform,
    username: process.env.USER || process.env.USERNAME || os.userInfo().username,
    exec: defaultExec,
    now: Date.now,
    ...o,
  };
}

interface OAuthCreds {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
}

export interface UsageWindow {
  utilization?: number;
  resets_at?: string | null;
}

export interface Usage {
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
}

export type TokenResult =
  | { kind: "ok"; token: string }
  /** No Claude Code login found on this machine. */
  | { kind: "none" }
  /** A login exists but its access token has expired and we may not (or cannot) renew it. */
  | { kind: "expired" };

/** HTTP failure. Carries only the status, never the response body (could echo tokens). */
export class HttpError extends Error {
  constructor(readonly status: number, what: string) {
    super(`${what}: HTTP ${status}`);
  }
}

// ── reading credentials ──────────────────────────────────────────────────────

function parseCreds(text: string): OAuthCreds | undefined {
  try {
    const creds = JSON.parse(text)?.claudeAiOauth;
    return creds && typeof creds === "object" ? creds : undefined;
  } catch {
    return undefined;
  }
}

/** `security -w` prints the secret hex-encoded when it contains characters it considers unprintable. */
function decodeKeychainOutput(out: string): string {
  return /^(?:[0-9a-fA-F]{2})+$/.test(out) ? Buffer.from(out, "hex").toString("utf8") : out;
}

async function readKeychain(opts: ClaudeOptions): Promise<OAuthCreds | undefined> {
  const attempts = [
    ["find-generic-password", "-a", opts.username, "-s", KEYCHAIN_SERVICE, "-w"],
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], // account name may differ from $USER
  ];
  for (const args of attempts) {
    try {
      const creds = parseCreds(decodeKeychainOutput((await opts.exec("security", args)).trim()));
      if (creds) return creds;
    } catch {
      // item missing or access denied: try the next form, then fall back to the file
    }
  }
  return undefined;
}

async function readCredsFile(opts: ClaudeOptions): Promise<OAuthCreds | undefined> {
  try {
    return parseCreds(await fs.readFile(opts.credsPath, "utf8"));
  } catch {
    return undefined;
  }
}

// ── client ───────────────────────────────────────────────────────────────────

export class ClaudeClient {
  /** A refreshed login we could not write to disk. Newer than the file, so it wins over it. */
  private unsaved?: OAuthCreds;

  constructor(private readonly opts: ClaudeOptions) {}

  private isFresh(c: OAuthCreds): c is OAuthCreds & { accessToken: string } {
    return !!c.accessToken && this.opts.now() < (c.expiresAt ?? 0) - 60_000;
  }

  /** macOS keeps Claude Code's login in the Keychain; everywhere else (and as a fallback) it is a file. */
  private async load(): Promise<{ creds: OAuthCreds; source: "keychain" | "file" } | undefined> {
    if (this.opts.platform === "darwin") {
      const creds = await readKeychain(this.opts);
      if (creds) return { creds, source: "keychain" };
    }
    const creds = await readCredsFile(this.opts);
    return creds && { creds, source: "file" };
  }

  /**
   * A usable access token. The login is re-read on every call, so a token that Claude Code
   * has refreshed in the meantime is picked up without doing anything here.
   *
   * Refreshing ourselves is opt-in and only ever done for a login stored in a file: refresh
   * tokens rotate, and we will not write to the macOS Keychain, so refreshing there would
   * invalidate the copy Claude Code holds. Throws when a permitted refresh fails.
   */
  async getToken(): Promise<TokenResult> {
    const loaded = await this.load();
    let creds = loaded?.creds;
    if (this.unsaved && (!creds || (this.unsaved.expiresAt ?? 0) > (creds.expiresAt ?? 0))) creds = this.unsaved;
    if (!creds) return { kind: "none" };
    if (this.isFresh(creds)) return { kind: "ok", token: creds.accessToken };

    const canWrite = !loaded || loaded.source === "file";
    if (!creds.refreshToken || !canWrite || !this.opts.refreshEnabled()) return { kind: "expired" };

    try {
      const data = await this.refresh(creds.refreshToken);
      const next: OAuthCreds = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? creds.refreshToken,
        expiresAt: this.opts.now() + data.expires_in * 1000,
      };
      await this.persist(next);
      return { kind: "ok", token: data.access_token };
    } catch (e) {
      // Refresh tokens rotate: Claude Code or another VS Code window may have just refreshed
      // and invalidated ours. If the file now holds a fresh token, use it.
      const latest = await readCredsFile(this.opts);
      if (latest && this.isFresh(latest)) return { kind: "ok", token: latest.accessToken };
      throw e;
    }
  }

  private async refresh(refreshToken: string) {
    const res = await fetch(this.opts.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": this.opts.userAgent },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: await this.opts.clientId(),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new HttpError(res.status, "Token refresh failed");
    return (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  }

  /** Write the refreshed login back so Claude Code itself benefits too. Never throws. */
  private async persist(next: OAuthCreds) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeCreds(this.opts, next);
        this.unsaved = undefined;
        return;
      } catch {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 300));
      }
    }
    // The old refresh token is now dead, so keep the new one in memory rather than lose it.
    this.unsaved = next;
    this.opts.onWarn(
      `Refreshed the Claude login but could not save it to ${this.opts.credsPath}. ` +
        "Claude Code may ask you to sign in again.",
    );
  }

  async fetchUsage(token: string): Promise<Usage> {
    const res = await fetch(this.opts.usageUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA,
        "User-Agent": this.opts.userAgent,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new HttpError(res.status, "Usage fetch failed");
    return (await res.json()) as Usage;
  }
}

async function writeCreds(opts: ClaudeOptions, next: OAuthCreds) {
  // Follow a symlinked credentials file (dotfile setups) instead of replacing the link.
  const target = await fs.realpath(opts.credsPath);
  const raw = JSON.parse(await fs.readFile(target, "utf8"));
  raw.claudeAiOauth = { ...raw.claudeAiOauth, ...next };
  const mode = (await fs.stat(target)).mode & 0o777; // no-op on Windows
  // Write-then-rename so Claude Code never reads a half-written file.
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(raw, null, 2), { mode });
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/** Find the OAuth client id Claude Code ships with, in the given extension directories. */
export async function findClientId(extensionDirs: string[]): Promise<string | undefined> {
  for (const dir of extensionDirs) {
    try {
      const js = await fs.readFile(path.join(dir, "extension.js"), "utf8");
      const m = /CLIENT_ID:"([0-9a-f-]{36})"/.exec(js);
      if (m) return m[1];
    } catch {
      // not there, try the next one
    }
  }
  return undefined;
}

// ── formatting ───────────────────────────────────────────────────────────────

export function bar(pct: number, width = 10): string {
  const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function pctText(p: number): string {
  return `${Math.trunc(p)}`.padStart(3) + "%";
}

export function timeLeft(resetsAt: string | null | undefined, now = Date.now()): string {
  if (!resetsAt) return "?";
  const reset = Date.parse(resetsAt);
  if (Number.isNaN(reset)) return "?";
  const total = Math.floor((reset - now) / 1000);
  if (total <= 0) return "now";
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  return h ? `${h}h ${m}m` : `${m}m`;
}

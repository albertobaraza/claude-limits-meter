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

/**
 * What a test host may set to point the extension at a fake API. `extension.ts` reads them only when VS Code
 * says it is running tests (`ExtensionMode.Test`); an installed extension never looks at them.
 */
export const TEST_ENV = {
  usageUrl: "CLAUDE_LIMITS_METER_TEST_USAGE_URL",
  tokenUrl: "CLAUDE_LIMITS_METER_TEST_TOKEN_URL",
  /** Any non-empty value: never run `security`, so a test on macOS cannot read a real login. */
  noKeychain: "CLAUDE_LIMITS_METER_TEST_NO_KEYCHAIN",
} as const;

/**
 * An http URL on this machine's loopback, or a thrown error. Even in a test host the login can only be sent to
 * a fake API on this machine, so the "only api.anthropic.com" promise holds however the environment is set.
 */
function loopbackUrl(name: string, value: string): string {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    // reported below
  }
  if (!url || url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(`${name} must be an http URL on 127.0.0.1, localhost or [::1]`);
  }
  return value;
}

/** The options a test host asks for through `TEST_ENV`; none when it asks for nothing. Throws on a URL that is not loopback. */
export function testOverrides(env: NodeJS.ProcessEnv): Partial<Pick<ClaudeOptions, "usageUrl" | "tokenUrl" | "exec">> {
  const out: Partial<Pick<ClaudeOptions, "usageUrl" | "tokenUrl" | "exec">> = {};
  const usage = env[TEST_ENV.usageUrl];
  const token = env[TEST_ENV.tokenUrl];
  if (usage) out.usageUrl = loopbackUrl(TEST_ENV.usageUrl, usage);
  if (token) out.tokenUrl = loopbackUrl(TEST_ENV.tokenUrl, token);
  if (env[TEST_ENV.noKeychain]) out.exec = () => Promise.reject(new Error("the Keychain is switched off in tests"));
  return out;
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

/**
 * HTTP failure. Carries only the status (and the server's retry hint), never the response body (could echo
 * tokens).
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    what: string,
    /** How long the server asked us to wait (Retry-After), clamped, in milliseconds. */
    readonly retryAfterMs?: number,
  ) {
    super(`${what}: HTTP ${status}`);
  }
}

/**
 * An answer that is not the shape the API documents (not JSON, or fields missing). The message is fixed: the
 * parser's own message quotes the start of the body, which must never reach the screen or the log.
 */
export class BadResponseError extends Error {
  constructor(what: string) {
    super(`${what}: unexpected response`);
  }
}

const RETRY_AFTER_MIN_MS = 5_000;
const RETRY_AFTER_MAX_MS = 60 * 60_000;

/**
 * The Retry-After header as milliseconds: either a number of seconds or an HTTP date. Anything else is
 * `undefined`; a value that is too small or large is clamped, so an odd header can neither make us spin nor
 * park the bar for a day.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  let ms: number;
  if (/^\d+$/.test(v)) {
    ms = Number(v) * 1000;
  } else {
    const date = Date.parse(v);
    if (Number.isNaN(date)) return undefined;
    ms = date - now;
  }
  return Math.min(Math.max(ms, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
}

// ── reading credentials ──────────────────────────────────────────────────────

/** A bearer token is printable ASCII without a space: nothing else can be sent in a header, and Anthropic does not issue one. */
const TOKEN_RE = /^[\x21-\x7e]+$/;

function parseCreds(text: string): OAuthCreds | undefined {
  try {
    const creds = JSON.parse(text)?.claudeAiOauth;
    if (!creds || typeof creds !== "object") return undefined;
    // A malformed access token is no token (the login then reads as expired). Handing it to fetch would make fetch throw an
    // error that quotes the value, and that error is shown in the tooltip and written to the log.
    if (typeof creds.accessToken !== "string" || !TOKEN_RE.test(creds.accessToken)) return { ...creds, accessToken: undefined };
    return creds;
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
    const what = "Token refresh failed";
    const res = await fetch(this.opts.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": this.opts.userAgent },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: await this.opts.clientId(),
      }),
      // Never follow a redirect: a 307/308 would send this body, the refresh token, to whatever host it names.
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new HttpError(res.status, what); // a redirect is not ok either
    const data = await readJson(res, what);
    if (!isTokenResponse(data)) throw new BadResponseError(what);
    return data;
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
      redirect: "manual", // see refresh(): the answer to a redirect is an error, not a second request
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new HttpError(res.status, "Usage fetch failed", parseRetryAfter(res.headers.get("retry-after")));
    const data = await readJson(res, "Usage fetch failed");
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new BadResponseError("Usage fetch failed");
    return data as Usage;
  }
}

/** The body as JSON, or a `BadResponseError` that says nothing about what the body was. */
async function readJson(res: Response, what: string): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new BadResponseError(what);
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

/** What the token endpoint must have answered before anything of it is written over the login on disk. */
function isTokenResponse(d: unknown): d is TokenResponse {
  if (!d || typeof d !== "object") return false;
  const t = d as Record<string, unknown>;
  return (
    typeof t.access_token === "string" &&
    TOKEN_RE.test(t.access_token) &&
    typeof t.expires_in === "number" &&
    Number.isFinite(t.expires_in) &&
    t.expires_in > 0 &&
    (t.refresh_token === undefined || (typeof t.refresh_token === "string" && t.refresh_token !== ""))
  );
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

/**
 * Claude Code's bundle holds several OAuth configurations next to each other: the production one, a local-development one and
 * a design client, in an order the bundler decides. Each looks like `CLIENT_ID:"<uuid>",DESIGN_CLIENT_ID:"<uuid>",
 * OAUTH_FILE_SUFFIX:"<suffix>",...`, and only the production one has an empty suffix (a local or custom one has `-local-oauth`
 * or similar). A refresh token must be presented under the client id it was issued to, so a configuration with a suffix is
 * skipped, and so is a `DESIGN_CLIENT_ID`, which ends in the same text.
 */
const CLIENT_ID_CONFIG = /(?<![A-Za-z0-9_])CLIENT_ID:"([0-9a-f-]{36})"([^}]{0,600})/g;

/** Find the production OAuth client id Claude Code ships with, in the given extension directories. */
export async function findClientId(extensionDirs: string[]): Promise<string | undefined> {
  for (const dir of extensionDirs) {
    try {
      const js = await fs.readFile(path.join(dir, "extension.js"), "utf8");
      for (const m of js.matchAll(CLIENT_ID_CONFIG)) {
        const suffix = /OAUTH_FILE_SUFFIX:"([^"]*)"/.exec(m[2]);
        if (!suffix || suffix[1] === "") return m[1];
      }
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

/** "14:32": the local 24-hour clock time of an epoch-ms timestamp. */
export function clockTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
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

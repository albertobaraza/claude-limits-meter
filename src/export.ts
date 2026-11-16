// What the extension leaves for other programs on this machine, when `claudeLimitsMeter.commandLine` is on: a script, or a
// coding agent that wants to know whether there is room before it starts a long job. Three files in one folder: the last
// reading, a request for a fresh one, and a launcher for the command in cli.ts. Free of any `vscode` import, so it is
// unit-tested with plain node, and of any import of claude.ts: nothing here, or in the command, can read a login.
//
// It is not the file the windows share (shared.ts). That one lives in VS Code's storage folder, whose path depends on the
// platform and on which VS Code it is, and carries the login's fingerprint. This one is in a place another program can
// find, and holds the reading alone.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Snapshot, Status } from "./state";

const FOLDER = "claude-limits-meter";
const USAGE_FILE = "usage.json";
const REQUEST_FILE = "refresh-request";
const LAUNCHER_FILE = "claude-limits.cjs";
const VERSION = 1;

/** What decides where the folder is. Passed in so that every platform's rule is tested on any one of them. */
export interface Place {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}

/**
 * The folder, where each system keeps a program's state: `%LOCALAPPDATA%\claude-limits-meter` on Windows,
 * `~/Library/Application Support/claude-limits-meter` on macOS, and `$XDG_STATE_HOME/claude-limits-meter` (which is
 * `~/.local/state/claude-limits-meter` unless set otherwise) on Linux, WSL and remote hosts. A variable that is not an
 * absolute path is not believed, as the XDG specification asks.
 */
export function stateDir(place: Place = { platform: process.platform, env: process.env, home: os.homedir() }): string {
  const { platform, env, home } = place;
  if (platform === "win32") {
    const p = path.win32;
    const local = env.LOCALAPPDATA;
    return p.join(local && p.isAbsolute(local) ? local : p.join(home, "AppData", "Local"), FOLDER);
  }
  const p = path.posix;
  if (platform === "darwin") return p.join(home, "Library", "Application Support", FOLDER);
  const state = env.XDG_STATE_HOME;
  return p.join(state && p.isAbsolute(state) ? state : p.join(home, ".local", "state"), FOLDER);
}

/** One of the two windows of a reading, as the usage file has it. */
export interface UsageWindow {
  /** 0 to 100, as Claude reports it (it may have decimals). */
  percent: number;
  /** When the window starts again (ISO 8601), or `null` when Claude did not say. */
  resetsAt: string | null;
}

/** The usage file: the last reading and when it was taken. No token, and no fingerprint of one. */
export interface Usage {
  v: typeof VERSION;
  /** ISO 8601, UTC. */
  checkedAt: string;
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
}

export function toUsage(snapshot: Snapshot): Usage {
  return {
    v: VERSION,
    checkedAt: new Date(snapshot.checkedAt).toISOString(),
    fiveHour: { percent: snapshot.fiveHour, resetsAt: snapshot.fiveHourReset ?? null },
    sevenDay: { percent: snapshot.sevenDay, resetsAt: snapshot.sevenDayReset ?? null },
  };
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function parseWindow(x: unknown): UsageWindow | undefined {
  if (!isObject(x) || typeof x.percent !== "number" || !Number.isFinite(x.percent)) return undefined;
  return { percent: x.percent, resetsAt: typeof x.resetsAt === "string" ? x.resetsAt : null };
}

/** A usage file's content, or `undefined` for anything that is not one: what is read from disk is not trusted. */
export function parseUsage(raw: unknown): Usage | undefined {
  if (!isObject(raw) || raw.v !== VERSION || typeof raw.checkedAt !== "string") return undefined;
  if (Number.isNaN(Date.parse(raw.checkedAt))) return undefined;
  const fiveHour = parseWindow(raw.fiveHour);
  const sevenDay = parseWindow(raw.sevenDay);
  return fiveHour && sevenDay ? { v: VERSION, checkedAt: raw.checkedAt, fiveHour, sevenDay } : undefined;
}

/** What the launcher holds. The path goes in as a JSON string, so no character of it can end the literal. */
export function launcherSource(cliPath: string): string {
  return [
    "#!/usr/bin/env node",
    "// Written by the Claude Limits Meter extension each time it starts, so that this path stays the same from one",
    "// version to the next. It runs the command of the installed version. Deleting it is harmless.",
    "try {",
    `  require(${JSON.stringify(cliPath)}).main();`,
    "} catch {",
    '  console.error("claude-limits: the extension was updated or removed. Open VS Code once and run this again.");',
    "  process.exitCode = 2;",
    "}",
    "",
  ].join("\n");
}

/**
 * The folder and its three files. Like the shared file, it is best effort: no method throws, and a write that fails is
 * dropped (the reading is still on the status bar). The extension writes the reading and the launcher and takes the
 * requests; the command reads the reading and leaves the requests.
 */
export class UsageExport {
  readonly usageFile: string;
  readonly requestFile: string;
  readonly launcherFile: string;
  /** `checkedAt` of the reading this window last wrote, so that the same one is not written at every check. */
  private written: number | undefined;

  constructor(readonly dir: string) {
    this.usageFile = path.join(dir, USAGE_FILE);
    this.requestFile = path.join(dir, REQUEST_FILE);
    this.launcherFile = path.join(dir, LAUNCHER_FILE);
  }

  /**
   * Makes the folder, for the user alone, and throws for one that is not a real folder of the user's own. A program will
   * run the launcher found here, so it is not written where somebody else decides what the folder holds: a link to
   * somewhere else, or a folder another account made first (possible when `XDG_STATE_HOME` points at a shared place).
   * A folder of the user's that was open to others is closed.
   */
  private async ownFolder(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(this.dir);
    const uid = process.getuid?.(); // not on Windows, where the profile's own access rules do this
    if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) throw new Error("not a folder of the user's own");
    await fs.chmod(this.dir, 0o700);
  }

  /** Replaces a file whole (write-then-rename), so a reader never sees half of one. */
  private async replace(file: string, body: string, mode: number): Promise<boolean> {
    // Created exclusively under a name nobody can guess, like the shared file's temporary.
    const tmp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await this.ownFolder();
      await fs.writeFile(tmp, body, { flag: "wx", mode });
      await fs.rename(tmp, file);
      return true;
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => {});
      return false;
    }
  }

  // ── the extension's side ──

  /**
   * Makes the usage file say what the status bar knows after a check: a reading newer than the one written is written,
   * and with no login at all the file is removed, because the reading it holds was for a login that is gone.
   */
  async publish(state: { status: Status; snapshot?: Snapshot }): Promise<void> {
    if (state.status === "noCreds") {
      this.written = undefined;
      await fs.rm(this.usageFile, { force: true }).catch(() => {});
      return;
    }
    const snapshot = state.snapshot;
    if (!snapshot || snapshot.checkedAt === this.written) return;
    const done = await this.replace(this.usageFile, `${JSON.stringify(toUsage(snapshot), null, 2)}\n`, 0o600);
    if (done) this.written = snapshot.checkedAt;
  }

  /** Writes the launcher that runs `cliPath`, the command inside the installed extension. */
  async installLauncher(cliPath: string): Promise<boolean> {
    return this.replace(this.launcherFile, launcherSource(cliPath), 0o700);
  }

  /**
   * Takes the request for a fresh reading, if there is one. Every window sees the request and one alone may answer it:
   * removing a file succeeds for one of them, and that one gets `true`.
   */
  async claimRequest(): Promise<boolean> {
    try {
      await fs.unlink(this.requestFile);
      return true;
    } catch {
      return false;
    }
  }

  /** The setting was switched off: removes the three files, and the folder if nothing else is in it. */
  async remove(): Promise<void> {
    this.written = undefined;
    for (const file of [this.usageFile, this.requestFile, this.launcherFile]) {
      await fs.rm(file, { force: true }).catch(() => {});
    }
    await fs.rmdir(this.dir).catch(() => {});
  }

  // ── the command's side ──

  /** The reading in the usage file, or `undefined` when there is none or it cannot be read. */
  async read(): Promise<Usage | undefined> {
    try {
      return parseUsage(JSON.parse(await fs.readFile(this.usageFile, "utf8")));
    } catch {
      return undefined;
    }
  }

  /** Whether the folder is there, which it is only while the setting is on. */
  async present(): Promise<boolean> {
    try {
      return (await fs.stat(this.dir)).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Asks the extension for a fresh reading. `false` when there is nobody to ask: the folder is the extension's to make,
   * and it is not there while the setting is off.
   */
  async request(): Promise<boolean> {
    try {
      await fs.writeFile(this.requestFile, `${new Date().toISOString()}\n`, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  /** Takes back a request nobody answered, so that it is not answered hours later, when VS Code is opened. */
  async cancelRequest(): Promise<void> {
    await fs.rm(this.requestFile, { force: true }).catch(() => {});
  }
}

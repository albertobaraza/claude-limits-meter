// What the windows of one machine tell each other about the usage endpoint. Every VS Code window runs its own copy of the
// extension, with its own timer and its own idea of whether Claude is rate limiting us; without this they all ask, and a
// window that is switched to ignores the 429 another one just got. Here the last request's outcome (a reading, or a 429
// and when the next request may be sent) is kept in a small file that all of them read before asking and write after.
// Free of any `vscode` import, so it is unit-tested with plain node.
//
// The file lives in the extension's storage folder on the machine that runs the extension, which is the machine that
// holds the Claude login (extensionKind is `workspace`), so every window sharing it shares one login. It is keyed by a
// fingerprint of the access token (`loginId`), so a reading is never shown for another account, and it holds no token.
// Sharing is an optimisation: whatever goes wrong here (no folder, no permission, a corrupt file) reads as "nothing known".

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Snapshot } from "./state";

/** What the last request for a login left behind. */
export interface SharedRecord {
  /** The last good reading, by whichever window took it. */
  snapshot?: Snapshot;
  /** Present when the last request was a 429: no request before `retryAt` (epoch ms); `streak` 429s in a row. */
  rateLimit?: { retryAt: number; streak: number };
}

/** None of these may throw. */
export interface SharedStore {
  /** The record for this login, or `undefined` when there is none, it is for another login, or it cannot be read. */
  read(login: string): Promise<SharedRecord | undefined>;
  /** Replaces the record. A failure is dropped. */
  write(login: string, record: SharedRecord): Promise<void>;
  /** Forgets everything. */
  clear(): Promise<void>;
}

const VERSION = 1;

/**
 * A fingerprint of an access token: the first half of its SHA-256. Enough to tell two logins apart (and a token Claude
 * Code renewed, which then starts from nothing: one extra request), and no way back to the token.
 */
export function loginId(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

const isNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function parseSnapshot(x: unknown): Snapshot | undefined {
  if (!isObject(x) || !isNumber(x.fiveHour) || !isNumber(x.sevenDay) || !isNumber(x.checkedAt)) return undefined;
  const snapshot: Snapshot = { fiveHour: x.fiveHour, sevenDay: x.sevenDay, checkedAt: x.checkedAt };
  if (typeof x.fiveHourReset === "string" || x.fiveHourReset === null) snapshot.fiveHourReset = x.fiveHourReset;
  if (typeof x.sevenDayReset === "string" || x.sevenDayReset === null) snapshot.sevenDayReset = x.sevenDayReset;
  return snapshot;
}

function parseRateLimit(x: unknown): SharedRecord["rateLimit"] {
  if (!isObject(x) || !isNumber(x.retryAt) || !Number.isInteger(x.streak)) return undefined;
  const streak = x.streak as number;
  return streak >= 1 && streak <= 1000 ? { retryAt: x.retryAt, streak } : undefined;
}

/** The record in one JSON file, replaced whole (write-then-rename) so a reader never sees half of one. */
export class FileSharedStore implements SharedStore {
  constructor(private readonly file: string) {}

  async read(login: string): Promise<SharedRecord | undefined> {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (!isObject(raw) || raw.v !== VERSION || raw.login !== login) return undefined;
      const record: SharedRecord = {};
      const snapshot = parseSnapshot(raw.snapshot);
      if (snapshot) record.snapshot = snapshot;
      const rateLimit = parseRateLimit(raw.rateLimit);
      if (rateLimit) record.rateLimit = rateLimit;
      return record.snapshot || record.rateLimit ? record : undefined;
    } catch {
      return undefined;
    }
  }

  async write(login: string, record: SharedRecord): Promise<void> {
    // Created exclusively under a name nobody can guess, like the credentials file's temporary (see writeCreds).
    const tmp = `${this.file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const body = JSON.stringify({ v: VERSION, login, snapshot: record.snapshot, rateLimit: record.rateLimit });
      await fs.writeFile(tmp, body, { flag: "wx", mode: 0o600 });
      await fs.rename(tmp, this.file);
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true }).catch(() => {});
  }
}

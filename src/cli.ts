// The command a script or a coding agent runs to ask whether there is room in the limits:
//
//   claude-limits --fresh 120 --max-5h 90 --max-7d 95
//
// It answers with its exit status: 0 there is room, 1 a limit is reached, 2 it cannot tell. It reads the folder in
// export.ts and nothing else: no login, no network. A fresh reading is the extension's to take; the command leaves a
// request in that folder and waits for the usage file to change. Free of any `vscode` import, and of claude.ts.

import { UsageExport, stateDir, type Usage } from "./export";

export const EXIT = { room: 0, limit: 1, unknown: 2 } as const;

/** The extension asks Claude at most once a minute, so no reading is ever asked to be newer than this. */
export const MIN_FRESH_SECONDS = 60;
export const DEFAULT_WAIT_SECONDS = 15;
export const MAX_WAIT_SECONDS = 120;
const POLL_MS = 250;

export const USAGE = `Usage: claude-limits [options]

Prints the last reading of your Claude usage limits taken by the Claude Limits Meter
extension, and says with its exit status whether there is room.

  --fresh <seconds>   The reading must be at most this old (60 or more). If it is older,
                      the extension is asked for a new one; VS Code must be running.
  --max-5h <percent>  Fail when the 5-hour session is at this percentage or above.
  --max-7d <percent>  Fail when the 7-day week is at this percentage or above.
  --wait <seconds>    How long to wait for a fresh reading (default ${DEFAULT_WAIT_SECONDS}, at most ${MAX_WAIT_SECONDS}).
  --json              Print JSON instead of a line of text.
  --help              Print this.

Exit status: 0 there is room, 1 a limit is reached, 2 cannot tell (no reading, a reading
that is too old, or an option that is wrong).`;

export interface Options {
  freshSeconds?: number;
  max5h?: number;
  max7d?: number;
  waitSeconds: number;
  json: boolean;
  help: boolean;
}

/** The options, or the reason they are wrong. `--name value` and `--name=value` are both read. */
export function parseArgs(argv: string[]): Options | { error: string } {
  const options: Options = { waitSeconds: DEFAULT_WAIT_SECONDS, json: false, help: false };
  const args = argv.flatMap((arg) => {
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    return eq < 0 ? [arg] : [arg.slice(0, eq), arg.slice(eq + 1)];
  });
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === "--json") options.json = true;
    else if (name === "--help" || name === "-h") options.help = true;
    else if (name === "--fresh" || name === "--max-5h" || name === "--max-7d" || name === "--wait") {
      const text = args[++i];
      const value = text === undefined || text.trim() === "" ? Number.NaN : Number(text);
      if (!Number.isFinite(value) || value < 0) return { error: `${name} needs a number, zero or more` };
      if (name === "--fresh") options.freshSeconds = Math.max(MIN_FRESH_SECONDS, value);
      else if (name === "--max-5h") options.max5h = value;
      else if (name === "--max-7d") options.max7d = value;
      else options.waitSeconds = Math.min(MAX_WAIT_SECONDS, value);
    } else return { error: `unknown option ${name}` };
  }
  return options;
}

/** "44s", "12m", "3h 12m", "6d 10h": a length of time, to the two largest units. */
export function span(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return m ? `${m}m` : `${total}s`;
}

function windowText(label: string, window: Usage["fiveHour"], now: number): string {
  const reset = window.resetsAt === null ? Number.NaN : Date.parse(window.resetsAt);
  const resets = Number.isNaN(reset) ? "" : reset > now ? ` (resets in ${span(reset - now)})` : " (resets now)";
  return `${label} ${Math.trunc(window.percent)}%${resets}`;
}

/** The reading as one line: "5h 42% (resets in 2h 13m) · 7d 18% (resets in 4d 2h) · checked 44s ago". */
export function readingText(usage: Usage, now: number): string {
  const age = span(now - Date.parse(usage.checkedAt));
  return `${windowText("5h", usage.fiveHour, now)} · ${windowText("7d", usage.sevenDay, now)} · checked ${age} ago`;
}

/** Everything the command takes from outside, so that a test gives it a folder and a clock of its own. */
export interface Deps {
  /** The folder of export.ts. */
  dir: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Runs the command and returns its exit status. Never throws. */
export async function run(argv: string[], deps: Deps): Promise<number> {
  const options = parseArgs(argv);
  if ("error" in options) {
    deps.err(`claude-limits: ${options.error}\n\n${USAGE}`);
    return EXIT.unknown;
  }
  if (options.help) {
    deps.out(USAGE);
    return EXIT.room;
  }

  const files = new UsageExport(deps.dir);
  const freshMs = options.freshSeconds === undefined ? undefined : options.freshSeconds * 1000;
  /** Old enough to need a new one. A reading from the future is from a clock that went back: not believed either. */
  const stale = (usage: Usage | undefined): boolean => {
    if (freshMs === undefined) return false;
    const age = usage ? deps.now() - Date.parse(usage.checkedAt) : Number.NaN;
    return !(age >= 0 && age <= freshMs);
  };

  let usage = await files.read();
  /** Whether the request for a fresh reading could be left; `undefined` when none was needed. */
  let asked: boolean | undefined;
  if (stale(usage)) {
    asked = await files.request();
    if (asked) {
      const deadline = deps.now() + options.waitSeconds * 1000;
      while (stale(usage) && deps.now() < deadline) {
        await deps.sleep(POLL_MS);
        usage = (await files.read()) ?? usage;
      }
      if (stale(usage)) await files.cancelRequest();
    }
  }

  const now = deps.now();
  const reached: string[] = [];
  if (usage && options.max5h !== undefined && usage.fiveHour.percent >= options.max5h) {
    reached.push(`the 5-hour session is at ${Math.trunc(usage.fiveHour.percent)}%, and the limit asked for is ${options.max5h}%`);
  }
  if (usage && options.max7d !== undefined && usage.sevenDay.percent >= options.max7d) {
    reached.push(`the 7-day week is at ${Math.trunc(usage.sevenDay.percent)}%, and the limit asked for is ${options.max7d}%`);
  }

  let status: "ok" | "limit" | "stale" | "none";
  let problem: string | undefined;
  if (!usage) {
    status = "none";
    problem = (asked ?? (await files.present()))
      ? "no reading. Is VS Code running, with Claude Code signed in? The status bar item says what is wrong."
      : "no reading. Switch on claudeLimitsMeter.commandLine in VS Code's User settings (extension Claude Limits Meter).";
  } else if (stale(usage)) {
    status = "stale";
    problem = asked
      ? `no reading newer than ${span(now - Date.parse(usage.checkedAt))} came in ${options.waitSeconds}s. Is VS Code running? ` +
        "Claude may also be asking the extension to wait: the status bar item says so."
      : "the reading is too old and the extension cannot be asked for a new one.";
  } else if (reached.length) {
    status = "limit";
    problem = reached.join("; ");
  } else {
    status = "ok";
  }

  if (options.json) {
    const reading = usage && {
      checkedAt: usage.checkedAt,
      ageSeconds: Math.max(0, Math.floor((now - Date.parse(usage.checkedAt)) / 1000)),
      fiveHour: usage.fiveHour,
      sevenDay: usage.sevenDay,
    };
    deps.out(JSON.stringify({ status, ...reading, ...(problem ? { message: problem } : {}) }));
  } else {
    if (usage) deps.out(readingText(usage, now));
    if (problem) deps.err(`claude-limits: ${problem}`);
  }
  return status === "ok" ? EXIT.room : status === "limit" ? EXIT.limit : EXIT.unknown;
}

/** The command as a program: the real folder, clock and streams, and the exit status left for when the process ends. */
export function main(argv: string[] = process.argv.slice(2)): void {
  run(argv, {
    dir: stateDir(),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.error("claude-limits: unexpected error");
      process.exitCode = EXIT.unknown;
    },
  );
}

if (require.main === module) main();

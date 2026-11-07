// What the status bar is showing and how one check turns the previous state into the next.
// Free of any `vscode` import, so it is unit-tested with plain node.

import { HttpError, type ClaudeClient } from "./claude";

export interface Snapshot {
  fiveHour: number;
  fiveHourReset?: string | null;
  sevenDay: number;
  sevenDayReset?: string | null;
}

export type Status =
  | "loading"
  /** A fresh reading. */
  | "ok"
  /** No Claude Code login on this machine. */
  | "noCreds"
  /** A login whose token expired and has not been renewed. */
  | "expired"
  | "error";

export interface State {
  status: Status;
  /** The last successful reading, kept across failures so the tooltip can still show it. */
  snapshot?: Snapshot;
  error?: string;
}

export const INITIAL_STATE: State = { status: "loading" };

/** One check. Never throws: a failure becomes the next state. */
export async function check(
  client: Pick<ClaudeClient, "getToken" | "fetchUsage">,
  prev: State,
  log: (message: string) => void = () => {},
): Promise<State> {
  const snapshot = prev.snapshot;
  try {
    const result = await client.getToken();
    if (result.kind === "none") return { status: "noCreds", snapshot };
    if (result.kind === "expired") return { status: "expired", snapshot };

    const data = await client.fetchUsage(result.token);
    return {
      status: "ok",
      snapshot: {
        fiveHour: data.five_hour?.utilization ?? 0,
        fiveHourReset: data.five_hour?.resets_at,
        sevenDay: data.seven_day?.utilization ?? 0,
        sevenDayReset: data.seven_day?.resets_at,
      },
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(message);
    // Claude rejected a token that looked valid: same situation as one that is known to have expired.
    if (e instanceof HttpError && e.status === 401) return { status: "expired", snapshot };
    return { status: "error", error: message, snapshot };
  }
}

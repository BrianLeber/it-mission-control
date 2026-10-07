// Shared domain types. States are ordered by severity; see STATE_RANK.

export type State = "crit" | "warn" | "stale" | "ack" | "maint" | "ok";
export type IssueState = Exclude<State, "ok" | "ack">;

export const STATE_RANK: Record<State | "false", number> = {
  crit: 6, warn: 5, stale: 4, ack: 3, maint: 2, false: 1.5, ok: 1,
};

export const worst = (states: Iterable<State>): State => {
  let w: State = "ok";
  for (const s of states) if (STATE_RANK[s] > STATE_RANK[w]) w = s;
  return w;
};

/** One thing a source says is wrong right now. `key` correlates it across polls. */
export interface Issue {
  key: string;
  state: IssueState;
  summary: string;
  url?: string;
  startedAt?: number;
  /** The vendor's own reference, e.g. Microsoft's SP1489449. Shown and searchable. */
  ref?: string;
  /** Longer description, e.g. Microsoft's impact statement. */
  detail?: string;
  /** The vendor's posted updates, oldest first. Recorded once each on the incident timeline. */
  updates?: { t: number; text: string }[];
  /** Which parts of a platform it touches, e.g. ["SharePoint Online"]. Drives relevance and platform pages. */
  components?: string[];
}

/** normal: counts. ignore: "not used by us", recorded for the record but never lights anything. */
export type Relevance = "normal" | "ignore";

/** What a driver returns from one poll (or what a push source sends). */
export interface Observation {
  issues: Issue[];
  /** One-line headline when everything is fine, e.g. "All systems operational". */
  okSummary?: string;
}

export interface Snooze { by: string; until: number; note?: string; rank: number; keys: string[] }
export interface Parked { by: string; at: number; until: number | null; reason: string }

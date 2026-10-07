import { EventEmitter } from "node:events";
import { tx, type DB } from "../db/index.ts";
import type { Connector } from "../connectors/schema.ts";
import { STATE_RANK, worst, type Issue, type IssueState, type Observation, type Parked, type Snooze, type State } from "../model.ts";
import { parseDuration } from "../util/duration.ts";

// Turns observations into incidents and a derived state per check.
//   attack:  an issue opens on the first poll that reports it
//   release: it closes only after `release` consecutive polls without it
//   stale:   no good reading for every × grace → NO SIGNAL
// Snooze and park are layered on top and never hide a change for the worse.

export interface IssueRow {
  id: number; check_id: string; key: string; state: IssueState; worst: IssueState; summary: string; url: string | null;
  opened_at: number; last_seen_at: number; missing_count: number; closed_at: number | null; close_reason: string | null;
}
export interface StateRow {
  check_id: string; state: State; since: number; summary: string; last_ok_at: number | null; last_error: string | null;
  fail_count: number; next_due: number; snooze: string | null; parked: string | null; suppressed: string; monitored_from: number;
}
export interface CheckRow { id: string; def: string; source: "repo" | "custom" | "draft"; enabled: number }

export type EngineEvent =
  | { type: "change"; checkId: string; from: State; to: State }
  | { type: "updated"; checkId: string };

const SIGNAL_KEY = "_signal"; // reserved key for NO SIGNAL / can't-reach-source issues

export class Engine extends EventEmitter {
  db: DB;
  constructor(db: DB) { super(); this.db = db; }

  // ---------- connectors ----------

  /** Upserts definitions. Repo connectors removed from disk are disabled, not deleted, to keep history. */
  syncConnectors(list: Connector[], source: "repo" | "custom" | "draft", now = Date.now()) {
    tx(this.db, () => {
      const up = this.db.prepare(`INSERT INTO checks (id, def, source, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET def = excluded.def, source = excluded.source, enabled = excluded.enabled, updated_at = excluded.updated_at`);
      const st = this.db.prepare(`INSERT OR IGNORE INTO check_state (check_id, since, monitored_from) VALUES (?, ?, ?)`);
      for (const c of list) {
        up.run(c.id, JSON.stringify(c), source, c.enabled && source !== "draft" ? 1 : 0, now, now);
        st.run(c.id, now, now);
      }
      if (source === "repo") {
        const ids = list.map(c => c.id);
        const rows = this.db.prepare("SELECT id FROM checks WHERE source = 'repo'").all() as { id: string }[];
        for (const r of rows) if (!ids.includes(r.id)) this.db.prepare("UPDATE checks SET enabled = 0 WHERE id = ?").run(r.id);
      }
    });
  }

  connector(id: string): Connector | undefined {
    const r = this.db.prepare("SELECT def FROM checks WHERE id = ?").get(id) as { def: string } | undefined;
    return r ? JSON.parse(r.def) : undefined;
  }
  checks(): (CheckRow & { connector: Connector })[] {
    return (this.db.prepare("SELECT id, def, source, enabled FROM checks ORDER BY id").all() as unknown as CheckRow[])
      .map(r => ({ ...r, connector: JSON.parse(r.def) as Connector }));
  }
  state(id: string): StateRow | undefined {
    return this.db.prepare("SELECT * FROM check_state WHERE check_id = ?").get(id) as StateRow | undefined;
  }
  openIssues(id: string): IssueRow[] {
    return this.db.prepare("SELECT * FROM issues WHERE check_id = ? AND closed_at IS NULL ORDER BY opened_at").all(id) as unknown as IssueRow[];
  }

  // ---------- inputs ----------

  /** A successful poll (or a full push snapshot). Issues not listed count toward release. */
  observe(checkId: string, obs: Observation, origin: string, now = Date.now()) {
    const c = this.connector(checkId); if (!c) return;
    tx(this.db, () => {
      const st = this.state(checkId)!;
      let suppressed: string[] = JSON.parse(st.suppressed);
      const reported = obs.issues.filter(i => i.key !== SIGNAL_KEY);
      // False-alarm suppression lasts until the source itself stops reporting the key.
      suppressed = suppressed.filter(k => reported.some(i => i.key === k));
      const live = reported.filter(i => !suppressed.includes(i.key));
      const open = this.openIssues(checkId);

      for (const i of live) this.upsertIssue(checkId, open, i, origin, now);
      for (const o of open) {
        if (o.key === SIGNAL_KEY) { this.closeIssue(o, "cleared", now, "Signal restored", origin); continue; }
        if (live.some(i => i.key === o.key)) continue;
        const missing = o.missing_count + 1;
        if (missing >= c.release) this.closeIssue(o, "cleared", now, `Cleared: ${o.summary}`, origin);
        else this.db.prepare("UPDATE issues SET missing_count = ? WHERE id = ?").run(missing, o.id);
      }
      this.db.prepare(`UPDATE check_state SET last_ok_at = ?, fail_count = 0, last_error = NULL, suppressed = ?,
        summary = CASE WHEN ? IS NOT NULL THEN ? ELSE summary END WHERE check_id = ?`)
        .run(now, JSON.stringify(suppressed), obs.okSummary ?? null, obs.okSummary ?? null, checkId);
      this.recompute(checkId, now);
    });
  }

  /** A poll that failed (network, auth, parse). Two in a row, or a long gap, means NO SIGNAL. */
  fail(checkId: string, error: string, origin: string, now = Date.now()) {
    const c = this.connector(checkId); if (!c) return;
    tx(this.db, () => {
      const st = this.state(checkId)!;
      const fails = st.fail_count + 1;
      this.db.prepare("UPDATE check_state SET fail_count = ?, last_error = ? WHERE check_id = ?").run(fails, error, checkId);
      const since = st.last_ok_at ?? st.monitored_from;
      if (fails >= 2 || now - since > c.every * c.grace) {
        this.upsertIssue(checkId, this.openIssues(checkId), { key: SIGNAL_KEY, state: "stale", summary: `Can't read source: ${error}` }, origin, now);
      }
      this.recompute(checkId, now);
    });
  }

  /** Push: one issue (or a clear) at a time. Used by webhooks and email/Slack parsers later. */
  push(checkId: string, input: { key?: string; state: IssueState | "ok"; summary?: string; url?: string }, origin: string, now = Date.now()) {
    tx(this.db, () => {
      const open = this.openIssues(checkId);
      for (const o of open.filter(o => o.key === SIGNAL_KEY)) this.closeIssue(o, "cleared", now, "Signal restored", origin);
      if (input.state === "ok") {
        for (const o of open) if (o.key !== SIGNAL_KEY && (!input.key || o.key === input.key)) this.closeIssue(o, "cleared", now, input.summary || `Cleared: ${o.summary}`, origin);
        this.db.prepare("UPDATE check_state SET summary = ? WHERE check_id = ?").run(input.summary || "Operational", checkId);
      } else {
        this.upsertIssue(checkId, open, { key: input.key || "default", state: input.state, summary: input.summary || "Alert received", url: input.url }, origin, now);
      }
      this.db.prepare("UPDATE check_state SET last_ok_at = ?, fail_count = 0, last_error = NULL WHERE check_id = ?").run(now, checkId);
      this.recompute(checkId, now);
    });
  }

  /** Heartbeats and push sources go stale when nothing arrives; polled ones when polls stop succeeding. */
  sweep(now = Date.now()) {
    for (const { id, enabled, connector: c } of this.checks()) {
      if (!enabled) continue;
      const st = this.state(id); if (!st) continue;
      const last = st.last_ok_at ?? st.monitored_from;
      let limit: number | null = c.every * c.grace;
      let downAfter: number | null = null;
      if (c.driver === "webhook") limit = c.options.expect_every ? parseDuration(String(c.options.expect_every)) : null;
      if (c.driver === "heartbeat" && c.options.down_after) downAfter = parseDuration(String(c.options.down_after));
      const gap = now - last;
      if (limit === null || gap <= limit) continue;
      const state: IssueState = downAfter !== null && gap > downAfter ? "crit" : "stale";
      const what = c.driver === "heartbeat" ? "heartbeat" : "reading";
      const open = this.openIssues(id);
      const cur = open.find(o => o.key === SIGNAL_KEY);
      if (cur && cur.state === state) continue;
      tx(this.db, () => {
        this.upsertIssue(id, open, { key: SIGNAL_KEY, state, summary: `No ${what} for ${fmt(gap)} (expected every ${fmt(c.every)})` }, "Monitor", now);
        this.recompute(id, now);
      });
    }
    // Snoozes and parks can expire without any new signal.
    const timed = this.db.prepare("SELECT check_id, snooze, parked FROM check_state WHERE snooze IS NOT NULL OR parked IS NOT NULL").all() as
      { check_id: string; snooze: string | null; parked: string | null }[];
    for (const r of timed) {
      const sUntil = r.snooze ? (JSON.parse(r.snooze) as Snooze).until : Infinity;
      const pUntil = r.parked ? (JSON.parse(r.parked) as Parked).until ?? Infinity : Infinity;
      if (now >= sUntil || now >= pUntil) tx(this.db, () => this.recompute(r.check_id, now));
    }
  }

  // ---------- operator actions ----------

  snooze(checkId: string, minutes: number, by: string, note?: string, now = Date.now()) {
    tx(this.db, () => {
      const open = this.openIssues(checkId);
      if (!open.length) throw new UserError("Nothing to snooze: this check has no open issues.");
      const rank = STATE_RANK[worst(open.map(o => o.state))];
      const s: Snooze = { by, until: now + Math.min(Math.max(minutes, 1), 24 * 60) * 60e3, note, rank, keys: open.map(o => o.key) };
      this.db.prepare("UPDATE check_state SET snooze = ? WHERE check_id = ?").run(JSON.stringify(s), checkId);
      this.event(checkId, "ack", `Snoozed ${minutes}m by ${by}${note ? `: "${note}"` : ""}`, "Mission Control", now);
      this.recompute(checkId, now);
    });
  }
  endSnooze(checkId: string, by: string, now = Date.now()) {
    tx(this.db, () => {
      this.db.prepare("UPDATE check_state SET snooze = NULL WHERE check_id = ?").run(checkId);
      this.event(checkId, this.state(checkId)!.state, `Snooze ended by ${by}`, "Mission Control", now);
      this.recompute(checkId, now);
    });
  }
  park(checkId: string, reason: string, until: number | null, by: string, now = Date.now()) {
    tx(this.db, () => {
      const p: Parked = { by, at: now, until, reason };
      this.db.prepare("UPDATE check_state SET parked = ?, snooze = NULL WHERE check_id = ?").run(JSON.stringify(p), checkId);
      this.event(checkId, this.state(checkId)!.state, `Parked by ${by}${until ? ` until ${new Date(until).toISOString().slice(0, 10)}` : ""}: ${reason}`, "Mission Control", now);
      this.recompute(checkId, now);
    });
  }
  unpark(checkId: string, by: string, now = Date.now()) {
    tx(this.db, () => {
      this.db.prepare("UPDATE check_state SET parked = NULL WHERE check_id = ?").run(checkId);
      this.event(checkId, this.state(checkId)!.state, `Unparked by ${by}`, "Mission Control", now);
      this.recompute(checkId, now);
    });
  }
  /** Closes everything open as noise, repaints that stretch of history, and ignores those keys until the source drops them. */
  falseAlarm(checkId: string, by: string, now = Date.now()) {
    tx(this.db, () => {
      const open = this.openIssues(checkId).filter(o => o.key !== SIGNAL_KEY);
      if (!open.length) throw new UserError("Nothing to mark: this check has no open alerts.");
      const from = Math.min(...open.map(o => o.opened_at));
      for (const o of open) this.closeIssue(o, "false_alarm", now);
      const st = this.state(checkId)!;
      const sup = new Set<string>([...JSON.parse(st.suppressed), ...open.map(o => o.key)]);
      this.db.prepare("UPDATE check_state SET suppressed = ?, snooze = NULL WHERE check_id = ?").run(JSON.stringify([...sup]), checkId);
      this.db.prepare("UPDATE spans SET state = 'false' WHERE check_id = ? AND start >= ?").run(checkId, from);
      this.event(checkId, "false", `Marked as a false alarm by ${by}`, "Mission Control", now);
      this.db.prepare("UPDATE check_state SET summary = 'Operational' WHERE check_id = ?").run(checkId);
      this.recompute(checkId, now, { falseAlarm: true });
    });
  }
  /** "I fixed it": closes open issues now. A polled source that still reports them reopens them. */
  clear(checkId: string, by: string, now = Date.now()) {
    tx(this.db, () => {
      for (const o of this.openIssues(checkId)) this.closeIssue(o, "manual", now);
      this.db.prepare("UPDATE check_state SET snooze = NULL, next_due = 0, summary = 'Operational' WHERE check_id = ?").run(checkId);
      this.event(checkId, "ok", `Cleared manually by ${by}`, "Mission Control", now);
      this.recompute(checkId, now);
    });
  }

  // ---------- internals ----------

  private upsertIssue(checkId: string, open: IssueRow[], i: Issue, origin: string, now: number) {
    const cur = open.find(o => o.key === i.key);
    if (!cur) {
      const r = this.db.prepare(`INSERT INTO issues (check_id, key, state, worst, summary, url, opened_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(checkId, i.key, i.state, i.state, i.summary, i.url ?? null, now, now);
      open.push({ id: Number(r.lastInsertRowid), check_id: checkId, key: i.key, state: i.state, worst: i.state, summary: i.summary, url: i.url ?? null, opened_at: now, last_seen_at: now, missing_count: 0, closed_at: null, close_reason: null });
      this.event(checkId, i.state, i.summary, origin, now);
      return;
    }
    const w = STATE_RANK[i.state] > STATE_RANK[cur.worst] ? i.state : cur.worst;
    this.db.prepare("UPDATE issues SET state = ?, worst = ?, summary = ?, url = ?, last_seen_at = ?, missing_count = 0 WHERE id = ?")
      .run(i.state, w, i.summary, i.url ?? cur.url, now, cur.id);
    if (cur.state !== i.state || cur.summary !== i.summary) this.event(checkId, i.state, i.summary, origin, now);
    Object.assign(cur, { state: i.state, worst: w, summary: i.summary, missing_count: 0 });
  }

  private closeIssue(o: IssueRow, reason: "cleared" | "false_alarm" | "manual", now: number, message?: string, origin?: string) {
    this.db.prepare("UPDATE issues SET closed_at = ?, close_reason = ? WHERE id = ?").run(now, reason, o.id);
    o.closed_at = now;
    if (message) this.event(o.check_id, "ok", message, origin ?? "Monitor", now);
  }

  private event(checkId: string, state: State | "false", message: string, origin: string, now: number) {
    this.db.prepare("INSERT INTO events (check_id, t, state, message, origin) VALUES (?, ?, ?, ?, ?)").run(checkId, now, state, message, origin);
  }

  /** Derives the check's displayed state from open issues, snooze and park; records spans. */
  recompute(checkId: string, now = Date.now(), opts: { falseAlarm?: boolean } = {}) {
    const st = this.state(checkId)!;
    const open = this.openIssues(checkId);
    const raw = worst(open.map(o => o.state));
    let snooze: Snooze | null = st.snooze ? JSON.parse(st.snooze) : null;
    let parked: Parked | null = st.parked ? JSON.parse(st.parked) : null;

    if (parked?.until && now >= parked.until) {
      this.event(checkId, raw, "Park period ended", "Mission Control", now);
      parked = null;
    }
    let state: State = raw;
    if (snooze) {
      if (raw === "ok") snooze = null;
      else if (now >= snooze.until) { this.event(checkId, raw, "Snooze ended and the issue has not cleared", "Mission Control", now); snooze = null; }
      else if (STATE_RANK[raw] > snooze.rank || open.some(o => !snooze!.keys.includes(o.key))) {
        this.event(checkId, raw, "Snooze cancelled: the problem got worse or a new one appeared", "Mission Control", now);
        snooze = null;
      } else state = "ack";
    }
    const top = [...open].sort((a, b) => STATE_RANK[b.state] - STATE_RANK[a.state] || b.opened_at - a.opened_at)[0];
    const summary = top ? top.summary + (open.length > 1 ? ` (+${open.length - 1} more)` : "") : st.summary;

    this.db.prepare("UPDATE check_state SET snooze = ?, parked = ?, summary = ? WHERE check_id = ?")
      .run(snooze ? JSON.stringify(snooze) : null, parked ? JSON.stringify(parked) : null, raw === "ok" && !top ? st.summary : summary, checkId);

    if (state !== st.state) {
      this.db.prepare("UPDATE spans SET end = ? WHERE check_id = ? AND end IS NULL").run(now, checkId);
      if (state !== "ok") this.db.prepare("INSERT INTO spans (check_id, state, start) VALUES (?, ?, ?)").run(checkId, state, now);
      this.db.prepare("UPDATE check_state SET state = ?, since = ? WHERE check_id = ?").run(state, now, checkId);
      if (state === "ok" && !opts.falseAlarm && !open.length) this.event(checkId, "ok", "Operational", "Monitor", now);
      this.emit("event", { type: "change", checkId, from: st.state, to: state } satisfies EngineEvent);
    } else {
      this.emit("event", { type: "updated", checkId } satisfies EngineEvent);
    }
  }
}

export class UserError extends Error {}

function fmt(ms: number): string {
  const m = Math.round(ms / 60e3);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${m % 60 ? ` ${m % 60}m` : ""}` : `${Math.floor(h / 24)}d`;
}

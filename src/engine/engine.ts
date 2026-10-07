import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { tx, type DB } from "../db/index.ts";
import type { Connector } from "../connectors/schema.ts";
import { STATE_RANK, worst, type Issue, type IssueState, type Observation, type Parked, type Relevance, type Snooze, type State } from "../model.ts";
import { parseDuration } from "../util/duration.ts";

// Turns observations into incidents and a derived state per check.
//   attack:  an issue opens on the first poll that reports it
//   release: it closes only after `release` consecutive polls without it
//   stale:   no good reading for every × grace → NO SIGNAL
// Snooze and park are layered on top and never hide a change for the worse.

export interface IssueRow {
  id: number; check_id: string; key: string; state: IssueState; worst: IssueState; summary: string; url: string | null;
  opened_at: number; last_seen_at: number; missing_count: number; closed_at: number | null; close_reason: string | null;
  ref?: string | null; detail?: string | null; started_at?: number | null; tracked_by?: string | null; tracked_at?: number | null;
  archived_by?: string | null; archived_at?: number | null;
  components?: string; manual?: number; ignored?: number;
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
/** A vendor incident that vanishes and comes back within this window reopens the same record. */
const REOPEN_WINDOW = 6 * 3600e3;
/** Closed incidents are kept this long unless archived. */
export const RETENTION = 90 * 86400e3;
const LABEL: Record<string, string> = { crit: "Down", warn: "Degraded", stale: "No signal", maint: "Maintenance", ack: "Snoozed", ok: "Operational" };

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
  /** Open issues that count: everything except those on components marked "not used". */
  activeIssues(id: string): IssueRow[] { return this.openIssues(id).filter(o => !o.ignored); }

  // ---------- platforms: components and relevance ----------

  /** Relevance per component: the connector file's list, overridden by choices made in the UI. */
  relevanceMap(checkId: string): Map<string, { relevance: Relevance; note?: string; by?: string }> {
    const m = new Map<string, { relevance: Relevance; note?: string; by?: string }>();
    for (const c of this.connector(checkId)?.components ?? []) m.set(c.name.toLowerCase(), { relevance: c.relevance, note: c.note });
    for (const r of this.db.prepare("SELECT component, relevance, note, by FROM component_prefs WHERE check_id = ?").all(checkId) as { component: string; relevance: Relevance; note: string | null; by: string }[]) {
      m.set(r.component.toLowerCase(), { relevance: r.relevance, note: r.note ?? undefined, by: r.by });
    }
    return m;
  }
  /** An issue is ignored only when every component it touches is marked "not used". */
  private isIgnored(checkId: string, components: string[]): boolean {
    if (!components.length) return false;
    const m = this.relevanceMap(checkId);
    return components.every(c => m.get(c.toLowerCase())?.relevance === "ignore");
  }
  /** Known components: configured, chosen in the UI, or seen in incidents in the last 90 days. */
  components(checkId: string): { name: string; relevance: Relevance; note?: string }[] {
    const names = new Map<string, string>();
    for (const c of this.connector(checkId)?.components ?? []) names.set(c.name.toLowerCase(), c.name);
    for (const r of this.db.prepare("SELECT component FROM component_prefs WHERE check_id = ?").all(checkId) as { component: string }[]) if (!names.has(r.component.toLowerCase())) names.set(r.component.toLowerCase(), r.component);
    const seen = this.db.prepare("SELECT components FROM issues WHERE check_id = ? AND opened_at > ? AND components != '[]'").all(checkId, Date.now() - RETENTION) as { components: string }[];
    for (const r of seen) for (const n of JSON.parse(r.components) as string[]) if (!names.has(n.toLowerCase())) names.set(n.toLowerCase(), n);
    const m = this.relevanceMap(checkId);
    return [...names.values()].map(n => ({ name: n, relevance: m.get(n.toLowerCase())?.relevance ?? "normal", note: m.get(n.toLowerCase())?.note }));
  }
  /** "We don't use Teams": future and open issues touching only ignored parts stop counting at once. */
  setRelevance(checkId: string, component: string, relevance: Relevance, by: string, note?: string, now = Date.now()) {
    const name = component.trim().slice(0, 80);
    if (!name) throw new UserError("Name the component");
    tx(this.db, () => {
      this.db.prepare(`INSERT INTO component_prefs (check_id, component, relevance, note, by, at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(check_id, component) DO UPDATE SET relevance = excluded.relevance, note = excluded.note, by = excluded.by, at = excluded.at`)
        .run(checkId, name, relevance, note ?? null, by, now);
      for (const o of this.openIssues(checkId)) {
        if (o.manual) continue;
        const ign = this.isIgnored(checkId, JSON.parse(o.components ?? "[]")) ? 1 : 0;
        if (ign === (o.ignored ?? 0)) continue;
        this.db.prepare("UPDATE issues SET ignored = ? WHERE id = ?").run(ign, o.id);
        this.update(o.id, now, "action", null, ign ? `Ignored: ${name} is marked not used` : `Counts again: ${name} is in use`, by);
      }
      this.event(checkId, this.state(checkId)!.state, relevance === "ignore" ? `${name} marked not used by ${by}${note ? `: ${note}` : ""}` : `${name} marked in use by ${by}`, "Mission Control", now);
      this.recompute(checkId, now);
    });
  }

  /** Card size: auto | full | compact | logo. Saved per check for everyone. */
  size(checkId: string): string {
    const r = this.db.prepare("SELECT size FROM check_display WHERE check_id = ?").get(checkId) as { size: string } | undefined;
    return r?.size ?? this.connector(checkId)?.size ?? "auto";
  }
  setSize(checkId: string, size: string, by: string, now = Date.now()) {
    if (!["auto", "full", "compact", "logo"].includes(size)) throw new UserError("Size must be auto, full, compact or logo");
    this.db.prepare(`INSERT INTO check_display (check_id, size, by, at) VALUES (?, ?, ?, ?)
      ON CONFLICT(check_id) DO UPDATE SET size = excluded.size, by = excluded.by, at = excluded.at`).run(checkId, size, by, now);
    this.emit("event", { type: "updated", checkId } satisfies EngineEvent);
  }

  /** A person reports what no source shows, e.g. "Sway isn't saving changes" with no Microsoft alert. */
  reportIssue(checkId: string, input: { state: IssueState; title: string; detail?: string; component?: string; ref?: string }, by: string, now = Date.now()): number {
    if (!this.connector(checkId)) throw new UserError("No such check");
    const title = input.title.trim(); if (!title) throw new UserError("Describe the issue in a few words");
    if (!["crit", "warn", "maint"].includes(input.state)) throw new UserError("State must be Down, Degraded or Maintenance");
    return tx(this.db, () => {
      const key = `manual:${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const open = this.openIssues(checkId);
      this.upsertIssue(checkId, open, {
        key, state: input.state, summary: title.slice(0, 200), detail: input.detail?.trim().slice(0, 2000) || undefined,
        ref: input.ref?.trim().slice(0, 40) || undefined, components: input.component?.trim() ? [input.component.trim().slice(0, 80)] : undefined,
      }, `Reported by ${by}`, now, true); // people's reports always count, even on a part marked not used
      const id = open.find(o => o.key === key)!.id;
      this.recompute(checkId, now);
      return id;
    });
  }
  /** Closes a reported issue. Source-reported ones close when the source says so (or via Clear / False alarm). */
  resolveIssue(issueId: number, by: string, note?: string, now = Date.now()) {
    const i = this.issue(issueId); if (!i) throw new UserError("No such incident");
    if (!i.manual) throw new UserError("This one comes from the source and closes when the source clears it. Use Clear or False alarm on the check instead.");
    if (i.closed_at) throw new UserError("Already resolved");
    tx(this.db, () => {
      if (note?.trim()) this.update(issueId, now, "note", null, note.trim().slice(0, 4000), by);
      this.closeIssue(i, "manual", now, `Resolved: ${i.summary}`, `Reported by ${by}`, by);
      this.recompute(i.check_id, now);
    });
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
        if (o.manual) continue; // people's reports close when people resolve them
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
  fail(checkId: string, error: string, origin: string, now = Date.now(), opts: { immediate?: boolean } = {}) {
    const c = this.connector(checkId); if (!c) return;
    tx(this.db, () => {
      const st = this.state(checkId)!;
      const fails = st.fail_count + 1;
      this.db.prepare("UPDATE check_state SET fail_count = ?, last_error = ? WHERE check_id = ?").run(fails, error, checkId);
      const since = st.last_ok_at ?? st.monitored_from;
      if (opts.immediate || fails >= 2 || now - since > c.every * c.grace) {
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
        for (const o of open) if (o.key !== SIGNAL_KEY && !o.manual && (!input.key || o.key === input.key)) this.closeIssue(o, "cleared", now, input.summary || `Cleared: ${o.summary}`, origin);
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
      const open = this.activeIssues(checkId);
      if (!open.length) throw new UserError("Nothing to snooze: this check has no open issues.");
      const rank = STATE_RANK[worst(open.map(o => o.state))];
      const s: Snooze = { by, until: now + Math.min(Math.max(minutes, 1), 24 * 60) * 60e3, note, rank, keys: open.map(o => o.key) };
      this.db.prepare("UPDATE check_state SET snooze = ? WHERE check_id = ?").run(JSON.stringify(s), checkId);
      this.event(checkId, "ack", `Snoozed ${minutes}m by ${by}${note ? `: "${note}"` : ""}`, "Mission Control", now);
      for (const o of open) this.update(o.id, now, "action", "ack", `Snoozed ${minutes}m${note ? `: "${note}"` : ""}`, by);
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
      for (const o of this.openIssues(checkId)) this.update(o.id, now, "action", null, `Check parked: ${reason}`, by);
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
      const open = this.activeIssues(checkId).filter(o => o.key !== SIGNAL_KEY);
      if (!open.length) throw new UserError("Nothing to mark: this check has no open alerts.");
      const from = Math.min(...open.map(o => o.opened_at));
      for (const o of open) this.closeIssue(o, "false_alarm", now, undefined, undefined, by);
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
      for (const o of this.openIssues(checkId)) this.closeIssue(o, "manual", now, undefined, undefined, by);
      this.db.prepare("UPDATE check_state SET snooze = NULL, next_due = 0, summary = 'Operational' WHERE check_id = ?").run(checkId);
      this.event(checkId, "ok", `Cleared manually by ${by}`, "Mission Control", now);
      this.recompute(checkId, now);
    });
  }

  // ---------- internals ----------

  private upsertIssue(checkId: string, open: IssueRow[], i: Issue, origin: string, now: number, manual = false) {
    let cur = open.find(o => o.key === i.key);
    const label = (x: Issue) => (x.ref ? `${x.ref}: ${x.summary}` : x.summary);
    if (!cur && i.key !== SIGNAL_KEY) {
      // Same vendor incident back within the window: reopen its record instead of starting a new one.
      const prev = this.db.prepare(`SELECT * FROM issues WHERE check_id = ? AND key = ? AND close_reason = 'cleared' AND closed_at > ? ORDER BY closed_at DESC LIMIT 1`)
        .get(checkId, i.key, now - REOPEN_WINDOW) as IssueRow | undefined;
      if (prev) {
        this.db.prepare("UPDATE issues SET closed_at = NULL, close_reason = NULL, archived_at = CASE WHEN archived_by = 'auto (tracked)' THEN NULL ELSE archived_at END, archived_by = CASE WHEN archived_by = 'auto (tracked)' THEN NULL ELSE archived_by END WHERE id = ?").run(prev.id);
        prev.closed_at = null; prev.close_reason = null;
        open.push(prev); cur = prev;
        this.update(prev.id, now, "reopened", i.state, "Reported again by the source", origin);
        this.event(checkId, i.state, `Reopened: ${label(i)}`, origin, now);
      }
    }
    const comps = i.components ?? [];
    const ignored = !manual && this.isIgnored(checkId, comps) ? 1 : 0;
    if (!cur) {
      const r = this.db.prepare(`INSERT INTO issues (check_id, key, state, worst, summary, url, opened_at, last_seen_at, ref, detail, started_at, components, ignored, manual) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(checkId, i.key, i.state, i.state, i.summary, i.url ?? null, now, now, i.ref ?? null, i.detail ?? null, i.startedAt && i.startedAt < now ? i.startedAt : null, JSON.stringify(comps), ignored, manual ? 1 : 0);
      const id = Number(r.lastInsertRowid);
      open.push({ id, check_id: checkId, key: i.key, state: i.state, worst: i.state, summary: i.summary, url: i.url ?? null, opened_at: now, last_seen_at: now, missing_count: 0, closed_at: null, close_reason: null, ref: i.ref ?? null, components: JSON.stringify(comps), ignored, manual: manual ? 1 : 0 });
      this.update(id, now, "opened", i.state, `${LABEL[i.state]}: ${i.summary}${i.detail ? ` (${i.detail})` : ""}`, origin);
      if (ignored) this.update(id, now, "action", null, `Ignored: ${comps.join(", ")} ${comps.length > 1 ? "are" : "is"} marked not used`, "Mission Control");
      this.sourceUpdates(id, i, origin);
      if (!ignored) this.event(checkId, i.state, label(i), origin, now); // ignored issues stay out of the check's log
      return;
    }
    const w = STATE_RANK[i.state] > STATE_RANK[cur.worst] ? i.state : cur.worst;
    this.db.prepare("UPDATE issues SET state = ?, worst = ?, summary = ?, url = ?, last_seen_at = ?, missing_count = 0, ref = COALESCE(?, ref), detail = COALESCE(?, detail) WHERE id = ?")
      .run(i.state, w, i.summary, i.url ?? cur.url, now, i.ref ?? null, i.detail ?? null, cur.id);
    if (cur.state !== i.state) this.update(cur.id, now, "state", i.state, `${LABEL[cur.state]} → ${LABEL[i.state]}`, origin);
    if (cur.summary !== i.summary && !i.updates?.length) this.update(cur.id, now, "source", i.state, i.summary, origin);
    this.sourceUpdates(cur.id, i, origin);
    if (comps.length && !cur.manual && JSON.stringify(comps) !== cur.components) {
      this.db.prepare("UPDATE issues SET components = ?, ignored = ? WHERE id = ?").run(JSON.stringify(comps), ignored, cur.id);
      if (ignored !== (cur.ignored ?? 0)) this.update(cur.id, now, "action", null, ignored ? `Ignored: ${comps.join(", ")} marked not used` : `Counts again: now touches ${comps.join(", ")}`, "Mission Control");
      Object.assign(cur, { components: JSON.stringify(comps), ignored });
    }
    if (!cur.ignored && (cur.state !== i.state || cur.summary !== i.summary)) this.event(checkId, i.state, label(i), origin, now);
    Object.assign(cur, { state: i.state, worst: w, summary: i.summary, missing_count: 0 });
  }

  /** Records each vendor post once, however many polls see it. */
  private sourceUpdates(issueId: number, i: Issue, origin: string) {
    for (const u of i.updates ?? []) {
      const fp = createHash("sha1").update(`${u.t}|${u.text}`).digest("hex").slice(0, 16);
      this.db.prepare("INSERT OR IGNORE INTO issue_updates (issue_id, t, kind, state, text, by, fp) VALUES (?, ?, 'source', NULL, ?, ?, ?)")
        .run(issueId, u.t, u.text.slice(0, 4000), origin, fp);
    }
  }

  private update(issueId: number, t: number, kind: string, state: string | null, text: string, by?: string) {
    this.db.prepare("INSERT INTO issue_updates (issue_id, t, kind, state, text, by) VALUES (?, ?, ?, ?, ?, ?)").run(issueId, t, kind, state, text, by ?? null);
  }

  private closeIssue(o: IssueRow, reason: "cleared" | "false_alarm" | "manual", now: number, message?: string, origin?: string, by?: string) {
    this.db.prepare("UPDATE issues SET closed_at = ?, close_reason = ? WHERE id = ?").run(now, reason, o.id);
    o.closed_at = now;
    const text = reason === "false_alarm" ? "Closed as a false alarm" : reason === "manual" ? "Cleared manually" : o.key === SIGNAL_KEY ? "Signal restored" : "Cleared by the source";
    this.update(o.id, now, "closed", reason === "false_alarm" ? "false" : "ok", text, by ?? origin ?? "Monitor");
    // Tracked incidents are kept: archive them automatically when they close.
    const t = this.db.prepare("SELECT tracked_at, archived_at FROM issues WHERE id = ?").get(o.id) as { tracked_at: number | null; archived_at: number | null };
    if (t.tracked_at && !t.archived_at) {
      this.db.prepare("UPDATE issues SET archived_at = ?, archived_by = 'auto (tracked)' WHERE id = ?").run(now, o.id);
      this.update(o.id, now, "action", null, "Archived automatically because it was tracked", "Mission Control");
    }
    if (message) this.event(o.check_id, "ok", message, origin ?? "Monitor", now);
  }

  // ---------- incident records ----------

  issue(id: number): IssueRow | undefined {
    return this.db.prepare("SELECT * FROM issues WHERE id = ?").get(id) as IssueRow | undefined;
  }
  trackIssue(id: number, on: boolean, by: string, now = Date.now()) {
    const i = this.issue(id); if (!i) throw new UserError("No such incident");
    if (on && i.closed_at) throw new UserError("This incident is already closed. Archive it to keep the record.");
    tx(this.db, () => {
      this.db.prepare("UPDATE issues SET tracked_by = ?, tracked_at = ? WHERE id = ?").run(on ? by : null, on ? now : null, id);
      this.update(id, now, "action", null, on ? "Tracking started" : "Tracking stopped", by);
    });
    this.emit("event", { type: "updated", checkId: i.check_id } satisfies EngineEvent);
  }
  archiveIssue(id: number, on: boolean, by: string, now = Date.now()) {
    const i = this.issue(id); if (!i) throw new UserError("No such incident");
    if (on && !i.closed_at) throw new UserError("Archive works on closed incidents. Track this one and it will be archived when it closes.");
    tx(this.db, () => {
      this.db.prepare("UPDATE issues SET archived_by = ?, archived_at = ? WHERE id = ?").run(on ? by : null, on ? now : null, id);
      this.update(id, now, "action", null, on ? "Archived: kept permanently" : "Removed from the archive", by);
    });
  }
  addNote(id: number, text: string, by: string, now = Date.now()) {
    const i = this.issue(id); if (!i) throw new UserError("No such incident");
    const t = text.trim(); if (!t) throw new UserError("The note is empty");
    this.update(id, now, "note", null, t.slice(0, 4000), by);
  }
  /** Drops closed, unarchived incidents and old log lines past retention. Archived records stay. */
  purge(now = Date.now(), keep = RETENTION) {
    const cutoff = now - keep;
    const r = this.db.prepare("DELETE FROM issues WHERE closed_at IS NOT NULL AND closed_at < ? AND archived_at IS NULL").run(cutoff);
    this.db.prepare("DELETE FROM events WHERE t < ?").run(cutoff);
    this.db.prepare("DELETE FROM spans WHERE end IS NOT NULL AND end < ?").run(cutoff);
    return Number(r.changes);
  }

  private event(checkId: string, state: State | "false", message: string, origin: string, now: number) {
    this.db.prepare("INSERT INTO events (check_id, t, state, message, origin) VALUES (?, ?, ?, ?, ?)").run(checkId, now, state, message, origin);
  }

  /** Derives the check's displayed state from open issues, snooze and park; records spans. */
  recompute(checkId: string, now = Date.now(), opts: { falseAlarm?: boolean } = {}) {
    const st = this.state(checkId)!;
    const open = this.activeIssues(checkId);
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
    const summary = top ? (top.ref ? `${top.ref}: ` : "") + top.summary + (open.length > 1 ? ` (+${open.length - 1} more)` : "") : st.summary;

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

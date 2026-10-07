import { canSee, type Principal } from "../access/policy.ts";
import type { Connector } from "../connectors/schema.ts";
import { DRIVERS } from "../connectors/drivers/index.ts";
import type { Parked, Snooze, State } from "../model.ts";
import { DAY, MIN } from "../util/duration.ts";
import type { Engine } from "./engine.ts";
import { originFor } from "./runner.ts";

// The UI's view of a check. Built per principal: anything outside their clearance is
// simply absent, so counts, LEDs and the board never hint that it exists.

export const PEAK_HOLD = 30 * MIN;
const HISTORY = 28 * DAY;

export interface CheckView {
  id: string; name: string; group: string; mono: string; brand: string;
  src: string; via: string; url: string | null;
  state: State; since: number; msg: string; lastSeen: number; monitoredFrom: number;
  incidents: { start: number; end: number | null; state: string }[];
  log: { t: number; state: string; m: string; o: string }[];
  parked: (Parked & { untilLabel: string }) | null;
  snooze: Pick<Snooze, "by" | "until" | "note"> | null;
  peak: { state: State; at: number; dur: number } | null;
  /** Open incidents, so the card and panel can show references and tracking without another call. */
  issues: { id: number; ref: string | null; summary: string; state: string; openedAt: number; tracked: boolean; components: string[]; manual: boolean; ignored: boolean }[];
  /** Platforms only: one entry per part, with its own state from the open issues touching it. */
  platform: boolean;
  demo: boolean;
  size: string;
  criticality: string;
  components: { name: string; relevance: string; note?: string; state: string; open: number; summary: string | null }[];
  sensitivity?: string;
}

const fmtEvery = (ms: number) => ms % 3600e3 === 0 ? `${ms / 3600e3}h` : ms % 60e3 === 0 ? `${ms / 60e3}m` : `${Math.round(ms / 1000)}s`;

export function srcLabel(c: Connector): string {
  if (c.driver === "webhook") return "webhook";
  if (c.driver === "heartbeat") return `ping ${fmtEvery(c.every)}`;
  if (c.driver === "json") return `api ${fmtEvery(c.every)}`;
  if (c.driver === "http") return `http ${fmtEvery(c.every)}`;
  return `poll ${fmtEvery(c.every)}`;
}

function initials(name: string) {
  const w = name.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] ?? "?").slice(0, 2)).toUpperCase();
}
function hashColor(s: string) {
  let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 45% 32%)`;
}

export function visibleChecks(engine: Engine, p: Principal, opts: { includeSensitivity?: boolean } = {}, now = Date.now()): CheckView[] {
  const spansQ = engine.db.prepare("SELECT state, start, end FROM spans WHERE check_id = ? AND (end IS NULL OR end > ?) ORDER BY start");
  const logQ = engine.db.prepare("SELECT t, state, message AS m, origin AS o FROM events WHERE check_id = ? ORDER BY t DESC, id DESC LIMIT 40");
  const out: CheckView[] = [];
  for (const row of engine.checks()) {
    const c = row.connector;
    if (!row.enabled || !canSee(p, c)) continue;
    const st = engine.state(c.id); if (!st) continue;
    const spans = spansQ.all(c.id, now - HISTORY) as { state: string; start: number; end: number | null }[];
    const parked: Parked | null = st.parked ? JSON.parse(st.parked) : null;
    const snooze: Snooze | null = st.snooze ? JSON.parse(st.snooze) : null;
    out.push({
      id: c.id, name: c.name, group: c.group,
      mono: c.icon?.mono ?? initials(c.name), brand: c.icon?.color ?? hashColor(c.id),
      src: srcLabel(c), via: originFor(c.driver), url: c.link ?? null,
      state: st.state, since: st.since, msg: st.summary || "Waiting for first reading",
      lastSeen: st.last_ok_at ?? st.monitored_from, monitoredFrom: st.monitored_from,
      incidents: spans,
      log: logQ.all(c.id) as CheckView["log"],
      parked: parked && { ...parked, untilLabel: parked.until ? new Date(parked.until).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "unparked" },
      snooze: snooze && { by: snooze.by, until: snooze.until, note: snooze.note },
      peak: st.state === "ok" ? peakOf(spans, now) : null,
      issues: engine.openIssues(c.id).map(i => ({ id: i.id, ref: i.ref ?? null, summary: i.summary, state: i.state, openedAt: i.opened_at, tracked: !!i.tracked_at,
        components: JSON.parse(i.components ?? "[]"), manual: !!i.manual, ignored: !!i.ignored })),
      platform: c.platform || c.components.length > 0,
      demo: c.demo, size: engine.size(c.id), criticality: c.criticality,
      components: c.platform || c.components.length ? componentStates(engine, c.id) : [],
      ...(opts.includeSensitivity ? { sensitivity: c.sensitivity } : {}),
    });
  }
  return out;
}

function componentStates(engine: Engine, checkId: string): CheckView["components"] {
  const open = engine.openIssues(checkId).filter(i => i.key !== "_signal");
  const rank: Record<string, number> = { crit: 6, warn: 5, stale: 4, maint: 2 };
  return engine.components(checkId).map(comp => {
    const mine = open.filter(i => (JSON.parse(i.components ?? "[]") as string[]).some(n => n.toLowerCase() === comp.name.toLowerCase()));
    const top = [...mine].sort((a, b) => (rank[b.state] ?? 0) - (rank[a.state] ?? 0))[0];
    return { ...comp, state: top?.state ?? "ok", open: mine.length, summary: top ? (top.ref ? `${top.ref}: ` : "") + top.summary : null };
  }).sort((a, b) => (a.relevance === "ignore" ? 1 : 0) - (b.relevance === "ignore" ? 1 : 0) || (rank[b.state] ?? 0) - (rank[a.state] ?? 0) || a.name.localeCompare(b.name));
}

/** The worst state in the run of spans that ended most recently, if it ended within the hold. */
function peakOf(spans: { state: string; start: number; end: number | null }[], now: number): CheckView["peak"] {
  const closed = spans.filter(s => s.end !== null && s.state !== "false");
  const last = closed[closed.length - 1];
  if (!last || now - last.end! > PEAK_HOLD) return null;
  const rank: Record<string, number> = { crit: 6, warn: 5, stale: 4, ack: 3, maint: 2 };
  let start = last.start, w = last.state;
  for (let i = closed.length - 2; i >= 0 && closed[i].end === start; i--) {
    start = closed[i].start;
    if ((rank[closed[i].state] ?? 0) > (rank[w] ?? 0)) w = closed[i].state;
  }
  if (w === "maint") return null; // planned work isn't a peak
  return { state: (w === "ack" ? "warn" : w === "stale" ? "warn" : w) as State, at: last.end!, dur: last.end! - start };
}

export const isPushDriver = (d: string) => DRIVERS[d]?.kind === "push";

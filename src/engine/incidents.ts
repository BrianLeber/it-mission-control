import { canSee, type Principal } from "../access/policy.ts";
import type { Connector } from "../connectors/schema.ts";
import type { Engine, IssueRow } from "./engine.ts";

// Incident records for people: list, detail, export. Visibility follows the check's
// sensitivity, so an incident on a hidden check is as absent as the check itself.

export type IncidentStatus = "open" | "closed" | "tracked" | "archived" | "all";

export interface IncidentView {
  id: number; checkId: string; checkName: string; ref: string | null; title: string; detail: string | null;
  state: string; worst: string; url: string | null; openedAt: number; startedAt: number | null; closedAt: number | null; closeReason: string | null;
  tracked: { by: string; at: number } | null; archived: { by: string; at: number } | null;
}
export interface IncidentUpdate { t: number; kind: string; state: string | null; text: string; by: string | null }

const toView = (r: IssueRow, c: Connector): IncidentView => ({
  id: r.id, checkId: r.check_id, checkName: c.name, ref: r.ref ?? null,
  title: r.key === "_signal" ? r.summary : r.summary, detail: r.detail ?? null,
  state: r.closed_at ? (r.close_reason === "false_alarm" ? "false" : "ok") : r.state, worst: r.worst, url: r.url,
  openedAt: r.opened_at, startedAt: r.started_at ?? null, closedAt: r.closed_at, closeReason: r.close_reason,
  tracked: r.tracked_at ? { by: r.tracked_by!, at: r.tracked_at } : null,
  archived: r.archived_at ? { by: r.archived_by!, at: r.archived_at } : null,
});

export function listIncidents(engine: Engine, p: Principal, f: { status?: IncidentStatus; check?: string; q?: string; limit?: number } = {}): IncidentView[] {
  const where: string[] = [], args: (string | number)[] = [];
  const status = f.status ?? "all";
  if (status === "open") where.push("i.closed_at IS NULL");
  if (status === "closed") where.push("i.closed_at IS NOT NULL");
  if (status === "tracked") where.push("i.tracked_at IS NOT NULL");
  if (status === "archived") where.push("i.archived_at IS NOT NULL");
  if (f.check) { where.push("i.check_id = ?"); args.push(f.check); }
  const rows = engine.db.prepare(`SELECT i.*, c.def FROM issues i JOIN checks c ON c.id = i.check_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY (i.closed_at IS NULL) DESC, i.opened_at DESC LIMIT 1000`).all(...args) as unknown as (IssueRow & { def: string })[];
  const q = f.q?.trim().toLowerCase();
  const out: IncidentView[] = [];
  for (const r of rows) {
    const c = JSON.parse(r.def) as Connector;
    if (!canSee(p, c)) continue;
    const v = toView(r, c);
    if (q && ![v.ref, v.title, v.detail, v.checkName].some(x => x?.toLowerCase().includes(q))) continue;
    out.push(v);
    if (out.length >= (f.limit ?? 200)) break;
  }
  return out;
}

export function getIncident(engine: Engine, p: Principal, id: number): (IncidentView & { updates: IncidentUpdate[] }) | null {
  const r = engine.issue(id); if (!r) return null;
  const c = engine.connector(r.check_id);
  if (!c || !canSee(p, c)) return null;
  const updates = engine.db.prepare("SELECT t, kind, state, text, by FROM issue_updates WHERE issue_id = ? ORDER BY t, id").all(id) as unknown as IncidentUpdate[];
  return { ...toView(r, c), updates };
}

const iso = (t: number) => new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC";
function dur(ms: number) {
  const m = Math.round(ms / 60e3), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? `${d}d ${h % 24}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
}
const STATE_WORD: Record<string, string> = { crit: "Down", warn: "Degraded", stale: "No signal", maint: "Maintenance", ack: "Snoozed", ok: "Resolved", false: "False alarm" };

/** A plain record suitable for a ticket, a postmortem or a Slack thread. */
export function incidentMarkdown(i: IncidentView & { updates: IncidentUpdate[] }, now = Date.now()): string {
  const lines = [
    `# ${i.ref ? `${i.ref}: ` : ""}${i.title}`,
    "",
    `- **Service:** ${i.checkName}`,
    `- **Status:** ${i.closedAt ? STATE_WORD[i.state] : `${STATE_WORD[i.state]} (open)`} · worst: ${STATE_WORD[i.worst]}`,
    ...(i.startedAt ? [`- **Started (per source):** ${iso(i.startedAt)}`] : []),
    `- **Detected:** ${iso(i.openedAt)}`,
    i.closedAt ? `- **Closed:** ${iso(i.closedAt)} (${dur(i.closedAt - (i.startedAt ?? i.openedAt))})` : `- **Open for:** ${dur(now - (i.startedAt ?? i.openedAt))}`,
    ...(i.detail ? [`- **Impact:** ${i.detail}`] : []),
    ...(i.url ? [`- **Source:** ${i.url}`] : []),
    ...(i.tracked ? [`- **Tracked by:** ${i.tracked.by}`] : []),
    "",
    "## Timeline",
    "",
    ...i.updates.map(u => `- ${iso(u.t)} · ${u.kind === "note" ? "**Note**" : u.kind === "source" ? "Vendor update" : u.kind === "opened" ? "Detected" : u.kind[0].toUpperCase() + u.kind.slice(1)}${u.by ? ` (${u.by})` : ""}: ${u.text.replace(/\n+/g, " ")}`),
    "",
  ];
  return lines.join("\n");
}

import { z } from "zod";
import type { Issue, IssueState, Observation } from "../../model.ts";
import { defineDriver } from "./types.ts";

// Atlassian Statuspage public API (/api/v2/summary.json). Used by a large share of SaaS
// vendors, so one driver covers GitHub, Zoom, Atlassian, Cloudflare, Dropbox and many more.

const Impact = z.enum(["crit", "warn", "maint", "ignore"]);
const Options = z.object({
  url: z.url().describe("The page's /api/v2/summary.json URL"),
  components: z.array(z.string()).default([]).describe("Only watch these component names (empty = all)"),
  impact_map: z.object({ none: Impact, minor: Impact, major: Impact, critical: Impact, maintenance: Impact })
    .partial().default({}),
  include_maintenance: z.boolean().default(true),
});

interface Ref { id: string; name: string }
interface Summary {
  status?: { indicator?: string; description?: string };
  components?: { id: string; name: string; status: string; group?: boolean }[];
  incidents?: { id: string; name: string; status: string; impact: string; shortlink?: string; created_at?: string; components?: Ref[] }[];
  scheduled_maintenances?: { id: string; name: string; status: string; shortlink?: string; scheduled_for?: string; components?: Ref[] }[];
}

const IMPACT: Record<string, IssueState | "ignore"> = { none: "warn", minor: "warn", major: "crit", critical: "crit", maintenance: "maint" };
const COMPONENT: Record<string, IssueState> = {
  degraded_performance: "warn", partial_outage: "warn", major_outage: "crit", under_maintenance: "maint",
};
const PRETTY: Record<string, string> = {
  degraded_performance: "degraded performance", partial_outage: "partial outage",
  major_outage: "major outage", under_maintenance: "under maintenance",
};
const CLOSED = new Set(["resolved", "postmortem", "completed"]);

export function parseStatuspage(s: Summary, o: z.output<typeof Options>): Observation {
  const want = (name: string) => o.components.length === 0 || o.components.some(c => c.toLowerCase() === name.toLowerCase());
  const touches = (refs?: Ref[]) => o.components.length === 0 || !refs?.length || refs.some(r => want(r.name));
  const map: Record<string, IssueState | "ignore"> = { ...IMPACT };
  for (const [k, v] of Object.entries(o.impact_map)) if (v) map[k] = v;
  const issues: Issue[] = [];
  const covered = new Set<string>();

  for (const i of s.incidents ?? []) {
    if (CLOSED.has(i.status) || !touches(i.components)) continue;
    const st = map[i.impact] ?? "warn";
    i.components?.forEach(c => covered.add(c.id));
    if (st === "ignore") continue;
    issues.push({ key: `inc:${i.id}`, state: st, summary: i.name, url: i.shortlink, startedAt: Date.parse(i.created_at ?? "") || undefined });
  }
  if (o.include_maintenance) {
    for (const m of s.scheduled_maintenances ?? []) {
      if (!["in_progress", "verifying"].includes(m.status) || !touches(m.components)) continue;
      m.components?.forEach(c => covered.add(c.id));
      const st = map.maintenance ?? "maint";
      if (st !== "ignore") issues.push({ key: `mnt:${m.id}`, state: st, summary: `Maintenance: ${m.name}`, url: m.shortlink });
    }
  }
  // Components that are unhappy without a posted incident still count.
  for (const c of s.components ?? []) {
    if (c.group || !COMPONENT[c.status] || covered.has(c.id) || !want(c.name)) continue;
    issues.push({ key: `cmp:${c.id}`, state: COMPONENT[c.status], summary: `${c.name}: ${PRETTY[c.status]}` });
  }
  return { issues, okSummary: s.status?.description || "All systems operational" };
}

export default defineDriver({
  name: "statuspage",
  kind: "poll",
  summary: "Atlassian Statuspage pages (summary.json): incidents, maintenance and component status.",
  options: Options,
  example: `id: github
name: GitHub
group: Public SaaS
icon: { mono: GH, color: "#24292f" }
link: https://www.githubstatus.com/
sensitivity: public
driver: statuspage
every: 1h
options:
  url: https://www.githubstatus.com/api/v2/summary.json
  components: [Actions, Git Operations]   # optional
`,
  async poll(o, ctx) {
    const r = await ctx.fetch(o.url);
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(o.url).host}`);
    return parseStatuspage(r.json<Summary>(), o);
  },
});

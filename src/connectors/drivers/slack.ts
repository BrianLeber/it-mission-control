import { z } from "zod";
import type { Issue, IssueState, Observation } from "../../model.ts";
import { defineDriver } from "./types.ts";

// Slack's own status API: https://slack-status.com/api/v2.0.0/current
const St = z.enum(["crit", "warn", "maint", "ignore"]);
const Options = z.object({
  url: z.url().default("https://slack-status.com/api/v2.0.0/current"),
  type_map: z.record(z.string(), St).default({}),
});

interface Current {
  status?: string;
  active_incidents?: { id: number | string; title: string; type?: string; status?: string; url?: string; date_created?: string;
    notes?: { date_created?: string; body?: string }[]; services?: string[] }[];
}
const TYPES: Record<string, IssueState | "ignore"> = { outage: "crit", incident: "warn", notice: "warn", maintenance: "maint" };

export function parseSlack(c: Current, o: z.output<typeof Options>): Observation {
  const map = { ...TYPES, ...o.type_map };
  const issues: Issue[] = [];
  for (const i of c.active_incidents ?? []) {
    if (i.status && ["resolved", "completed"].includes(i.status)) continue;
    const st = map[i.type ?? "incident"] ?? "warn";
    if (st === "ignore") continue;
    issues.push({
      key: `inc:${i.id}`, state: st, summary: i.title, url: i.url, components: i.services?.length ? i.services : undefined, startedAt: Date.parse(i.date_created ?? "") || undefined,
      updates: (i.notes ?? []).map(n => ({ t: Date.parse(n.date_created ?? ""), text: (n.body ?? "").trim() })).filter(u => u.t && u.text).sort((a, b) => a.t - b.t),
    });
  }
  return { issues, okSummary: "All services operational" };
}

export default defineDriver({
  name: "slack-status",
  kind: "poll",
  summary: "Slack's public status API (active incidents, outages and notices).",
  options: Options,
  example: `id: slack
name: Slack
group: Public SaaS
icon: { mono: Sl, color: "#611f69" }
link: https://slack-status.com/
sensitivity: public
driver: slack-status
every: 1h
`,
  async poll(o, ctx) {
    const r = await ctx.fetch(o.url);
    if (!r.ok) throw new Error(`HTTP ${r.status} from slack-status.com`);
    return parseSlack(r.json<Current>(), o);
  },
});

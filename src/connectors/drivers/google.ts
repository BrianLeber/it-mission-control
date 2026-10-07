import { z } from "zod";
import type { Issue, IssueState, Observation } from "../../model.ts";
import { defineDriver } from "./types.ts";

// Google's incident feeds share one format:
//   Workspace: https://www.google.com/appsstatus/dashboard/incidents.json
//   Cloud:     https://status.cloud.google.com/incidents.json
const St = z.enum(["crit", "warn", "maint", "ignore"]);
const Options = z.object({
  url: z.url().default("https://www.google.com/appsstatus/dashboard/incidents.json"),
  base: z.url().default("https://www.google.com/appsstatus/dashboard/"),
  products: z.array(z.string()).default([]).describe("Only these products, e.g. Gmail, Google Drive"),
  impact_map: z.record(z.string(), St).default({}),
});

interface Incident {
  id: string; number?: string; begin?: string; end?: string | null; external_desc?: string;
  service_name?: string; status_impact?: string; uri?: string;
  most_recent_update?: { status?: string; text?: string };
  affected_products?: { title: string; id?: string }[];
}
const IMPACT: Record<string, IssueState | "ignore"> = {
  SERVICE_OUTAGE: "crit", SERVICE_DISRUPTION: "warn", SERVICE_INFORMATION: "ignore", AVAILABLE: "ignore",
};

export function parseGoogle(list: Incident[], o: z.output<typeof Options>): Observation {
  const map = { ...IMPACT, ...o.impact_map };
  const want = (i: Incident) => o.products.length === 0 ||
    [i.service_name, ...(i.affected_products ?? []).map(p => p.title)].some(n => n && o.products.some(w => w.toLowerCase() === n.toLowerCase()));
  const issues: Issue[] = [];
  for (const i of list) {
    if (i.end || !want(i)) continue;
    const st = map[i.most_recent_update?.status ?? i.status_impact ?? ""] ?? map[i.status_impact ?? ""] ?? "warn";
    if (st === "ignore") continue;
    const what = i.affected_products?.map(p => p.title).join(", ") || i.service_name || "Google";
    issues.push({
      key: `inc:${i.id}`, state: st,
      summary: `${what}: ${(i.external_desc ?? "Incident").split("\n")[0].trim()}`,
      url: i.uri ? new URL(i.uri, o.base).toString() : o.base,
      startedAt: Date.parse(i.begin ?? "") || undefined,
    });
  }
  return { issues, okSummary: "No active incidents" };
}

export default defineDriver({
  name: "google-incidents",
  kind: "poll",
  summary: "Google Workspace or Google Cloud incidents.json feeds.",
  options: Options,
  example: `id: google-workspace
name: Google Workspace
group: Public SaaS
icon: { mono: G, color: "#1a73e8" }
link: https://www.google.com/appsstatus/dashboard/
sensitivity: public
driver: google-incidents
options:
  products: [Gmail, Google Drive]   # optional
`,
  async poll(o, ctx) {
    const r = await ctx.fetch(o.url);
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(o.url).host}`);
    return parseGoogle(r.json<Incident[]>(), o);
  },
});

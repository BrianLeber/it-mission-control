import { z } from "zod";
import type { Issue, IssueState, Observation } from "../../model.ts";
import type { SafeFetch } from "../fetch.ts";
import { defineDriver } from "./types.ts";
import { plain } from "../../util/feed.ts";

// Microsoft 365 service health for your tenant via Microsoft Graph.
// Needs an app registration with the ServiceHealth.Read.All application permission.
const Options = z.object({
  tenant_id: z.string().min(1),
  client_id: z.string().min(1),
  client_secret: z.string().min(1).describe("Use ${secret:m365_client_secret}"),
  services: z.array(z.string()).default([]).describe('Only these, e.g. "Exchange Online", "Microsoft Teams"'),
  include_advisories: z.boolean().default(false),
  /** Sovereign clouds: GCC High uses https://login.microsoftonline.us and https://graph.microsoft.us */
  authority: z.url().default("https://login.microsoftonline.com"),
  graph_base: z.url().default("https://graph.microsoft.com"),
});

interface GraphIssue {
  id: string; title: string; service?: string; status?: string; classification?: string;
  isResolved?: boolean; startDateTime?: string; impactDescription?: string;
  posts?: { createdDateTime?: string; postType?: string; description?: { content?: string } }[];
}
const CLOSED = new Set(["serviceRestored", "postIncidentReviewPublished", "falsePositive", "resolved", "resolvedExternal", "mitigated", "mitigatedExternal"]);

export function parseGraphIssues(list: GraphIssue[], o: z.output<typeof Options>): Observation {
  const issues: Issue[] = [];
  for (const i of list) {
    if (i.isResolved || CLOSED.has(i.status ?? "")) continue;
    if (o.services.length && !o.services.some(s => s.toLowerCase() === (i.service ?? "").toLowerCase())) continue;
    let state: IssueState;
    if (i.classification === "incident") state = i.status === "serviceInterruption" ? "crit" : "warn";
    else if (o.include_advisories) state = "warn";
    else continue;
    issues.push({
      key: `issue:${i.id}`, state, summary: i.title, ref: i.id, components: i.service ? [i.service] : undefined,
      detail: [i.service, i.impactDescription].filter(Boolean).join(": ") || undefined,
      url: `https://admin.microsoft.com/#/servicehealth/:/alerts/${encodeURIComponent(i.id)}`,
      startedAt: Date.parse(i.startDateTime ?? "") || undefined,
      updates: (i.posts ?? [])
        .map(p => ({ t: Date.parse(p.createdDateTime ?? ""), text: plain(p.description?.content ?? "").slice(0, 2000) }))
        .filter(u => u.t && u.text).sort((a, b) => a.t - b.t),
    });
  }
  return { issues, okSummary: "No open service health incidents" };
}

const tokens = new Map<string, { token: string; until: number }>();
async function token(o: z.output<typeof Options>, fetch: SafeFetch): Promise<string> {
  const k = `${o.tenant_id}:${o.client_id}`;
  const hit = tokens.get(k);
  if (hit && hit.until > Date.now() + 60_000) return hit.token;
  const r = await fetch(`${o.authority.replace(/\/$/, "")}/${encodeURIComponent(o.tenant_id)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: o.client_id, client_secret: o.client_secret, scope: `${o.graph_base.replace(/\/$/, "")}/.default`, grant_type: "client_credentials" }).toString(),
  });
  if (!r.ok) throw new Error(`Microsoft sign-in failed (HTTP ${r.status}). Check tenant, client ID and secret.`);
  const j = r.json<{ access_token: string; expires_in: number }>();
  tokens.set(k, { token: j.access_token, until: Date.now() + j.expires_in * 1000 });
  return j.access_token;
}

export default defineDriver({
  name: "ms-graph-service-health",
  kind: "poll",
  summary: "Microsoft 365 service health for your tenant (Graph serviceAnnouncement/issues).",
  options: Options,
  example: `id: m365
name: Microsoft 365
group: Public SaaS
icon: { mono: "365", color: "#c43e1c" }
link: https://admin.microsoft.com/#/servicehealth
sensitivity: viewer
driver: ms-graph-service-health
every: 1h
options:
  tenant_id: \${secret:m365_tenant_id}
  client_id: \${secret:m365_client_id}
  client_secret: \${secret:m365_client_secret}
`,
  async poll(o, ctx) {
    const t = await token(o, ctx.fetch);
    const url = `${o.graph_base.replace(/\/$/, "")}/v1.0/admin/serviceAnnouncement/issues?$filter=isResolved%20eq%20false&$top=100`;
    const r = await ctx.fetch(url, { headers: { authorization: `Bearer ${t}` } });
    if (!r.ok) throw new Error(`Graph returned HTTP ${r.status}. The app needs ServiceHealth.Read.All.`);
    return parseGraphIssues(r.json<{ value: GraphIssue[] }>().value ?? [], o);
  },
});

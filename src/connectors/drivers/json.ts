import { z } from "zod";
import type { Issue, Observation } from "../../model.ts";
import { getPath, template } from "../../util/path.ts";
import { defineDriver } from "./types.ts";

// Generic JSON/REST check driven by declarative rules, so most custom connectors need no code.
// Rules read values with dot paths ("data.total", "items[0].status", "alerts.length").
const Op = z.enum(["==", "!=", ">", ">=", "<", "<=", "contains", "matches", "exists", "missing", "truthy", "falsy"]);
const Rule = z.object({
  path: z.string(),
  op: Op,
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  state: z.enum(["crit", "warn", "maint", "stale"]),
  summary: z.string().describe("Text shown on the card; {{path}} placeholders allowed"),
  key: z.string().optional().describe("Correlation key template; defaults to the rule index"),
});
const Options = z.object({
  url: z.url(),
  method: z.enum(["GET", "POST"]).default("GET"),
  headers: z.record(z.string(), z.string()).default({}).describe("Use ${secret:name} for credentials"),
  body: z.string().optional(),
  expect_status: z.array(z.number().int()).default([200]),
  items_path: z.string().optional().describe("Evaluate rules once per element of this array"),
  rules: z.array(Rule).min(1),
  ok_summary: z.string().default("All checks passed"),
});

function test(v: unknown, op: z.output<typeof Op>, want: unknown): boolean {
  switch (op) {
    case "exists": return v !== undefined && v !== null;
    case "missing": return v === undefined || v === null;
    case "truthy": return !!v;
    case "falsy": return !v;
    case "==": return v == want; // loose on purpose: "5" == 5 from YAML
    case "!=": return v != want;
    case ">": return Number(v) > Number(want);
    case ">=": return Number(v) >= Number(want);
    case "<": return Number(v) < Number(want);
    case "<=": return Number(v) <= Number(want);
    case "contains": return Array.isArray(v) ? v.includes(want) : String(v ?? "").includes(String(want));
    case "matches": return new RegExp(String(want), "i").test(String(v ?? ""));
  }
}

interface RuleCtx { $: unknown; item: unknown; i: number }
/** "$.a.b" reads from the whole response; "item.a" or plain "a" read from the current item. */
function lookup(ctx: unknown, path: string): unknown {
  const c = ctx as RuleCtx;
  if (path === "$" || path.startsWith("$.") || path.startsWith("$[")) return getPath(c.$, path);
  if (path === "item") return c.item;
  if (path.startsWith("item.")) return getPath(c.item, path.slice(5));
  if (path === "i") return c.i;
  return getPath(c.item, path);
}

export function evaluateRules(doc: unknown, o: z.output<typeof Options>): Observation {
  const contexts = o.items_path
    ? ((getPath(doc, o.items_path) as unknown[] | undefined) ?? []).map((item, i) => ({ $: doc, item, i }))
    : [{ $: doc, item: doc, i: 0 }];
  const issues: Issue[] = [];
  for (const ctx of contexts) {
    o.rules.forEach((r, n) => {
      if (!test(lookup(ctx, r.path), r.op, r.value)) return;
      const key = r.key ? template(r.key, ctx, lookup) : o.items_path ? `${n}:${ctx.i}` : String(n);
      if (!issues.some(x => x.key === `rule:${key}`)) issues.push({ key: `rule:${key}`, state: r.state, summary: template(r.summary, ctx, lookup) });
    });
  }
  return { issues, okSummary: template(o.ok_summary, { $: doc, item: doc, i: 0 }, lookup) };
}

export default defineDriver({
  name: "json",
  kind: "poll",
  summary: "Any JSON API, judged by declarative rules (thresholds, matches, per-item checks).",
  options: Options,
  example: `id: front-it-queue
name: Front · IT queue
group: Our platforms
icon: { mono: F, color: "#a23ce0" }
link: https://app.frontapp.com/
sensitivity: viewer
driver: json
every: 1h
options:
  url: https://api2.frontapp.com/conversations/search/is:open%20inbox:inb_XXXX
  headers: { Authorization: "Bearer \${secret:front_api_token}" }
  rules:
    - { path: _total, op: ">", value: 25, state: warn, summary: "{{_total}} open conversations" }
  ok_summary: "{{$._total}} open"
`,
  async poll(o, ctx) {
    const r = await ctx.fetch(o.url, { method: o.method, headers: o.headers, body: o.body });
    if (!o.expect_status.includes(r.status)) {
      return { issues: [{ key: "http", state: "crit", summary: `HTTP ${r.status} from ${new URL(o.url).host}` }] };
    }
    return evaluateRules(r.json(), o);
  },
});

import { z } from "zod";
import type { Issue } from "../../model.ts";
import { defineDriver } from "./types.ts";

// Plain reachability check for internal servers and web apps. Unreachable is DOWN here,
// not NO SIGNAL, because reaching the target is the thing being measured.
const Options = z.object({
  url: z.url(),
  method: z.enum(["GET", "HEAD"]).default("GET"),
  expect_status: z.array(z.number().int()).default([200, 204, 301, 302, 304]),
  contains: z.string().optional().describe("Body must include this text"),
  slow_ms: z.number().int().positive().optional().describe("DEGRADED when slower than this"),
  timeout_ms: z.number().int().positive().max(60_000).default(10_000),
  headers: z.record(z.string(), z.string()).default({}),
});

export default defineDriver({
  name: "http",
  kind: "poll",
  summary: "HTTP(S) reachability: status code, optional body text, optional slow threshold.",
  options: Options,
  example: `id: intranet
name: Intranet
group: Infrastructure
icon: { mono: IN, color: "#3b5b4a" }
link: https://intranet.example.local/
sensitivity: viewer
driver: http
every: 5m
options:
  url: https://intranet.example.local/health
  contains: OK
  slow_ms: 2000
`,
  async poll(o, ctx) {
    const host = new URL(o.url).host;
    let r;
    try { r = await ctx.fetch(o.url, { method: o.method, headers: o.headers, timeoutMs: o.timeout_ms }); }
    catch (e) { return { issues: [{ key: "reach", state: "crit", summary: `${host} unreachable: ${(e as Error).message}` }] }; }
    const issues: Issue[] = [];
    if (!o.expect_status.includes(r.status)) issues.push({ key: "status", state: "crit", summary: `${host} answered HTTP ${r.status}` });
    else if (o.contains && !r.text.includes(o.contains)) issues.push({ key: "body", state: "crit", summary: `${host} response is missing "${o.contains}"` });
    else if (o.slow_ms && r.ms > o.slow_ms) issues.push({ key: "slow", state: "warn", summary: `${host} slow: ${r.ms} ms (limit ${o.slow_ms} ms)` });
    return { issues, okSummary: `${host} OK in ${r.ms} ms` };
  },
});

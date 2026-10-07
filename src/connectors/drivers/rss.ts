import { z } from "zod";
import type { Issue, Observation } from "../../model.ts";
import { parseFeed, type FeedItem } from "../../util/feed.ts";
import { parseDuration } from "../../util/duration.ts";
import { defineDriver } from "./types.ts";

// Generic RSS/Atom incident feed. Feeds describe events, not state, so an item counts as
// an open issue while it is recent and doesn't read as resolved.
const Options = z.object({
  url: z.url(),
  window: z.string().default("24h").describe("Ignore items older than this"),
  resolved_match: z.string().default("\\b(resolved|completed|restored|recovered|operating normally)\\b"),
  crit_match: z.string().default("\\b(outage|down|unavailable|major)\\b"),
  maint_match: z.string().default("\\b(maintenance|scheduled)\\b"),
  ignore_match: z.string().optional(),
});

export function parseRss(items: FeedItem[], o: z.output<typeof Options>, now: number): Observation {
  const rx = (s: string) => new RegExp(s, "i");
  const cutoff = now - parseDuration(o.window);
  const issues: Issue[] = [];
  for (const it of items) {
    if (it.date !== null && it.date < cutoff) continue;
    const text = `${it.title} ${it.text}`;
    if (o.ignore_match && rx(o.ignore_match).test(text)) continue;
    if (rx(o.resolved_match).test(text)) continue;
    const state = rx(o.maint_match).test(text) ? "maint" : rx(o.crit_match).test(text) ? "crit" : "warn";
    issues.push({ key: `item:${it.id}`, state, summary: it.title || "Untitled notice", url: it.link || undefined, startedAt: it.date ?? undefined });
  }
  return { issues, okSummary: "No recent incidents in feed" };
}

export default defineDriver({
  name: "rss",
  kind: "poll",
  summary: "Any RSS or Atom status feed. Recent items that don't read as resolved are open issues.",
  options: Options,
  example: `id: aws-health
name: AWS
group: Public SaaS
icon: { mono: AWS, color: "#232f3e" }
link: https://health.aws.amazon.com/health/status
sensitivity: public
driver: rss
options:
  url: https://status.aws.amazon.com/rss/all.rss
  window: 12h
`,
  async poll(o, ctx) {
    const r = await ctx.fetch(o.url);
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(o.url).host}`);
    return parseRss(parseFeed(r.text), o, ctx.now);
  },
});

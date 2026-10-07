import { test } from "node:test";
import assert from "node:assert/strict";
import statuspage, { parseStatuspage } from "../src/connectors/drivers/statuspage.ts";
import slack, { parseSlack } from "../src/connectors/drivers/slack.ts";
import google, { parseGoogle } from "../src/connectors/drivers/google.ts";
import rss, { parseRss } from "../src/connectors/drivers/rss.ts";
import json, { evaluateRules } from "../src/connectors/drivers/json.ts";
import msgraph, { parseGraphIssues } from "../src/connectors/drivers/msgraph.ts";
import { parseFeed } from "../src/util/feed.ts";

// Payload shapes follow each vendor's documented format.

const SP = {
  status: { indicator: "minor", description: "Partially Degraded Service" },
  components: [
    { id: "c1", name: "Git Operations", status: "operational" },
    { id: "c2", name: "Actions", status: "degraded_performance" },
    { id: "c3", name: "Pages", status: "major_outage" },
    { id: "g1", name: "Group", status: "major_outage", group: true },
  ],
  incidents: [
    { id: "i1", name: "Delays starting Actions jobs", status: "investigating", impact: "minor", shortlink: "https://stspg.io/i1", created_at: "2026-10-07T10:00:00Z", components: [{ id: "c2", name: "Actions" }] },
    { id: "i0", name: "Old one", status: "resolved", impact: "major" },
  ],
  scheduled_maintenances: [
    { id: "m1", name: "Database upgrade", status: "in_progress", shortlink: "https://stspg.io/m1", components: [{ id: "c1", name: "Git Operations" }] },
    { id: "m2", name: "Next week", status: "scheduled" },
  ],
};

test("statuspage: open incidents, active maintenance and uncovered components", () => {
  const o = parseStatuspage(SP, statuspage.options.parse({ url: "https://x.test/api/v2/summary.json" }));
  assert.deepEqual(o.issues.map(i => [i.key, i.state]), [["inc:i1", "warn"], ["mnt:m1", "maint"], ["cmp:c3", "crit"]]);
  assert.equal(o.okSummary, "Partially Degraded Service");
  assert.equal(o.issues[0].url, "https://stspg.io/i1");
});

test("statuspage: component filter and impact override", () => {
  const opts = statuspage.options.parse({ url: "https://x.test/s.json", components: ["actions"], impact_map: { minor: "crit" } });
  const o = parseStatuspage(SP, opts);
  assert.deepEqual(o.issues.map(i => [i.key, i.state]), [["inc:i1", "crit"]]);
});

test("statuspage: all clear", () => {
  const o = parseStatuspage({ status: { description: "All Systems Operational" }, components: [{ id: "a", name: "API", status: "operational" }], incidents: [] },
    statuspage.options.parse({ url: "https://x.test/s.json" }));
  assert.equal(o.issues.length, 0);
  assert.equal(o.okSummary, "All Systems Operational");
});

test("slack: maps incident types", () => {
  const o = parseSlack({ status: "active", active_incidents: [
    { id: 1, title: "Messages failing", type: "outage", status: "active", url: "https://slack-status.com/1" },
    { id: 2, title: "Slow search", type: "incident", status: "active" },
    { id: 3, title: "Done", type: "incident", status: "resolved" },
  ] }, slack.options.parse({}));
  assert.deepEqual(o.issues.map(i => [i.key, i.state]), [["inc:1", "crit"], ["inc:2", "warn"]]);
});

test("google: ongoing incidents only, informational ignored, product filter", () => {
  const list = [
    { id: "a", end: null, external_desc: "Gmail delays\nmore", status_impact: "SERVICE_DISRUPTION", most_recent_update: { status: "SERVICE_DISRUPTION" }, affected_products: [{ title: "Gmail" }], uri: "incidents/a" },
    { id: "b", end: "2026-10-01T00:00:00Z", status_impact: "SERVICE_OUTAGE", affected_products: [{ title: "Gmail" }] },
    { id: "c", status_impact: "SERVICE_INFORMATION", most_recent_update: { status: "SERVICE_INFORMATION" }, affected_products: [{ title: "Google Drive" }] },
    { id: "d", status_impact: "SERVICE_OUTAGE", most_recent_update: { status: "SERVICE_OUTAGE" }, affected_products: [{ title: "Google Meet" }] },
  ];
  const all = parseGoogle(list, google.options.parse({}));
  assert.deepEqual(all.issues.map(i => [i.key, i.state]), [["inc:a", "warn"], ["inc:d", "crit"]]);
  assert.equal(all.issues[0].summary, "Gmail: Gmail delays");
  assert.equal(all.issues[0].url, "https://www.google.com/appsstatus/dashboard/incidents/a");
  assert.equal(parseGoogle(list, google.options.parse({ products: ["gmail"] })).issues.length, 1);
});

const FEED = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[Increased error rates &amp; latency]]></title><link>https://s.test/1</link><guid>g1</guid><pubDate>Wed, 07 Oct 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Investigating&lt;/p&gt;</description></item>
<item><title>Service outage in us-east-1</title><guid>g2</guid><pubDate>Wed, 07 Oct 2026 11:00:00 GMT</pubDate><description>Investigating</description></item>
<item><title>Earlier issue</title><guid>g3</guid><pubDate>Wed, 07 Oct 2026 09:00:00 GMT</pubDate><description>This issue has been resolved.</description></item>
<item><title>Scheduled maintenance</title><guid>g4</guid><pubDate>Wed, 07 Oct 2026 08:00:00 GMT</pubDate></item>
<item><title>Ancient</title><guid>g5</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
</channel></rss>`;

test("rss: recent unresolved items become issues", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  const o = parseRss(parseFeed(FEED), rss.options.parse({ url: "https://s.test/feed" }), now);
  assert.deepEqual(o.issues.map(i => [i.key, i.state]), [["item:g1", "warn"], ["item:g2", "crit"], ["item:g4", "maint"]]);
  assert.equal(o.issues[0].summary, "Increased error rates & latency");
});

test("atom feeds parse too", () => {
  const items = parseFeed(`<feed><entry><id>tag:x,1</id><title>Degraded</title><link href="https://s.test/a"/><updated>2026-10-07T11:00:00Z</updated><summary>Investigating</summary></entry></feed>`);
  assert.deepEqual(items.map(i => [i.id, i.link]), [["tag:x,1", "https://s.test/a"]]);
});

test("json rules: thresholds, root paths, per-item checks and templates", () => {
  const front = evaluateRules({ _total: 31 }, json.options.parse({ url: "https://a.test", rules: [{ path: "_total", op: ">", value: 25, state: "warn", summary: "{{_total}} open" }], ok_summary: "{{$._total}} open" }));
  assert.deepEqual(front.issues, [{ key: "rule:0", state: "warn", summary: "31 open" }]);
  assert.equal(front.okSummary, "31 open");

  const jamf = json.options.parse({ url: "https://a.test", rules: [{ path: "$.length", op: ">", value: 0, state: "crit", summary: "{{$.length}} problem(s): {{$[0].healthCode}}" }] });
  assert.equal(evaluateRules([], jamf).issues.length, 0);
  assert.equal(evaluateRules([{ healthCode: 2 }], jamf).issues[0].summary, "1 problem(s): 2");

  const perItem = json.options.parse({ url: "https://a.test", items_path: "$.hosts", rules: [{ path: "status", op: "!=", value: "up", state: "crit", summary: "{{name}} is {{status}}", key: "{{name}}" }] });
  const o = evaluateRules({ hosts: [{ name: "esx1", status: "up" }, { name: "esx2", status: "down" }] }, perItem);
  assert.deepEqual(o.issues, [{ key: "rule:esx2", state: "crit", summary: "esx2 is down" }]);
});

test("ms graph: open incidents only, interruption is DOWN, advisories opt-in", () => {
  const list = [
    { id: "EX1", title: "Mail delays", classification: "incident", status: "serviceDegradation", service: "Exchange Online" },
    { id: "TM1", title: "Teams down", classification: "incident", status: "serviceInterruption", service: "Microsoft Teams" },
    { id: "EX0", title: "Fixed", classification: "incident", status: "serviceRestored", isResolved: true },
    { id: "SP1", title: "FYI", classification: "advisory", status: "investigating", service: "SharePoint Online" },
  ];
  const base = { tenant_id: "t", client_id: "c", client_secret: "s" };
  assert.deepEqual(parseGraphIssues(list, msgraph.options.parse(base)).issues.map(i => [i.key, i.state]), [["issue:EX1", "warn"], ["issue:TM1", "crit"]]);
  assert.equal(parseGraphIssues(list, msgraph.options.parse({ ...base, include_advisories: true })).issues.length, 3);
  assert.equal(parseGraphIssues(list, msgraph.options.parse({ ...base, services: ["Microsoft Teams"] })).issues.length, 1);
});

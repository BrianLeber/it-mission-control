import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, min } from "./helpers.ts";
import msgraph, { parseGraphIssues } from "../src/connectors/drivers/msgraph.ts";
import { getIncident, incidentMarkdown, listIncidents } from "../src/engine/incidents.ts";
import type { Principal } from "../src/access/policy.ts";

// Built around a real case: Microsoft 365 incident SP1489449, SharePoint Online,
// "Some users are not able to see apps", classified as a degradation.

const viewer: Principal = { kind: "user", id: "1", name: "brian", role: "technician", clearance: "viewer", groups: [] };
const opts = msgraph.options.parse({ tenant_id: "t", client_id: "c", client_secret: "s" });
const graph = (posts: { createdDateTime: string; description: { content: string } }[], extra: object = {}) => parseGraphIssues([{
  id: "SP1489449", title: "Some users are not able to see apps", service: "SharePoint Online",
  classification: "incident", status: "serviceDegradation", isResolved: false,
  impactDescription: "Users may be unable to see apps.", startDateTime: "2026-10-07T10:00:00Z", posts, ...extra,
}], opts);

const post1 = { createdDateTime: "2026-10-07T10:05:00Z", description: { content: "<p>Title: Some users are not able to see apps</p><p>User impact: Users may be unable to see apps.</p>" } };
const post2 = { createdDateTime: "2026-10-07T11:00:00Z", description: { content: "<p>Current status: We're reviewing telemetry.</p>" } };

test("SP1489449 shows as DEGRADED with its reference on the card", () => {
  const { engine } = setup({ id: "m365", driver: "ms-graph-service-health", options: { tenant_id: "t", client_id: "c", client_secret: "s" } });
  const obs = graph([post1]);
  assert.equal(obs.issues[0].state, "warn");
  engine.observe("m365", obs, "Microsoft Graph", min(1));
  const st = engine.state("m365")!;
  assert.equal(st.state, "warn");
  assert.equal(st.summary, "SP1489449: Some users are not able to see apps");
});

test("vendor posts land on the timeline once, however many polls see them", () => {
  const { engine } = setup({ id: "m365", driver: "ms-graph-service-health", options: { tenant_id: "t", client_id: "c", client_secret: "s" } });
  engine.observe("m365", graph([post1]), "Microsoft Graph", min(1));
  engine.observe("m365", graph([post1]), "Microsoft Graph", min(6));
  engine.observe("m365", graph([post1, post2]), "Microsoft Graph", min(11));
  const [row] = listIncidents(engine, viewer, { q: "sp1489449" });
  assert.equal(row.ref, "SP1489449");
  assert.equal(row.detail, "SharePoint Online: Users may be unable to see apps.");
  const inc = getIncident(engine, viewer, row.id)!;
  const source = inc.updates.filter(u => u.kind === "source");
  assert.equal(source.length, 2);
  assert.match(source[0].text, /^Title: Some users are not able to see apps\nUser impact/);
});

test("track, note, close: a tracked incident is archived automatically and survives retention", () => {
  const { engine } = setup({ id: "m365", release: 1, driver: "ms-graph-service-health", options: { tenant_id: "t", client_id: "c", client_secret: "s" } });
  engine.observe("m365", graph([post1]), "Microsoft Graph", min(1));
  const id = listIncidents(engine, viewer, { status: "open" })[0].id;
  assert.throws(() => engine.archiveIssue(id, true, "brian"), /closed incidents/);
  engine.trackIssue(id, true, "brian", min(2));
  engine.addNote(id, "Teams tab apps affected too; told the help desk.", "brian", min(3));
  engine.observe("m365", { issues: [] }, "Microsoft Graph", min(60));
  const inc = getIncident(engine, viewer, id)!;
  assert.equal(inc.state, "ok");
  assert.equal(inc.archived?.by, "auto (tracked)");
  // Microsoft's post (10:05) predates our detection, so the timeline puts it first.
  assert.deepEqual(inc.updates.map(u => u.kind), ["source", "opened", "action", "note", "closed", "action"]);
  assert.equal(inc.startedAt, Date.parse("2026-10-07T10:00:00Z"));

  engine.observe("m365", { issues: [{ key: "other", state: "warn", summary: "Another" }] }, "x", min(70));
  engine.observe("m365", { issues: [] }, "x", min(80));
  const removed = engine.purge(min(80) + 91 * 86400e3);
  assert.equal(removed, 1, "the untracked one goes");
  assert.ok(getIncident(engine, viewer, id), "the archived one stays");
});

test("an incident that comes back within hours reopens the same record", () => {
  const { engine } = setup({ id: "m365", release: 1, driver: "ms-graph-service-health", options: { tenant_id: "t", client_id: "c", client_secret: "s" } });
  engine.observe("m365", graph([post1]), "g", min(1));
  engine.observe("m365", { issues: [] }, "g", min(10));
  engine.observe("m365", graph([post1]), "g", min(30));
  const all = listIncidents(engine, viewer, {});
  assert.equal(all.length, 1);
  assert.ok(getIncident(engine, viewer, all[0].id)!.updates.some(u => u.kind === "reopened"));
});

test("markdown export reads like a record", () => {
  const { engine } = setup({ id: "m365", name: "Microsoft 365", driver: "ms-graph-service-health", options: { tenant_id: "t", client_id: "c", client_secret: "s" } });
  engine.observe("m365", graph([post1]), "Microsoft Graph", min(1));
  const md = incidentMarkdown(getIncident(engine, viewer, listIncidents(engine, viewer)[0].id)!, min(31));
  assert.match(md, /^# SP1489449: Some users are not able to see apps/);
  assert.match(md, /\*\*Status:\*\* Degraded \(open\)/);
  assert.match(md, /\*\*Started \(per source\):\*\* 2026-10-07 10:00 UTC/);
  assert.match(md, /\*\*Open for:\*\* 2h 31m/);
  assert.match(md, /Vendor update \(Microsoft Graph\): Title: Some users/);
});

test("incidents on checks you can't see don't exist for you", () => {
  const { engine } = setup({ id: "payroll", sensitivity: "secret", groups: ["finance"] });
  engine.observe("payroll", { issues: [{ key: "x", state: "crit", summary: "Gateway down" }] }, "x", min(1));
  assert.equal(listIncidents(engine, viewer).length, 0);
  assert.equal(getIncident(engine, viewer, 1), null);
});

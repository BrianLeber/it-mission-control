import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, min } from "./helpers.ts";
import { listIncidents } from "../src/engine/incidents.ts";
import { visibleChecks } from "../src/engine/views.ts";
import type { Principal } from "../src/access/policy.ts";

// The cases from the review: SharePoint (SP1489449) counts, Teams doesn't (we don't use it),
// and Sway is broken with no Microsoft alert, so we report it ourselves.

const tech: Principal = { kind: "user", id: "1", name: "brian", role: "technician", clearance: "viewer", groups: [] };
const m365 = () => setup({
  id: "m365", name: "Microsoft 365", driver: "ms-graph-service-health", platform: true, release: 1,
  options: { tenant_id: "t", client_id: "c", client_secret: "s" },
  components: [{ name: "SharePoint Online" }, { name: "Sway" }, { name: "Microsoft Teams", relevance: "ignore", note: "We don't use Teams" }],
});
const sp = { key: "issue:SP1489449", ref: "SP1489449", state: "warn" as const, summary: "Some users are not able to see apps", components: ["SharePoint Online"] };
const teams = { key: "issue:TM1", ref: "TM1", state: "crit" as const, summary: "Users can't join meetings", components: ["Microsoft Teams"] };

test("a Teams-only outage is recorded but doesn't light the platform", () => {
  const { engine } = m365();
  engine.observe("m365", { issues: [teams] }, "Microsoft Graph", min(1));
  assert.equal(engine.state("m365")!.state, "ok");
  const [inc] = listIncidents(engine, tech, { status: "ignored" });
  assert.equal(inc.ref, "TM1");
  assert.equal(listIncidents(engine, tech, { status: "open" }).length, 0, "the default Open list stays quiet");
});

test("an incident touching Teams and something we use still counts", () => {
  const { engine } = m365();
  engine.observe("m365", { issues: [{ ...teams, components: ["Microsoft Teams", "SharePoint Online"] }] }, "g", min(1));
  assert.equal(engine.state("m365")!.state, "crit");
});

test("SharePoint counts; the card names it, not the ignored Teams outage", () => {
  const { engine } = m365();
  engine.observe("m365", { issues: [teams, sp] }, "g", min(1));
  const st = engine.state("m365")!;
  assert.equal(st.state, "warn", "Teams' crit doesn't escalate it");
  assert.equal(st.summary, "SP1489449: Some users are not able to see apps");
});

test("Sway: a reported issue counts, survives polls that don't mention it, and closes when resolved", () => {
  const { engine } = m365();
  const id = engine.reportIssue("m365", { state: "warn", component: "Sway", title: "Some changes don't save",
    detail: "Users can sign in and edit, but not every change saves; a refresh returns to the last saved state and loses the rest. Confirmed by IT; no Microsoft alert yet." }, "brian", min(1));
  assert.equal(engine.state("m365")!.state, "warn");
  engine.observe("m365", { issues: [] }, "Microsoft Graph", min(5));
  engine.observe("m365", { issues: [] }, "Microsoft Graph", min(10));
  assert.equal(engine.state("m365")!.state, "warn", "vendor silence doesn't clear our report");
  const [inc] = listIncidents(engine, tech, { status: "reported" });
  assert.equal(inc.id, id);
  assert.deepEqual(inc.components, ["Sway"]);
  engine.resolveIssue(id, "brian", "Microsoft fixed it; saves work again.", min(90));
  assert.equal(engine.state("m365")!.state, "ok");
});

test("only reported issues can be resolved by hand", () => {
  const { engine } = m365();
  engine.observe("m365", { issues: [sp] }, "g", min(1));
  assert.throws(() => engine.resolveIssue(listIncidents(engine, tech)[0].id, "brian"), /comes from the source/);
});

test("marking a part not used takes effect on open issues immediately, and can be undone", () => {
  const { engine } = m365();
  engine.observe("m365", { issues: [sp] }, "g", min(1));
  engine.setRelevance("m365", "SharePoint Online", "ignore", "brian", "Moved to Google Drive", min(2));
  assert.equal(engine.state("m365")!.state, "ok");
  engine.setRelevance("m365", "SharePoint Online", "normal", "brian", undefined, min(3));
  assert.equal(engine.state("m365")!.state, "warn");
});

test("a person's report on an ignored part still counts: they saw it affect us", () => {
  const { engine } = m365();
  engine.reportIssue("m365", { state: "crit", component: "Microsoft Teams", title: "Board meeting link broken" }, "brian", min(1));
  assert.equal(engine.state("m365")!.state, "crit");
});

test("the platform view has a card per component with its own state", () => {
  const { engine } = m365();
  engine.observe("m365", { issues: [teams, sp, { key: "issue:EX1", state: "warn", summary: "Mail delays", components: ["Exchange Online"] }] }, "g", min(1));
  const v = visibleChecks(engine, tech)[0];
  assert.equal(v.platform, true);
  const by = Object.fromEntries(v.components.map(c => [c.name, c]));
  assert.equal(by["SharePoint Online"].state, "warn");
  assert.equal(by["Sway"].state, "ok");
  assert.equal(by["Microsoft Teams"].relevance, "ignore");
  assert.equal(by["Exchange Online"].state, "warn", "parts seen in incidents are added automatically");
});

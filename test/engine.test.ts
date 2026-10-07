import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, min } from "./helpers.ts";
import type { Issue } from "../src/model.ts";

const warn = (key = "inc:1", summary = "Delays"): Issue => ({ key, state: "warn", summary });
const crit = (key = "inc:1", summary = "Down"): Issue => ({ key, state: "crit", summary });

test("attack fast, release slow", () => {
  const { engine } = setup({ release: 2 });
  engine.observe("svc", { issues: [warn()] }, "test", min(1));
  assert.equal(engine.state("svc")!.state, "warn");
  engine.observe("svc", { issues: [], okSummary: "All good" }, "test", min(2));
  assert.equal(engine.state("svc")!.state, "warn", "one clean poll is not enough");
  engine.observe("svc", { issues: [], okSummary: "All good" }, "test", min(3));
  const st = engine.state("svc")!;
  assert.equal(st.state, "ok");
  assert.equal(st.summary, "All good");
  assert.equal(st.since, min(3));
});

test("worst open issue wins and the summary names it", () => {
  const { engine } = setup();
  engine.observe("svc", { issues: [warn("a", "Slow"), crit("b", "Pages down")] }, "test", min(1));
  const st = engine.state("svc")!;
  assert.equal(st.state, "crit");
  assert.equal(st.summary, "Pages down (+1 more)");
});

test("failed polls become NO SIGNAL and recover on the next good one", () => {
  const { engine } = setup();
  engine.fail("svc", "HTTP 500", "test", min(1));
  assert.equal(engine.state("svc")!.state, "ok", "a single failure is tolerated");
  engine.fail("svc", "HTTP 500", "test", min(2));
  assert.equal(engine.state("svc")!.state, "stale");
  engine.observe("svc", { issues: [] }, "test", min(3));
  assert.equal(engine.state("svc")!.state, "ok");
});

test("heartbeats go stale, then DOWN", () => {
  const { engine } = setup({ id: "svc", driver: "heartbeat", every: "5m", grace: 2, options: { down_after: "1h" } });
  engine.push("svc", { state: "ok" }, "Heartbeat", min(0));
  engine.sweep(min(9));
  assert.equal(engine.state("svc")!.state, "ok");
  engine.sweep(min(11));
  assert.equal(engine.state("svc")!.state, "stale");
  engine.sweep(min(61));
  assert.equal(engine.state("svc")!.state, "crit");
  engine.push("svc", { state: "ok" }, "Heartbeat", min(62));
  assert.equal(engine.state("svc")!.state, "ok");
});

test("webhook push opens and clears by key", () => {
  const { engine } = setup({ driver: "webhook", options: {} });
  engine.push("svc", { key: "disk", state: "warn", summary: "Disk 92%" }, "Webhook", min(1));
  engine.push("svc", { key: "svc", state: "crit", summary: "Service stopped" }, "Webhook", min(2));
  assert.equal(engine.state("svc")!.state, "crit");
  engine.push("svc", { key: "svc", state: "ok" }, "Webhook", min(3));
  assert.equal(engine.state("svc")!.state, "warn");
  engine.push("svc", { state: "ok", summary: "All clear" }, "Webhook", min(4));
  assert.equal(engine.state("svc")!.state, "ok");
  assert.equal(engine.state("svc")!.summary, "All clear");
});

test("snooze: orange while it lasts, re-arms when it expires", () => {
  const { engine } = setup();
  engine.observe("svc", { issues: [warn()] }, "test", min(1));
  engine.snooze("svc", 15, "brian", "on it", min(2));
  assert.equal(engine.state("svc")!.state, "ack");
  engine.sweep(min(10));
  assert.equal(engine.state("svc")!.state, "ack");
  engine.sweep(min(18));
  assert.equal(engine.state("svc")!.state, "warn");
  assert.equal(engine.state("svc")!.snooze, null);
});

test("snooze: re-arms early when it gets worse or a new issue appears", () => {
  const { engine } = setup();
  engine.observe("svc", { issues: [warn()] }, "test", min(1));
  engine.snooze("svc", 60, "brian", undefined, min(2));
  engine.observe("svc", { issues: [crit()] }, "test", min(3));
  assert.equal(engine.state("svc")!.state, "crit");

  engine.snooze("svc", 60, "brian", undefined, min(4));
  engine.observe("svc", { issues: [crit(), warn("inc:2", "Another")] }, "test", min(5));
  assert.equal(engine.state("svc")!.state, "crit", "new key cancels the snooze");
});

test("snooze clears itself when the issue clears", () => {
  const { engine } = setup({ release: 1 });
  engine.observe("svc", { issues: [warn()] }, "test", min(1));
  engine.snooze("svc", 60, "brian", undefined, min(2));
  engine.observe("svc", { issues: [] }, "test", min(3));
  const st = engine.state("svc")!;
  assert.equal(st.state, "ok");
  assert.equal(st.snooze, null);
});

test("park keeps tracking state but is flagged, and expires", () => {
  const { engine } = setup();
  engine.observe("svc", { issues: [crit()] }, "test", min(1));
  engine.park("svc", "AP flaps nightly", min(60), "brian", min(2));
  const st = engine.state("svc")!;
  assert.equal(st.state, "crit", "the real state is still recorded");
  assert.ok(st.parked);
  engine.sweep(min(61));
  assert.equal(engine.state("svc")!.parked, null);
});

test("false alarm closes, repaints history, and suppresses the key until the source drops it", () => {
  const { engine, db } = setup({ release: 1 });
  engine.observe("svc", { issues: [crit()] }, "test", min(1));
  engine.falseAlarm("svc", "brian", min(5));
  assert.equal(engine.state("svc")!.state, "ok");
  const spans = db.prepare("SELECT state FROM spans WHERE check_id = 'svc'").all() as { state: string }[];
  assert.deepEqual(spans.map(s => s.state), ["false"]);

  engine.observe("svc", { issues: [crit()] }, "test", min(6));
  assert.equal(engine.state("svc")!.state, "ok", "same key is still suppressed");
  engine.observe("svc", { issues: [] }, "test", min(7));
  engine.observe("svc", { issues: [crit()] }, "test", min(8));
  assert.equal(engine.state("svc")!.state, "crit", "once the source dropped it, a new report counts again");
});

test("spans record each non-OK stretch for the history strip", () => {
  const { engine, db } = setup({ release: 1 });
  engine.observe("svc", { issues: [warn()] }, "test", min(1));
  engine.observe("svc", { issues: [crit()] }, "test", min(2));
  engine.observe("svc", { issues: [] }, "test", min(4));
  const spans = db.prepare("SELECT state, start, end FROM spans ORDER BY start").all();
  assert.deepEqual(spans.map(s => ({ ...s })), [
    { state: "warn", start: min(1), end: min(2) },
    { state: "crit", start: min(2), end: min(4) },
  ]);
});

test("removing a repo connector disables it but keeps its history", () => {
  const { engine } = setup();
  engine.syncConnectors([], "repo");
  assert.equal(engine.checks()[0].enabled, 0);
});

test("missing credentials show NO SIGNAL straight away", () => {
  const { engine } = setup();
  engine.fail("svc", "waiting for credentials (front_api_token)", "test", min(1), { immediate: true });
  const st = engine.state("svc")!;
  assert.equal(st.state, "stale");
  assert.match(st.summary, /waiting for credentials/);
});

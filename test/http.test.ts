import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { boot } from "../src/app.ts";
import { createApp } from "../src/http/server.ts";
import { createUser } from "../src/access/identity.ts";
import type { SafeFetch } from "../src/connectors/fetch.ts";

// End to end over real HTTP: three people with different clearance, a board, a webhook, MCP.

const dir = mkdtempSync(join(tmpdir(), "imc-"));
writeFileSync(join(dir, "github.yaml"), `id: github\nname: GitHub\nsensitivity: public\nlink: https://www.githubstatus.com/\ndriver: statuspage\noptions: { url: "https://status.test/api/v2/summary.json" }\n`);
writeFileSync(join(dir, "jamf.yaml"), `id: jamf\nname: Jamf Pro\nsensitivity: viewer\ndriver: json\noptions:\n  url: https://jamf.test/healthCheck.html\n  headers: { Authorization: "Bearer \${secret:jamf_token}" }\n  rules: [{ path: "$.length", op: ">", value: 0, state: crit, summary: "Jamf unhealthy" }]\n`);
writeFileSync(join(dir, "payroll.yaml"), `id: payroll\nname: Payroll gateway\nsensitivity: secret\ngroups: [finance]\ndriver: http\noptions: { url: "https://payroll.test/health" }\n`);
writeFileSync(join(dir, "fs01.yaml"), `id: fs01\nname: FS01\nsensitivity: viewer\ndriver: webhook\n`);

const seen: { url: string; headers: Record<string, string> }[] = [];
const fakeFetch: SafeFetch = async (url, opts = {}) => {
  seen.push({ url, headers: opts.headers ?? {} });
  const body = url.includes("status.test")
    ? { status: { description: "Minor issue" }, components: [], incidents: [{ id: "i1", name: "Actions delayed", status: "investigating", impact: "minor" }] }
    : url.includes("jamf.test") ? [] : "OK";
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status: 200, ok: true, headers: new Headers(), ms: 5, text, json: () => JSON.parse(text) };
};

let server: Server, base = "";
const app = boot({ db: ":memory:", connectorsDir: dir, key: randomBytes(32), fetch: fakeFetch });

before(async () => {
  await createUser(app.db, { username: "admin", password: "admin-password-123", role: "instance_admin" });
  await createUser(app.db, { username: "tech", password: "tech-password-123", role: "technician" });
  await createUser(app.db, { username: "fin", password: "fin-password-1234", role: "viewer", clearance: "secret", groups: ["finance"] });
  server = createApp({ ...app, config: { uiFile: join(import.meta.dirname, "..", "prototype", "index.html"), publicUrl: "http://imc.test", secureCookies: false } });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  app.vault.set("jamf_token", "jamf-secret-xyz", "test");
  await app.runner.tick();
});
after(() => server.close());

async function call(path: string, opts: { method?: string; body?: unknown; cookie?: string; csrf?: boolean; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? "GET",
    headers: { "content-type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.csrf === false ? {} : { "x-imc-request": "1" }), ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const cookie = res.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  const ct = res.headers.get("content-type") ?? "";
  return { status: res.status, cookie, data: ct.includes("json") ? await res.json() : await res.text() };
}
const signIn = async (u: string, p: string) => (await call("/api/login", { method: "POST", body: { username: u, password: p } })).cookie;
const ids = (d: any) => d.checks.map((c: any) => c.id).sort();

test("anonymous gets nothing until the public board is switched on", async () => {
  assert.equal((await call("/api/checks")).status, 401);
});

test("each person sees exactly what their clearance and groups allow", async () => {
  assert.deepEqual(ids((await call("/api/checks", { cookie: await signIn("tech", "tech-password-123") })).data), ["fs01", "github", "jamf"]);
  assert.deepEqual(ids((await call("/api/checks", { cookie: await signIn("admin", "admin-password-123") })).data), ["fs01", "github", "jamf"], "admins don't see secret checks by default");
  assert.deepEqual(ids((await call("/api/checks", { cookie: await signIn("fin", "fin-password-1234") })).data), ["fs01", "github", "jamf", "payroll"]);
});

test("polls ran with credentials resolved server-side", async () => {
  const jamf = seen.find(s => s.url.includes("jamf.test"));
  assert.equal(jamf?.headers.Authorization, "Bearer jamf-secret-xyz");
  const { data } = await call("/api/checks", { cookie: await signIn("tech", "tech-password-123") });
  const gh = data.checks.find((c: any) => c.id === "github");
  assert.equal(gh.state, "warn");
  assert.equal(gh.msg, "Actions delayed");
  assert.equal(gh.src, "poll 1h");
  assert.equal(gh.via, "Statuspage API");
});

test("hidden checks are indistinguishable from missing ones", async () => {
  const tech = await signIn("tech", "tech-password-123");
  const hidden = await call("/api/checks/payroll/snooze", { method: "POST", cookie: tech, body: { minutes: 15 } });
  const missing = await call("/api/checks/nope/snooze", { method: "POST", cookie: tech, body: { minutes: 15 } });
  assert.equal(hidden.status, 404);
  assert.deepEqual(hidden.data, missing.data);
});

test("cookie-authenticated writes need the CSRF header", async () => {
  const tech = await signIn("tech", "tech-password-123");
  assert.equal((await call("/api/checks/github/snooze", { method: "POST", cookie: tech, csrf: false, body: { minutes: 15 } })).status, 403);
  assert.equal((await call("/api/checks/github/snooze", { method: "POST", cookie: tech, body: { minutes: 15, note: "watching" } })).status, 200);
  const gh = (await call("/api/checks", { cookie: tech })).data.checks.find((c: any) => c.id === "github");
  assert.equal(gh.state, "ack");
  assert.equal(gh.snooze.note, "watching");
});

test("technicians can't manage boards, credentials or users", async () => {
  const tech = await signIn("tech", "tech-password-123");
  assert.equal((await call("/api/boards/codes", { method: "POST", cookie: tech, body: { name: "x" } })).status, 403);
  assert.equal((await call("/api/secrets", { cookie: tech })).status, 403);
  assert.equal((await call("/api/users", { cookie: tech })).status, 403);
});

test("board pairing: single-use code, read-only guest view", async () => {
  const admin = await signIn("admin", "admin-password-123");
  const { data: code } = await call("/api/boards/codes", { method: "POST", cookie: admin, body: { name: "Lobby TV" } });
  assert.match(code.code, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
  const redeem = await call("/api/boards/redeem", { method: "POST", body: { code: code.code } });
  assert.equal(redeem.status, 200);
  assert.equal((await call("/api/boards/redeem", { method: "POST", body: { code: code.code } })).status, 400, "code is spent");
  const board = redeem.cookie;
  assert.deepEqual(ids((await call("/api/checks", { cookie: board })).data), ["github"], "guest clearance sees public checks only");
  assert.equal((await call("/api/checks/github/clear", { method: "POST", cookie: board })).status, 403, "boards can't operate");
  const session = (await call("/api/session", { cookie: board })).data;
  assert.equal(session.principal.kind, "board");

  const list = (await call("/api/boards", { cookie: admin })).data.boards;
  app.db.prepare("UPDATE boards SET expires_at = ?").run(Date.now() - 1);
  const expired = (await call("/api/session", { cookie: board })).data;
  assert.equal(expired.board_expired.name, "Lobby TV");
  assert.equal((await call(`/api/boards/${list[0].id}/reauthorize`, { method: "POST", cookie: admin })).status, 200);
  assert.equal((await call("/api/checks", { cookie: board })).status, 200, "back without re-pairing");
});

test("public board shows public checks to anyone", async () => {
  const admin = await signIn("admin", "admin-password-123");
  await call("/api/settings", { method: "PATCH", cookie: admin, body: { public_board: true } });
  assert.deepEqual(ids((await call("/api/checks")).data), ["github"]);
  await call("/api/settings", { method: "PATCH", cookie: admin, body: { public_board: false } });
});

test("credentials are write-only", async () => {
  const admin = await signIn("admin", "admin-password-123");
  assert.equal((await call("/api/secrets/front_api_token", { method: "PUT", cookie: admin, body: { value: "tok-123456" } })).status, 200);
  const list = await call("/api/secrets", { cookie: admin });
  assert.ok(!JSON.stringify(list.data).includes("tok-123456"));
  assert.ok(list.data.some((s: any) => s.name === "front_api_token" && s.set));
});

test("webhooks need the derived token", async () => {
  assert.equal((await call("/api/ingest/fs01", { method: "POST", body: { state: "warn" }, headers: { authorization: "Bearer wrong" } })).status, 404);
  const admin = await signIn("admin", "admin-password-123");
  const ep = (await call("/api/connectors/fs01/endpoints", { cookie: admin })).data;
  const r = await call("/api/ingest/fs01", { method: "POST", body: { key: "disk", state: "warn", summary: "Disk D: 92%" }, headers: { authorization: ep.authorization } });
  assert.equal(r.status, 200);
  const fs = (await call("/api/checks", { cookie: admin })).data.checks.find((c: any) => c.id === "fs01");
  assert.equal(fs.state, "warn");
  assert.equal(fs.msg, "Disk D: 92%");
});

test("MCP: an assistant can draft and test connectors but not read credentials or enable them", async () => {
  const admin = await signIn("admin", "admin-password-123");
  const { data: tok } = await call("/api/tokens", { method: "POST", cookie: admin, body: { name: "Claude", scopes: ["view", "manage_connectors"] } });
  const rpc = async (method: string, params: unknown, id = 1) => {
    const res = await fetch(base + "/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${tok.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    return res.json() as Promise<any>;
  };
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.result.serverInfo.name, "it-mission-control");
  const tools = (await rpc("tools/list", {})).result.tools.map((t: any) => t.name);
  assert.ok(tools.includes("save_connector_draft") && tools.includes("test_connector"));
  assert.ok(!tools.some((t: string) => /secret_value|reveal|get_credential/.test(t)));

  const yaml = `id: intranet\nname: Intranet\ndriver: http\noptions: { url: "https://intranet.test/health", headers: { X-Key: "\${secret:jamf_token}" } }\n`;
  const tested = JSON.parse((await rpc("tools/call", { name: "test_connector", arguments: { yaml } })).result.content[0].text);
  assert.equal(tested.ran, true);
  assert.equal(tested.state, "ok");
  assert.ok(!JSON.stringify(tested).includes("jamf-secret-xyz"));

  const saved = JSON.parse((await rpc("tools/call", { name: "save_connector_draft", arguments: { yaml } })).result.content[0].text);
  assert.equal(saved.saved, true);
  assert.equal(app.engine.checks().find(c => c.id === "intranet")?.enabled, 0, "drafts start disabled");

  const tooHigh = await rpc("tools/call", { name: "save_connector_draft", arguments: { yaml: yaml.replace("id: intranet", "id: vault-x\nsensitivity: secret") } });
  assert.equal(tooHigh.result.isError, true);

  const creds = JSON.parse((await rpc("tools/call", { name: "list_credentials", arguments: {} })).result.content[0].text);
  assert.ok(creds.every((c: any) => !("value" in c)));
  assert.equal((await call("/api/connectors/intranet/enable", { method: "POST", cookie: admin })).status, 200);
  assert.equal(app.engine.checks().find(c => c.id === "intranet")?.source, "custom", "a person enabling it promotes the draft");
});

test("the UI is served with a strict CSP", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.match(await res.text(), /^<!doctype html>/);
});

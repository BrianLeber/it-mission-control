import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ZodError } from "zod";
import { stringify as toYaml } from "yaml";
import { audit, type DB } from "../db/index.ts";
import { ANONYMOUS, LEVELS, PERMISSIONS, ROLES, can, canGrant, canSee, isLevel, isRole, type Permission, type Principal } from "../access/policy.ts";
import {
  AccessError, createApiToken, createPairCode, createUser, listApiTokens, listBoards, listUsers, login, logout,
  principalFromApiToken, principalFromBoard, principalFromSession, reauthorizeBoard, redeemPairCode, revokeApiToken,
  revokeBoard, setGroups, BOARD_TTL, SESSION_TTL,
} from "../access/identity.ts";
import { hashPassword, safeEqual } from "../access/crypto.ts";
import { DRIVERS } from "../connectors/drivers/index.ts";
import { parseConnectorYaml } from "../connectors/registry.ts";
import { UserError, type Engine, type EngineEvent } from "../engine/engine.ts";
import type { Runner } from "../engine/runner.ts";
import { visibleChecks } from "../engine/views.ts";
import { getIncident, incidentMarkdown, listIncidents, type IncidentStatus } from "../engine/incidents.ts";
import { buildMcpServer } from "../mcp/tools.ts";
import { secretRefs, type Vault } from "../secrets/vault.ts";
import { log } from "../util/log.ts";

export interface AppConfig {
  uiFile: string;
  publicUrl: string;     // used to print ping/webhook URLs
  secureCookies: boolean;
}

interface Ctx {
  req: IncomingMessage; res: ServerResponse; url: URL; ip: string;
  params: Record<string, string>; body: any; principal: Principal;
  boardExpired: { id: string; name: string } | null; viaCookie: boolean;
}
type Handler = (c: Ctx) => unknown | Promise<unknown>;

const SESSION_COOKIE = "imc_session", BOARD_COOKIE = "imc_board";

export function createApp(deps: { db: DB; engine: Engine; runner: Runner; vault: Vault; config: AppConfig }): Server {
  const { db, engine, runner, vault, config } = deps;
  const routes: { method: string; re: RegExp; keys: string[]; perm?: Permission; h: Handler }[] = [];
  const route = (method: string, path: string, h: Handler, perm?: Permission) => {
    const keys: string[] = [];
    const re = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
    routes.push({ method, re, keys, perm, h });
  };
  const setting = (k: string, d: string) => (db.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? d;
  const publicBoard = () => setting("public_board", "false") === "true";
  const visible = (p: Principal, id: string) => {
    const c = engine.connector(id);
    if (!c || !canSee(p, c)) throw new AccessError("Not found", 404); // hidden and missing look the same
    return c;
  };
  const actor = (p: Principal) => (p.kind === "user" ? p.name : `${p.kind}:${p.name}`);

  // ---------- session ----------
  route("GET", "/api/session", c => ({
    principal: c.principal.kind === "anonymous" ? null : {
      kind: c.principal.kind, name: c.principal.name, role: c.principal.role, clearance: c.principal.clearance,
      permissions: PERMISSIONS.filter(x => can(c.principal, x)),
    },
    board_expired: c.boardExpired,
    instance: { name: setting("instance_name", "Mission Control"), public_board: publicBoard() },
  }));
  route("POST", "/api/login", async c => {
    const { token, principal } = await login(db, String(c.body?.username ?? ""), String(c.body?.password ?? ""), c.ip);
    setCookie(c.res, SESSION_COOKIE, token, SESSION_TTL, config.secureCookies);
    return { name: principal.name, role: principal.role };
  });
  route("POST", "/api/logout", c => {
    const t = cookies(c.req)[SESSION_COOKIE]; if (t) logout(db, t);
    setCookie(c.res, SESSION_COOKIE, "", 0, config.secureCookies);
    return { ok: true };
  });

  // ---------- checks ----------
  route("GET", "/api/checks", c => {
    if (c.principal.kind === "anonymous" && !publicBoard()) throw new AccessError(c.boardExpired ? "Board access expired" : "Sign in required", 401);
    return { now: Date.now(), checks: visibleChecks(engine, c.principal, { includeSensitivity: can(c.principal, "manage_connectors") }) };
  }, "view");
  const op = (path: string, fn: (id: string, c: Ctx) => void) => route("POST", `/api/checks/:id/${path}`, c => {
    visible(c.principal, c.params.id); fn(c.params.id, c); return { ok: true };
  }, "operate");
  op("snooze", (id, c) => engine.snooze(id, Number(c.body?.minutes) || 60, actor(c.principal), c.body?.note ? String(c.body.note).slice(0, 200) : undefined));
  op("end-snooze", (id, c) => engine.endSnooze(id, actor(c.principal)));
  op("park", (id, c) => engine.park(id, String(c.body?.reason || "No reason given").slice(0, 300), c.body?.until ? Date.parse(c.body.until) || null : null, actor(c.principal)));
  op("unpark", (id, c) => engine.unpark(id, actor(c.principal)));
  op("false-alarm", (id, c) => engine.falseAlarm(id, actor(c.principal)));
  op("clear", (id, c) => engine.clear(id, actor(c.principal)));
  // "Check now": re-poll on the next tick (a few seconds) instead of waiting for the interval.
  route("POST", "/api/checks/:id/poll", async c => {
    const conn = visible(c.principal, c.params.id);
    if (!DRIVERS[conn.driver]?.poll) throw new UserError("This check is push-based; it updates when the source sends something.");
    await runner.runCheck(conn.id);
    return { ok: true, state: engine.state(conn.id)?.state };
  }, "operate");

  // ---------- incidents: records you can track, annotate, archive and export ----------
  const incident = (p: Principal, raw: string) => {
    const i = getIncident(engine, p, Number(raw));
    if (!i) throw new AccessError("Not found", 404);
    return i;
  };
  route("GET", "/api/incidents", c => {
    if (c.principal.kind === "anonymous" && !publicBoard()) throw new AccessError("Sign in required", 401);
    const s = c.url.searchParams.get("status");
    return { incidents: listIncidents(engine, c.principal, {
      status: (["open", "closed", "tracked", "archived", "ignored", "reported", "all"].includes(s ?? "") ? s : "all") as IncidentStatus,
      check: c.url.searchParams.get("check") ?? undefined, q: c.url.searchParams.get("q") ?? undefined,
      limit: Math.min(Number(c.url.searchParams.get("limit")) || 200, 1000),
    }) };
  }, "view");
  route("GET", "/api/incidents/:id", c => {
    if (c.principal.kind === "anonymous" && !publicBoard()) throw new AccessError("Sign in required", 401);
    return incident(c.principal, c.params.id);
  }, "view");
  route("GET", "/api/incidents/:id/export", c => {
    if (c.principal.kind === "anonymous" && !publicBoard()) throw new AccessError("Sign in required", 401);
    const i = incident(c.principal, c.params.id);
    c.res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="incident-${(i.ref ?? i.id).toString().replace(/[^\w-]/g, "")}.md"` });
    c.res.end(incidentMarkdown(i));
    return STREAMING;
  }, "view");
  route("POST", "/api/incidents/:id/track", c => { const i = incident(c.principal, c.params.id); engine.trackIssue(i.id, c.body?.on !== false, actor(c.principal)); return { ok: true }; }, "operate");
  route("POST", "/api/incidents/:id/archive", c => { const i = incident(c.principal, c.params.id); engine.archiveIssue(i.id, c.body?.on !== false, actor(c.principal)); return { ok: true }; }, "operate");
  route("POST", "/api/incidents/:id/resolve", c => { const i = incident(c.principal, c.params.id); engine.resolveIssue(i.id, actor(c.principal), c.body?.note ? String(c.body.note) : undefined); return { ok: true }; }, "operate");
  route("PUT", "/api/checks/:id/display", c => { const conn = visible(c.principal, c.params.id); engine.setSize(conn.id, String(c.body?.size ?? ""), actor(c.principal)); return { ok: true }; }, "operate");
  // A person's own report: confirmed problems the vendor hasn't posted, or our own systems.
  route("POST", "/api/checks/:id/report", c => {
    const conn = visible(c.principal, c.params.id), b = c.body ?? {};
    const id = engine.reportIssue(conn.id, { state: b.state, title: String(b.title ?? ""), detail: b.detail ? String(b.detail) : undefined, component: b.component ? String(b.component) : undefined, ref: b.ref ? String(b.ref) : undefined }, actor(c.principal));
    return { id };
  }, "operate");
  // Relevance is a standing decision about what we run, so it needs connector rights, not just operate.
  route("PUT", "/api/checks/:id/components/:name", c => {
    const conn = visible(c.principal, c.params.id);
    const rel = c.body?.relevance;
    if (rel !== "normal" && rel !== "ignore") throw new UserError('relevance must be "normal" or "ignore"');
    engine.setRelevance(conn.id, c.params.name, rel, actor(c.principal), c.body?.note ? String(c.body.note).slice(0, 200) : undefined);
    return { ok: true };
  }, "manage_connectors");
  route("POST", "/api/incidents/:id/notes", c => { const i = incident(c.principal, c.params.id); engine.addNote(i.id, String(c.body?.text ?? ""), actor(c.principal)); return { ok: true }; }, "operate");

  // ---------- push sources ----------
  const pushAuth = (purpose: "ping" | "webhook", id: string, token: string | undefined) => {
    const conn = engine.connector(id);
    const want = vault.derive(purpose, id);
    if (!conn || conn.driver !== (purpose === "ping" ? "heartbeat" : "webhook") || !token || !safeEqual(token, want)) throw new AccessError("Not found", 404);
  };
  for (const m of ["GET", "POST"]) {
    route(m, "/api/ping/:id/:token", c => { pushAuth("ping", c.params.id, c.params.token); engine.push(c.params.id, { state: "ok", summary: "Heartbeat on schedule" }, "Heartbeat"); return { ok: true }; });
    route(m, "/api/ping/:id/:token/fail", c => { pushAuth("ping", c.params.id, c.params.token); engine.push(c.params.id, { key: "fail", state: "crit", summary: String(c.body?.summary ?? "Job reported failure") }, "Heartbeat"); return { ok: true }; });
  }
  route("POST", "/api/ingest/:id", c => {
    pushAuth("webhook", c.params.id, bearer(c.req) ?? c.url.searchParams.get("token") ?? undefined);
    const b = c.body ?? {};
    if (!["ok", "warn", "crit", "maint", "stale"].includes(b.state)) throw new UserError('Body needs "state": ok | warn | crit | maint | stale');
    engine.push(c.params.id, { key: b.key ? String(b.key).slice(0, 120) : undefined, state: b.state, summary: b.summary ? String(b.summary).slice(0, 300) : undefined, url: typeof b.url === "string" ? b.url : undefined }, "Webhook");
    return { ok: true };
  });

  // ---------- boards ----------
  route("GET", "/api/boards", () => ({ boards: listBoards(db), ttl_days: BOARD_TTL / 86400e3 }), "manage_boards");
  route("POST", "/api/boards/codes", c => createPairCode(db, c.principal, String(c.body?.name ?? ""), isLevel(c.body?.clearance) ? c.body.clearance : "guest"), "manage_boards");
  route("POST", "/api/boards/:id/reauthorize", c => { reauthorizeBoard(db, c.principal, c.params.id); return { ok: true }; }, "manage_boards");
  route("DELETE", "/api/boards/:id", c => { revokeBoard(db, c.principal, c.params.id); return { ok: true }; }, "manage_boards");
  const redeemTries = new Map<string, { n: number; reset: number }>();
  route("POST", "/api/boards/redeem", c => {
    const t = redeemTries.get(c.ip);
    const now = Date.now();
    if (t && t.reset > now && t.n >= 20) throw new AccessError("Too many attempts from this screen. Wait 10 minutes.", 429);
    redeemTries.set(c.ip, t && t.reset > now ? { n: t.n + 1, reset: t.reset } : { n: 1, reset: now + 10 * 60e3 });
    const { token, board, issuer } = redeemPairCode(db, String(c.body?.code ?? ""));
    setCookie(c.res, BOARD_COOKIE, token, 400 * 86400e3, config.secureCookies); // server-side expiry rules; the cookie just carries the token
    broadcast({ kind: "board.paired", to: String(issuer), name: board.name });
    return { name: board.name, expires_at: board.expires_at };
  });

  // ---------- connectors ----------
  route("GET", "/api/drivers", () => Object.values(DRIVERS).map(d => ({ name: d.name, kind: d.kind, summary: d.summary, example: d.example })), "manage_connectors");
  route("GET", "/api/connectors", c => {
    const set = new Set(vault.list().filter(s => s.set).map(s => s.name));
    return engine.checks().filter(r => canSee(c.principal, r.connector)).map(r => ({
      id: r.id, source: r.source, enabled: !!r.enabled, state: engine.state(r.id)?.state, last_error: engine.state(r.id)?.last_error,
      missing_credentials: secretRefs(r.connector.options).filter(n => !set.has(n)), yaml: toYaml(r.connector),
    }));
  }, "manage_connectors");
  route("POST", "/api/connectors", c => {
    const r = parseConnectorYaml(String(c.body?.yaml ?? ""));
    if (!r.ok) throw new UserError(r.errors.join("\n"));
    if (!canSee(c.principal, r.connector)) throw new AccessError("You can't create a connector above your own clearance.");
    const prev = engine.checks().find(x => x.id === r.connector.id);
    if (prev?.source === "repo") throw new UserError(`"${r.connector.id}" comes from the repository; change it there or pick another id.`);
    engine.syncConnectors([r.connector], "custom");
    audit(db, actor(c.principal), prev ? "connector.update" : "connector.create", r.connector.id);
    return { id: r.connector.id };
  }, "manage_connectors");
  route("POST", "/api/connectors/:id/enable", c => setEnabled(c, true), "manage_connectors");
  route("POST", "/api/connectors/:id/disable", c => setEnabled(c, false), "manage_connectors");
  const setEnabled = (c: Ctx, on: boolean) => {
    const conn = visible(c.principal, c.params.id);
    // Enabling an AI draft promotes it to a custom connector: a person has now reviewed it.
    db.prepare("UPDATE checks SET enabled = ?, source = CASE WHEN source = 'draft' AND ? THEN 'custom' ELSE source END, updated_at = ? WHERE id = ?").run(on ? 1 : 0, on ? 1 : 0, Date.now(), conn.id);
    if (on) db.prepare("UPDATE check_state SET next_due = 0 WHERE check_id = ?").run(conn.id);
    audit(db, actor(c.principal), on ? "connector.enable" : "connector.disable", conn.id);
    engine.emit("event", { type: "updated", checkId: conn.id } satisfies EngineEvent);
    return { ok: true };
  };
  route("POST", "/api/connectors/test", async c => {
    const r = parseConnectorYaml(String(c.body?.yaml ?? ""));
    if (!r.ok) return { valid: false, errors: r.errors };
    return { valid: true, result: await runner.dryRun(r.connector) };
  }, "manage_connectors");
  route("GET", "/api/connectors/:id/endpoints", c => {
    const conn = visible(c.principal, c.params.id);
    const base = config.publicUrl.replace(/\/$/, "");
    if (conn.driver === "heartbeat") { const t = vault.derive("ping", conn.id); return { ping: `${base}/api/ping/${conn.id}/${t}`, fail: `${base}/api/ping/${conn.id}/${t}/fail` }; }
    if (conn.driver === "webhook") return { url: `${base}/api/ingest/${conn.id}`, authorization: `Bearer ${vault.derive("webhook", conn.id)}` };
    return {};
  }, "manage_connectors");

  // ---------- credentials (write-only) ----------
  route("GET", "/api/secrets", () => vault.list(), "manage_secrets");
  route("PUT", "/api/secrets/:name", c => {
    const v = c.body?.value;
    if (typeof v !== "string" || !v) throw new UserError("Send {\"value\": \"...\"}");
    vault.set(c.params.name, v, actor(c.principal));
    audit(db, actor(c.principal), "secret.set", c.params.name);
    for (const r of engine.checks()) if (secretRefs(r.connector.options).includes(c.params.name)) db.prepare("UPDATE check_state SET next_due = 0 WHERE check_id = ?").run(r.id);
    return { ok: true };
  }, "manage_secrets");
  route("DELETE", "/api/secrets/:name", c => { vault.delete(c.params.name); audit(db, actor(c.principal), "secret.delete", c.params.name); return { ok: true }; }, "manage_secrets");

  // ---------- users, tokens, settings ----------
  route("GET", "/api/users", () => ({ users: listUsers(db), roles: ROLES, levels: LEVELS }), "manage_users");
  route("POST", "/api/users", async c => {
    const b = c.body ?? {};
    if (!isRole(b.role) || !canGrant(c.principal, b.role, isLevel(b.clearance) ? b.clearance : c.principal.clearance)) throw new AccessError("You can't grant that role or clearance.");
    const id = await createUser(db, { username: String(b.username ?? ""), password: String(b.password ?? ""), role: b.role, clearance: isLevel(b.clearance) ? b.clearance : undefined, groups: Array.isArray(b.groups) ? b.groups.map(String) : [] });
    audit(db, actor(c.principal), "user.create", String(id), { role: b.role, clearance: b.clearance });
    return { id };
  }, "manage_users");
  route("PATCH", "/api/users/:id", async c => {
    const b = c.body ?? {}, id = Number(c.params.id);
    const u = db.prepare("SELECT role, clearance FROM users WHERE id = ?").get(id) as { role: string; clearance: string } | undefined;
    if (!u) throw new AccessError("Not found", 404);
    const role = isRole(b.role) ? b.role : u.role, clearance = isLevel(b.clearance) ? b.clearance : u.clearance;
    if (!isRole(role) || !isLevel(clearance) || !canGrant(c.principal, role, clearance)) throw new AccessError("You can't grant that role or clearance.");
    db.prepare("UPDATE users SET role = ?, clearance = ?, disabled = ? WHERE id = ?").run(role, clearance, b.disabled ? 1 : 0, id);
    if (Array.isArray(b.groups)) setGroups(db, id, b.groups.map(String));
    if (typeof b.password === "string") {
      if (b.password.length < 12) throw new UserError("Passwords need at least 12 characters");
      db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?").run(await hashPassword(b.password), id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    }
    if (b.disabled) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    audit(db, actor(c.principal), "user.update", String(id), { role, clearance, disabled: !!b.disabled, groups: b.groups });
    return { ok: true };
  }, "manage_users");
  route("GET", "/api/tokens", () => listApiTokens(db), "manage_tokens");
  route("POST", "/api/tokens", c => createApiToken(db, c.principal, String(c.body?.name ?? "Assistant"),
    Array.isArray(c.body?.scopes) ? c.body.scopes : ["view", "manage_connectors"], isLevel(c.body?.clearance) ? c.body.clearance : undefined), "manage_tokens");
  route("DELETE", "/api/tokens/:id", c => { revokeApiToken(db, c.principal, c.params.id); return { ok: true }; }, "manage_tokens");
  route("PATCH", "/api/settings", c => {
    for (const [k, v] of Object.entries(c.body ?? {})) {
      if (k === "public_board") db.prepare("INSERT INTO meta (key, value) VALUES ('public_board', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(v ? "true" : "false");
      if (k === "instance_name") db.prepare("INSERT INTO meta (key, value) VALUES ('instance_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(v).slice(0, 60));
    }
    audit(db, actor(c.principal), "settings.update", undefined, c.body);
    return { ok: true };
  }, "manage_instance");

  // ---------- live updates (SSE) ----------
  type Client = { res: ServerResponse; principal: Principal };
  const clients = new Set<Client>();
  route("GET", "/api/stream", c => {
    if (c.principal.kind === "anonymous" && !publicBoard()) throw new AccessError("Sign in required", 401);
    c.res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    c.res.write("retry: 5000\n\n");
    const client = { res: c.res, principal: c.principal };
    clients.add(client);
    const ka = setInterval(() => c.res.write(": keepalive\n\n"), 25_000);
    c.req.on("close", () => { clearInterval(ka); clients.delete(client); });
    return STREAMING;
  }, "view");
  type Broadcast = { kind: "board.paired"; to: string; name: string };
  function broadcast(m: Broadcast) {
    for (const cl of clients) if (cl.principal.kind === "user" && cl.principal.id === m.to) cl.res.write(`event: board.paired\ndata: ${JSON.stringify({ name: m.name })}\n\n`);
  }
  engine.on("event", (e: EngineEvent) => {
    const conn = engine.connector(e.checkId); if (!conn) return;
    for (const cl of clients) if (canSee(cl.principal, conn)) cl.res.write(`event: check\ndata: ${JSON.stringify({ id: e.checkId, type: e.type })}\n\n`);
  });

  // ---------- server ----------
  const uiHtml = () => wrapUi(readFileSync(config.uiFile, "utf8"), "live");

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    try {
      if (req.method === "GET" && ["/", "/board", "/pair"].includes(url.pathname)) {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        });
        return res.end(uiHtml());
      }
      if (url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (url.pathname === "/mcp") return await handleMcp(req, res);
      if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found" });

      const auth = resolvePrincipal(req);
      const match = routes.map(r => ({ r, m: r.method === req.method ? url.pathname.match(r.re) : null })).find(x => x.m);
      if (!match) return send(res, 404, { error: "Not found" });
      // Cookie-authenticated writes must carry a custom header, which browsers won't send cross-site without CORS.
      if (req.method !== "GET" && auth.viaCookie && req.headers["x-imc-request"] !== "1") return send(res, 403, { error: "Missing X-IMC-Request header" });
      if (match.r.perm && !can(auth.principal, match.r.perm)) {
        return send(res, auth.principal.kind === "anonymous" ? 401 : 403, { error: auth.boardExpired ? "Board access expired" : auth.principal.kind === "anonymous" ? "Sign in required" : "You don't have permission for that." , board_expired: auth.boardExpired });
      }
      const body = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method ?? "") ? await readJson(req) : undefined;
      const params = Object.fromEntries(match.r.keys.map((k, i) => [k, decodeURIComponent(match.m![i + 1])]));
      const ip = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
      const out = await match.r.h({ req, res, url, ip, params, body, ...auth });
      if (out !== STREAMING) send(res, 200, out);
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof AccessError) return send(res, e.status, { error: e.message });
      if (e instanceof UserError || e instanceof ZodError || e instanceof SyntaxError) return send(res, 400, { error: (e as Error).message });
      log("error", "request failed", { path: url.pathname, error: String((e as Error).stack ?? e) });
      send(res, 500, { error: "Something went wrong. The details are in the server log." });
    }
  });

  function resolvePrincipal(req: IncomingMessage): { principal: Principal; boardExpired: Ctx["boardExpired"]; viaCookie: boolean } {
    const b = bearer(req);
    if (b?.startsWith("imct_")) {
      const p = principalFromApiToken(db, b);
      if (p) return { principal: p, boardExpired: null, viaCookie: false };
    }
    const ck = cookies(req);
    if (ck[SESSION_COOKIE]) {
      const p = principalFromSession(db, ck[SESSION_COOKIE]);
      if (p) return { principal: p, boardExpired: null, viaCookie: true };
    }
    if (ck[BOARD_COOKIE]) {
      const r = principalFromBoard(db, ck[BOARD_COOKIE]);
      if (r && "principal" in r) return { principal: r.principal, boardExpired: null, viaCookie: true };
      if (r && "expired" in r) return { principal: ANONYMOUS, boardExpired: r.expired, viaCookie: true };
    }
    return { principal: ANONYMOUS, boardExpired: null, viaCookie: Object.keys(ck).length > 0 };
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    const b = bearer(req);
    const p = b?.startsWith("imct_") ? principalFromApiToken(db, b) : null;
    if (!p) return send(res, 401, { error: "Use an API token: Authorization: Bearer imct_..." });
    if (req.method !== "POST") return send(res, 405, { error: "Use POST (stateless MCP)" });
    const body = await readJson(req);
    const server = buildMcpServer({ engine, runner, vault, principal: p });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}

const STREAMING = Symbol("streaming");

/** The prototype file is a page fragment (artifact format); this makes it a full document in a given mode. */
export function wrapUi(fragment: string, mode: "live" | "public"): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<script>window.IMC_MODE = ${JSON.stringify(mode)};</script>
${fragment}
</html>`;
}

function send(res: ServerResponse, status: number, data: unknown) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data ?? null));
}

async function readJson(req: IncomingMessage, max = 1_000_000): Promise<any> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const ch of req) { n += (ch as Buffer).length; if (n > max) throw new UserError("Request body too large"); chunks.push(ch as Buffer); }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new UserError("Body must be JSON"); }
}

function cookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries((req.headers.cookie ?? "").split(";").map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf("="); return [s.slice(0, i), decodeURIComponent(s.slice(i + 1))];
  }));
}
function setCookie(res: ServerResponse, name: string, value: string, maxAgeMs: number, secure: boolean) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (secure) parts.push("Secure");
  const prev = res.getHeader("set-cookie");
  res.setHeader("set-cookie", [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), parts.join("; ")]);
}
function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}

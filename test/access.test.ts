import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ANONYMOUS, can, canGrant, canSee, type Principal } from "../src/access/policy.ts";
import {
  createApiToken, createPairCode, createUser, login, principalFromApiToken, principalFromBoard, principalFromSession,
  reauthorizeBoard, redeemPairCode, revokeBoard, listBoards, AccessError,
} from "../src/access/identity.ts";
import { openDb } from "../src/db/index.ts";
import { Vault, MissingSecretError } from "../src/secrets/vault.ts";
import { redact } from "../src/connectors/fetch.ts";

const P = (role: Principal["role"], clearance: Principal["clearance"], groups: string[] = [], kind: Principal["kind"] = "user"): Principal =>
  ({ kind, id: "1", name: "t", role, clearance, groups });

test("roles: what each can do", () => {
  assert.ok(can(P("technician", "viewer"), "operate"));
  assert.ok(!can(P("technician", "viewer"), "manage_connectors"));
  assert.ok(can(P("dashboard_admin", "sensitive"), "manage_connectors"));
  assert.ok(can(P("dashboard_admin", "sensitive"), "manage_secrets"));
  assert.ok(!can(P("dashboard_admin", "sensitive"), "manage_users"), "dashboard admins can't add or remove users");
  assert.ok(can(P("instance_admin", "sensitive"), "manage_users"));
  assert.ok(!can(P("instance_admin", "sensitive"), "manage_instances"));
  assert.ok(can(P("global_admin", "secret"), "manage_instances"));
  assert.ok(!can(P("instance_admin", "secret", [], "board"), "operate"), "boards are always read-only");
  assert.ok(!can(ANONYMOUS, "operate"));
});

test("clearance and groups decide what exists for you", () => {
  const pub = { sensitivity: "public" as const }, sens = { sensitivity: "sensitive" as const };
  const finance = { sensitivity: "secret" as const, groups: ["finance"] };
  assert.ok(canSee(ANONYMOUS, pub));
  assert.ok(!canSee(ANONYMOUS, { sensitivity: "guest" }));
  assert.ok(!canSee(P("viewer", "viewer"), sens));
  assert.ok(canSee(P("viewer", "sensitive"), sens));
  assert.ok(!canSee(P("instance_admin", "sensitive", ["finance"]), finance), "secret needs secret clearance");
  assert.ok(!canSee(P("instance_admin", "secret"), finance), "and the group");
  assert.ok(canSee(P("viewer", "secret", ["finance"]), finance));
});

test("nobody grants more than they hold", () => {
  const ia = P("instance_admin", "sensitive");
  assert.ok(canGrant(ia, "technician", "viewer"));
  assert.ok(!canGrant(ia, "technician", "secret"));
  assert.ok(!canGrant(ia, "global_admin", "viewer"));
  assert.ok(!canGrant(P("dashboard_admin", "sensitive"), "viewer", "viewer"));
});

async function withAdmin() {
  const db = openDb(":memory:");
  const id = await createUser(db, { username: "brian", password: "correct horse battery", role: "instance_admin" });
  const admin: Principal = { kind: "user", id: String(id), name: "brian", role: "instance_admin", clearance: "sensitive", groups: [] };
  return { db, admin };
}

test("login: sessions, wrong passwords and throttling", async () => {
  const { db } = await withAdmin();
  await assert.rejects(login(db, "brian", "nope nope nope", "1.2.3.4"), /Wrong username or password/);
  const { token } = await login(db, "BRIAN", "correct horse battery", "1.2.3.4");
  assert.equal(principalFromSession(db, token)?.name, "brian");
  assert.equal(principalFromSession(db, token + "x"), null);
  for (let i = 0; i < 8; i++) await login(db, "brian", "wrong password!", "9.9.9.9").catch(() => {});
  await assert.rejects(login(db, "brian", "correct horse battery", "9.9.9.9"), /Too many attempts/);
});

test("pairing: a code works once, boards last 30 days and can be reauthorized", async () => {
  const { db, admin } = await withAdmin();
  const { code, clearance } = createPairCode(db, admin, "Lobby TV", "secret");
  assert.equal(clearance, "sensitive", "boards are capped below secret");
  const first = redeemPairCode(db, code.toLowerCase());
  assert.throws(() => redeemPairCode(db, code), /doesn't match/, "second use fails");
  const auth = principalFromBoard(db, first.token);
  assert.ok(auth && "principal" in auth && auth.principal.kind === "board");

  db.prepare("UPDATE boards SET expires_at = ?").run(Date.now() - 1000);
  const expired = principalFromBoard(db, first.token);
  assert.ok(expired && "expired" in expired && expired.expired.name === "Lobby TV");
  assert.equal(listBoards(db)[0].status, "expired");
  reauthorizeBoard(db, admin, first.board.id);
  assert.equal(listBoards(db)[0].status, "active");
  assert.ok("principal" in principalFromBoard(db, first.token)!, "same token works again, no re-pairing");

  revokeBoard(db, admin, first.board.id);
  assert.equal(principalFromBoard(db, first.token), null);
});

test("pairing: expired codes and non-admins are refused", async () => {
  const { db, admin } = await withAdmin();
  const { code } = createPairCode(db, admin, "Old");
  db.prepare("UPDATE pair_codes SET expires_at = ?").run(Date.now() - 1);
  assert.throws(() => redeemPairCode(db, code), /expired/);
  assert.throws(() => createPairCode(db, P("technician", "viewer"), "x"), AccessError);
});

test("api tokens: scoped, capped by issuer, revocable", async () => {
  const { db, admin } = await withAdmin();
  const t = createApiToken(db, admin, "Claude", ["view", "manage_connectors"], "secret");
  assert.equal(t.clearance, "sensitive", "can't exceed the issuer");
  const p = principalFromApiToken(db, t.token)!;
  assert.ok(can(p, "manage_connectors"));
  assert.ok(!can(p, "manage_users"), "scopes narrow the role");
  db.prepare("UPDATE users SET clearance = 'viewer'").run();
  assert.equal(principalFromApiToken(db, t.token)!.clearance, "viewer", "issuer losing clearance shrinks the token");
  assert.throws(() => createApiToken(db, P("technician", "viewer"), "x", ["view"]), AccessError);
});

test("vault: encrypted at rest, write-only, resolves references", () => {
  const db = openDb(":memory:");
  const v = new Vault(db, randomBytes(32));
  v.set("front_api_token", "s3cr3t-value", "brian");
  const raw = JSON.stringify(db.prepare("SELECT * FROM secrets").all());
  assert.ok(!raw.includes("s3cr3t-value"), "no plaintext in the database");
  assert.deepEqual(v.list().map(s => [s.name, s.set]), [["front_api_token", true]]);
  const { value, used } = v.resolve({ headers: { Authorization: "Bearer ${secret:front_api_token}" } });
  assert.equal(value.headers.Authorization, "Bearer s3cr3t-value");
  assert.equal(redact("failed for s3cr3t-value", used), "failed for •••");
  v.request("m365_client_secret", "From Entra app registration", "mcp");
  assert.throws(() => v.resolve("${secret:m365_client_secret}"), MissingSecretError);
  const other = new Vault(db, randomBytes(32));
  assert.throws(() => other.reveal("front_api_token"), "a different key can't decrypt");
});

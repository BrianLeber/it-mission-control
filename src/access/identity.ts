import { tx, audit, type DB } from "../db/index.ts";
import { hashPassword, newToken, normalizeCode, pairCode, sha256, verifyPassword } from "./crypto.ts";
import {
  BOARD_MAX_CLEARANCE, DEFAULT_CLEARANCE, PERMISSIONS, can, isLevel, isRole, levelIndex, minLevel,
  type Level, type Permission, type Principal, type Role,
} from "./policy.ts";

// Users, sessions, boards and API tokens. Every bearer secret is stored hashed.

export const SESSION_TTL = 7 * 86400e3;
export const BOARD_TTL = 30 * 86400e3;
export const BOARD_EXPIRY_WARN = 7 * 86400e3;
export const PAIR_CODE_TTL = 10 * 60e3;

export class AccessError extends Error { status: number; constructor(msg: string, status = 403) { super(msg); this.status = status; } }

interface UserRow { id: number; username: string; pass_hash: string; role: Role; clearance: Level; disabled: number }

function groupsOf(db: DB, userId: number): string[] {
  return (db.prepare("SELECT g.name FROM groups g JOIN user_groups ug ON ug.group_id = g.id WHERE ug.user_id = ?").all(userId) as { name: string }[]).map(r => r.name);
}
function userPrincipal(db: DB, u: UserRow): Principal {
  return { kind: "user", id: String(u.id), name: u.username, role: u.role, clearance: u.clearance, groups: groupsOf(db, u.id) };
}

// ---------- users ----------

export async function createUser(db: DB, input: { username: string; password: string; role: Role; clearance?: Level; groups?: string[] }) {
  if (!/^[A-Za-z0-9._@-]{2,64}$/.test(input.username)) throw new AccessError("Usernames use letters, digits and . _ @ - (2-64 characters)", 400);
  if (input.password.length < 12) throw new AccessError("Passwords need at least 12 characters", 400);
  if (!isRole(input.role)) throw new AccessError("Unknown role", 400);
  const clearance = input.clearance ?? DEFAULT_CLEARANCE[input.role];
  if (!isLevel(clearance)) throw new AccessError("Unknown clearance level", 400);
  const hash = await hashPassword(input.password);
  return tx(db, () => {
    const r = db.prepare("INSERT INTO users (username, pass_hash, role, clearance, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.username, hash, input.role, clearance, Date.now());
    const id = Number(r.lastInsertRowid);
    setGroups(db, id, input.groups ?? []);
    return id;
  });
}

export function setGroups(db: DB, userId: number, groups: string[]) {
  db.prepare("DELETE FROM user_groups WHERE user_id = ?").run(userId);
  for (const g of groups) {
    db.prepare("INSERT OR IGNORE INTO groups (name) VALUES (?)").run(g);
    const gid = (db.prepare("SELECT id FROM groups WHERE name = ?").get(g) as { id: number }).id;
    db.prepare("INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)").run(userId, gid);
  }
}

export function listUsers(db: DB) {
  return (db.prepare("SELECT id, username, role, clearance, disabled, created_at FROM users ORDER BY username").all() as unknown as (Omit<UserRow, "pass_hash"> & { created_at: number })[])
    .map(u => ({ ...u, disabled: !!u.disabled, groups: groupsOf(db, u.id) }));
}

export function userCount(db: DB): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

// Failed logins are throttled per username+address; the error never says which part was wrong.
const attempts = new Map<string, { n: number; until: number }>();
export async function login(db: DB, username: string, password: string, ip: string): Promise<{ token: string; principal: Principal }> {
  const k = `${username.toLowerCase()}|${ip}`;
  const a = attempts.get(k);
  if (a && a.n >= 8 && a.until > Date.now()) throw new AccessError("Too many attempts. Try again in 15 minutes.", 429);
  const u = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
  const ok = u && !u.disabled && await verifyPassword(password, u.pass_hash);
  if (!ok || !u) {
    attempts.set(k, { n: (a?.until ?? 0) > Date.now() ? a!.n + 1 : 1, until: Date.now() + 15 * 60e3 });
    throw new AccessError("Wrong username or password.", 401);
  }
  attempts.delete(k);
  const token = newToken();
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha256(token), u.id, Date.now(), Date.now() + SESSION_TTL);
  audit(db, u.username, "login");
  return { token, principal: userPrincipal(db, u) };
}

export function logout(db: DB, token: string) { db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token)); }

export function principalFromSession(db: DB, token: string): Principal | null {
  const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`)
    .get(sha256(token), Date.now()) as UserRow | undefined;
  return row ? userPrincipal(db, row) : null;
}

// ---------- boards ----------

export interface BoardRow { id: string; name: string; clearance: Level; created_by: number | null; paired_at: number; expires_at: number; last_seen: number | null; revoked_at: number | null }

/** One code, one board, ten minutes. Clearance is capped by the issuer's and by the board maximum. */
export function createPairCode(db: DB, by: Principal, name: string, clearance: Level = "guest") {
  if (!can(by, "manage_boards") || by.kind !== "user") throw new AccessError("You can't add boards.");
  if (!name.trim()) throw new AccessError("Give the board a name", 400);
  const level = minLevel(minLevel(clearance, by.clearance), BOARD_MAX_CLEARANCE);
  const code = pairCode();
  db.prepare("INSERT INTO pair_codes (code_hash, name, clearance, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(sha256(normalizeCode(code)), name.trim().slice(0, 60), level, Number(by.id), Date.now(), Date.now() + PAIR_CODE_TTL);
  audit(db, by.name, "board.code", name, { clearance: level });
  return { code, expires_at: Date.now() + PAIR_CODE_TTL, clearance: level };
}

/** Atomically spends a code. A second redeem of the same code always fails. */
export function redeemPairCode(db: DB, code: string): { token: string; board: BoardRow; issuer: number } {
  return tx(db, () => {
    const h = sha256(normalizeCode(code));
    const row = db.prepare("SELECT * FROM pair_codes WHERE code_hash = ?").get(h) as
      { name: string; clearance: Level; created_by: number; expires_at: number; used_at: number | null } | undefined;
    if (!row || row.used_at) throw new AccessError("That code doesn't match. Check it and try again.", 400);
    if (row.expires_at < Date.now()) throw new AccessError("That code has expired. Ask for a new one.", 400);
    const id = newToken().slice(0, 12), token = newToken("imcb_"), now = Date.now();
    db.prepare("INSERT INTO boards (id, name, token_hash, clearance, created_by, paired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, row.name, sha256(token), row.clearance, row.created_by, now, now + BOARD_TTL);
    db.prepare("UPDATE pair_codes SET used_at = ?, board_id = ? WHERE code_hash = ?").run(now, id, h);
    audit(db, `board:${row.name}`, "board.paired", id);
    return { token, board: db.prepare("SELECT * FROM boards WHERE id = ?").get(id) as unknown as BoardRow, issuer: row.created_by };
  });
}

export type BoardAuth = { principal: Principal } | { expired: { id: string; name: string } } | null;

export function principalFromBoard(db: DB, token: string): BoardAuth {
  const b = db.prepare("SELECT * FROM boards WHERE token_hash = ? AND revoked_at IS NULL").get(sha256(token)) as BoardRow | undefined;
  if (!b) return null;
  if (b.expires_at < Date.now()) return { expired: { id: b.id, name: b.name } };
  db.prepare("UPDATE boards SET last_seen = ? WHERE id = ?").run(Date.now(), b.id);
  return { principal: { kind: "board", id: b.id, name: b.name, role: "guest", clearance: b.clearance, groups: [] } };
}

export function listBoards(db: DB) {
  const now = Date.now();
  return (db.prepare("SELECT id, name, clearance, paired_at, expires_at, last_seen FROM boards WHERE revoked_at IS NULL ORDER BY name").all() as unknown as BoardRow[])
    .map(b => ({ ...b, status: b.expires_at <= now ? "expired" : b.expires_at - now <= BOARD_EXPIRY_WARN ? "expiring" : "active" }));
}

/** Extends a board (even an expired one) without re-pairing; the screen picks it up on its next request. */
export function reauthorizeBoard(db: DB, by: Principal, id: string) {
  if (!can(by, "manage_boards")) throw new AccessError("You can't manage boards.");
  const r = db.prepare("UPDATE boards SET expires_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now() + BOARD_TTL, id);
  if (!r.changes) throw new AccessError("Board not found", 404);
  audit(db, by.name, "board.reauthorize", id);
}
export function revokeBoard(db: DB, by: Principal, id: string) {
  if (!can(by, "manage_boards")) throw new AccessError("You can't manage boards.");
  const r = db.prepare("UPDATE boards SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now(), id);
  if (!r.changes) throw new AccessError("Board not found", 404);
  audit(db, by.name, "board.revoke", id);
}

// ---------- API tokens (MCP clients, automation) ----------

export function createApiToken(db: DB, by: Principal, name: string, scopes: Permission[], clearance?: Level) {
  if (!can(by, "manage_tokens") || by.kind !== "user") throw new AccessError("You can't create tokens.");
  const bad = scopes.filter(s => !PERMISSIONS.includes(s) || !can(by, s));
  if (bad.length) throw new AccessError(`You can't grant: ${bad.join(", ")}`);
  const level = clearance && levelIndex(clearance) <= levelIndex(by.clearance) ? clearance : by.clearance;
  const id = newToken().slice(0, 12), token = newToken("imct_");
  db.prepare("INSERT INTO api_tokens (id, name, token_hash, scopes, clearance, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, name.slice(0, 60), sha256(token), JSON.stringify(scopes), level, Number(by.id), Date.now());
  audit(db, by.name, "token.create", id, { scopes, clearance: level });
  return { id, token, scopes, clearance: level };
}

export function principalFromApiToken(db: DB, token: string): Principal | null {
  const t = db.prepare(`SELECT t.id, t.name, t.scopes, t.clearance, u.role, u.clearance AS ucl, u.disabled, u.id AS uid FROM api_tokens t
    JOIN users u ON u.id = t.created_by WHERE t.token_hash = ? AND t.revoked_at IS NULL`).get(sha256(token)) as
    { id: string; name: string; scopes: string; clearance: Level; ucl: Level; role: Role; disabled: number; uid: number } | undefined;
  if (!t || t.disabled) return null;
  db.prepare("UPDATE api_tokens SET last_used = ? WHERE id = ?").run(Date.now(), t.id);
  // A token can never exceed the person who issued it, even if their role later shrinks.
  return { kind: "token", id: t.id, name: t.name, role: t.role, clearance: minLevel(t.clearance, t.ucl), groups: groupsOf(db, t.uid), scopes: JSON.parse(t.scopes) };
}

export function listApiTokens(db: DB) {
  return db.prepare("SELECT id, name, scopes, clearance, created_at, last_used FROM api_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC").all()
    .map(r => ({ ...(r as Record<string, unknown>), scopes: JSON.parse((r as { scopes: string }).scopes) }));
}
export function revokeApiToken(db: DB, by: Principal, id: string) {
  if (!can(by, "manage_tokens")) throw new AccessError("You can't manage tokens.");
  db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ?").run(Date.now(), id);
  audit(db, by.name, "token.revoke", id);
}

import { randomBytes } from "node:crypto";
import { audit, type DB } from "../db/index.ts";
import { PRIVATE_LEVELS, canSee, inBoard, type Principal } from "../access/policy.ts";
import type { Engine } from "./engine.ts";
import { UserError } from "./engine.ts";

// A board is a named view: which groups and services it shows. People switch between
// boards; "Share board" pairs a screen to the one you're looking at.

export interface BoardView { id: string; name: string; groups: string[]; checks: string[]; created_by: string | null; created_at: number }

const row = (r: Record<string, unknown>): BoardView => ({ ...(r as unknown as BoardView), groups: JSON.parse(r.groups as string), checks: JSON.parse(r.checks as string) });

export function listViews(db: DB): BoardView[] {
  return db.prepare("SELECT * FROM board_views ORDER BY created_at").all().map(r => row(r as Record<string, unknown>));
}
export function getView(db: DB, id: string): BoardView | undefined {
  const r = db.prepare("SELECT * FROM board_views WHERE id = ?").get(id);
  return r ? row(r as Record<string, unknown>) : undefined;
}
/** Every instance starts with one board showing everything. */
export function ensureDefaultView(db: DB) {
  if ((db.prepare("SELECT COUNT(*) AS n FROM board_views").get() as { n: number }).n) return;
  db.prepare("INSERT INTO board_views (id, name, created_at) VALUES ('it', 'IT board', ?)").run(Date.now());
}
export function saveView(db: DB, by: Principal, input: { id?: string; name: string; groups?: string[]; checks?: string[] }): BoardView {
  const name = input.name?.trim().slice(0, 60);
  if (!name) throw new UserError("Name the board, e.g. IT board or IR board");
  const groups = (input.groups ?? []).map(String).slice(0, 50), checks = (input.checks ?? []).map(String).slice(0, 500);
  const id = input.id ?? randomBytes(6).toString("base64url");
  if (input.id && !getView(db, input.id)) throw new UserError("No such board");
  db.prepare(`INSERT INTO board_views (id, name, groups, checks, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, groups = excluded.groups, checks = excluded.checks`)
    .run(id, name, JSON.stringify(groups), JSON.stringify(checks), by.name, Date.now());
  audit(db, by.name, input.id ? "view.update" : "view.create", id, { name, groups, checks });
  return getView(db, id)!;
}
export function deleteView(db: DB, by: Principal, id: string) {
  if ((db.prepare("SELECT COUNT(*) AS n FROM boards WHERE view_id = ? AND revoked_at IS NULL").get(id) as { n: number }).n)
    throw new UserError("Screens still show this board. Revoke them first.");
  db.prepare("DELETE FROM board_views WHERE id = ?").run(id);
  audit(db, by.name, "view.delete", id);
}

/** Private (sensitive or secret) services on a board. Any of them means it can't be shared. */
export function privateChecks(engine: Engine, v: BoardView) {
  return engine.checks().filter(r => r.enabled && inBoard(v, r.connector) && PRIVATE_LEVELS.includes(r.connector.sensitivity)).map(r => r.connector);
}
/** Board list for a person: shareability, and the blocking services named only if they can see them. */
export function viewsFor(engine: Engine, p: Principal) {
  return listViews(engine.db).map(v => {
    const priv = privateChecks(engine, v);
    const named = priv.filter(c => canSee(p, c)).map(c => c.name);
    return { ...v, shareable: priv.length === 0, blocked_by: priv.length ? (named.length ? named : ["a service you can't see"]) : [] };
  });
}

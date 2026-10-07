// Access control is two separate axes:
//   role      = what you can DO (operate alerts, manage connectors, manage users...)
//   clearance = what you can SEE (sensitivity levels), narrowed further by groups.
// Visibility is enforced where data is read (API, SSE, MCP, digest), never in the UI alone,
// so a check above your clearance doesn't exist for you: no card, no count, no LED, no 404 hint.

export const ROLES = ["global_admin", "instance_admin", "dashboard_admin", "technician", "viewer", "guest"] as const;
export type Role = (typeof ROLES)[number];

export const LEVELS = ["public", "guest", "viewer", "sensitive", "secret"] as const;
export type Level = (typeof LEVELS)[number];

export const PERMISSIONS = [
  "view",               // see checks within clearance
  "operate",            // snooze, park, false alarm, clear
  "manage_connectors",  // add, edit, enable connectors; approve AI drafts
  "manage_secrets",     // write credentials (never read them back)
  "manage_boards",      // issue pairing codes, reauthorize, revoke boards
  "manage_tokens",      // issue API/MCP tokens
  "manage_users",       // add/remove users, set roles, clearance and groups
  "manage_instance",    // instance settings (public board, retention...)
  "manage_instances",   // hosted multi-instance operations (reserved)
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = [...PERMISSIONS];
const ROLE_PERMS: Record<Role, readonly Permission[]> = {
  global_admin: ALL,
  instance_admin: ALL.filter(p => p !== "manage_instances"),
  dashboard_admin: ["view", "operate", "manage_connectors", "manage_secrets", "manage_boards", "manage_tokens"],
  technician: ["view", "operate"],
  viewer: ["view"],
  guest: ["view"],
};

/** Clearance a new account gets unless an admin sets another. Secret is never a default. */
export const DEFAULT_CLEARANCE: Record<Role, Level> = {
  global_admin: "sensitive",
  instance_admin: "sensitive",
  dashboard_admin: "sensitive",
  technician: "viewer",
  viewer: "viewer",
  guest: "guest",
};

/** Boards are unattended screens; they can never be cleared for secret checks. */
export const BOARD_MAX_CLEARANCE: Level = "sensitive";

export interface Principal {
  kind: "user" | "board" | "token" | "anonymous";
  id: string;
  name: string;
  role: Role;
  clearance: Level;
  groups: string[];
  /** API tokens are limited to these permissions on top of the role. */
  scopes?: Permission[];
}

export interface Classified {
  sensitivity: Level;
  /** Selective access: when non-empty, the viewer must belong to at least one of these groups. */
  groups?: string[];
}

export const ANONYMOUS: Principal = { kind: "anonymous", id: "anonymous", name: "Anonymous", role: "guest", clearance: "public", groups: [] };

export const levelIndex = (l: Level) => LEVELS.indexOf(l);
export const isRole = (x: unknown): x is Role => ROLES.includes(x as Role);
export const isLevel = (x: unknown): x is Level => LEVELS.includes(x as Level);

export function can(p: Principal, perm: Permission): boolean {
  if (p.kind === "anonymous") return perm === "view";
  if (p.kind === "board") return perm === "view";
  if (!ROLE_PERMS[p.role].includes(perm)) return false;
  return p.scopes ? p.scopes.includes(perm) : true;
}

export function canSee(p: Principal, item: Classified): boolean {
  if (levelIndex(p.clearance) < levelIndex(item.sensitivity)) return false;
  const g = item.groups ?? [];
  return g.length === 0 || g.some(x => p.groups.includes(x));
}

/** Nobody can hand out more than they hold: role rank and clearance are both capped by the actor's. */
export function canGrant(actor: Principal, role: Role, clearance: Level): boolean {
  if (!can(actor, "manage_users")) return false;
  if (ROLES.indexOf(role) < ROLES.indexOf(actor.role)) return false;
  return levelIndex(clearance) <= levelIndex(actor.clearance);
}

/** Pick the lower of two clearances, e.g. a board can't see more than the admin who paired it. */
export const minLevel = (a: Level, b: Level): Level => (levelIndex(a) <= levelIndex(b) ? a : b);

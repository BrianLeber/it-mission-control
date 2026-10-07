import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = DatabaseSync;

// Append-only list. Each entry runs once, in order, inside a transaction.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  -- Connector definitions. Repo connectors are re-synced from YAML on boot;
  -- custom ones (UI or MCP drafts) live only here.
  CREATE TABLE checks (
    id TEXT PRIMARY KEY,
    def TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('repo','custom','draft')),
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE check_state (
    check_id TEXT PRIMARY KEY REFERENCES checks(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'ok',
    since INTEGER NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    last_ok_at INTEGER,          -- last successful observation from the source
    last_error TEXT,
    fail_count INTEGER NOT NULL DEFAULT 0,
    next_due INTEGER NOT NULL DEFAULT 0,
    snooze TEXT,
    parked TEXT,
    suppressed TEXT NOT NULL DEFAULT '[]',   -- issue keys closed as false alarms, ignored until the source drops them
    monitored_from INTEGER NOT NULL
  );

  CREATE TABLE issues (
    id INTEGER PRIMARY KEY,
    check_id TEXT NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    state TEXT NOT NULL,
    worst TEXT NOT NULL,
    summary TEXT NOT NULL,
    url TEXT,
    opened_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    missing_count INTEGER NOT NULL DEFAULT 0,
    closed_at INTEGER,
    close_reason TEXT          -- cleared | false_alarm | manual
  );
  CREATE INDEX issues_open ON issues(check_id, closed_at);

  -- Non-OK periods of the derived check state; gaps are OK. Drives the history strip.
  CREATE TABLE spans (
    id INTEGER PRIMARY KEY,
    check_id TEXT NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    start INTEGER NOT NULL,
    end INTEGER
  );
  CREATE INDEX spans_check ON spans(check_id, start);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    check_id TEXT NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    t INTEGER NOT NULL,
    state TEXT NOT NULL,
    message TEXT NOT NULL,
    origin TEXT NOT NULL
  );
  CREATE INDEX events_check ON events(check_id, t);

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    clearance TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
  CREATE TABLE user_groups (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, group_id)
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE pair_codes (
    code_hash TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    clearance TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    board_id TEXT
  );
  CREATE TABLE boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    clearance TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    paired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen INTEGER,
    revoked_at INTEGER
  );

  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL,
    clearance TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    last_used INTEGER,
    revoked_at INTEGER
  );

  CREATE TABLE secrets (
    name TEXT PRIMARY KEY,
    ciphertext TEXT,           -- NULL means requested but not yet provided
    description TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  );

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY,
    t INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT
  );
  `,
  `
  -- Incidents as records: vendor reference, timeline, tracking and archiving.
  ALTER TABLE issues ADD COLUMN ref TEXT;
  ALTER TABLE issues ADD COLUMN detail TEXT;
  ALTER TABLE issues ADD COLUMN started_at INTEGER;   -- when the vendor says it began (we may notice later)
  ALTER TABLE issues ADD COLUMN tracked_by TEXT;
  ALTER TABLE issues ADD COLUMN tracked_at INTEGER;
  ALTER TABLE issues ADD COLUMN archived_by TEXT;
  ALTER TABLE issues ADD COLUMN archived_at INTEGER;
  CREATE INDEX issues_ref ON issues(ref);
  CREATE INDEX issues_closed ON issues(closed_at);

  -- kind: opened | source (vendor update) | state | action | note | closed | reopened
  CREATE TABLE issue_updates (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    t INTEGER NOT NULL,
    kind TEXT NOT NULL,
    state TEXT,
    text TEXT NOT NULL,
    by TEXT,
    fp TEXT
  );
  CREATE INDEX issue_updates_issue ON issue_updates(issue_id, t);
  CREATE UNIQUE INDEX issue_updates_fp ON issue_updates(issue_id, fp) WHERE fp IS NOT NULL;
  `,
  `
  -- Platforms and relevance: which component an issue touches, whether we care, and
  -- issues people report themselves (no vendor alert).
  ALTER TABLE issues ADD COLUMN components TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE issues ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE issues ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE component_prefs (
    check_id TEXT NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    component TEXT NOT NULL COLLATE NOCASE,
    relevance TEXT NOT NULL,
    note TEXT,
    by TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (check_id, component)
  );
  `,
  `
  -- Card size chosen in the UI (overrides the connector file's default).
  CREATE TABLE check_display (
    check_id TEXT PRIMARY KEY REFERENCES checks(id) ON DELETE CASCADE,
    size TEXT NOT NULL,
    by TEXT,
    at INTEGER NOT NULL
  );
  `,
  `
  -- Boards are named views (IT board, IR board); paired screens each show one.
  CREATE TABLE board_views (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    groups TEXT NOT NULL DEFAULT '[]',
    checks TEXT NOT NULL DEFAULT '[]',
    created_by TEXT,
    created_at INTEGER NOT NULL
  );
  ALTER TABLE boards ADD COLUMN view_id TEXT;
  ALTER TABLE pair_codes ADD COLUMN view_id TEXT;
  `,
];

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)");
  const row = db.prepare("SELECT v FROM schema_version").get() as { v: number } | undefined;
  let v = row?.v ?? 0;
  if (!row) db.prepare("INSERT INTO schema_version (v) VALUES (0)").run();
  for (; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.prepare("UPDATE schema_version SET v = ?").run(v + 1);
    });
  }
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}

export function audit(db: DB, actor: string, action: string, target?: string, detail?: unknown) {
  db.prepare("INSERT INTO audit (t, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)")
    .run(Date.now(), actor, action, target ?? null, detail === undefined ? null : JSON.stringify(detail));
}

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DB } from "../db/index.ts";

// Credentials are write-only from the outside: the API and MCP can set, request, list and
// delete them, but never read a value back. Only the poller decrypts, at fetch time.

export const SECRET_NAME = /^[a-z0-9_]{2,64}$/;
const REF = /\$\{secret:([a-z0-9_]{2,64})\}/g;

export class MissingSecretError extends Error {
  names: string[];
  constructor(names: string[]) {
    super(`Missing credentials: ${names.join(", ")}. Add them under Settings → Credentials.`);
    this.names = names;
  }
}

export function loadKey(opts: { env?: string; file: string }): Buffer {
  if (opts.env) {
    const k = Buffer.from(opts.env, "base64");
    if (k.length !== 32) throw new Error("IMC_SECRET_KEY must be 32 bytes, base64-encoded");
    return k;
  }
  if (existsSync(opts.file)) return Buffer.from(readFileSync(opts.file, "utf8").trim(), "base64");
  mkdirSync(dirname(opts.file), { recursive: true });
  const k = randomBytes(32);
  writeFileSync(opts.file, k.toString("base64") + "\n", { mode: 0o600 });
  return k;
}

export class Vault {
  private db: DB;
  private key: Buffer;
  constructor(db: DB, key: Buffer) { this.db = db; this.key = key; }

  set(name: string, value: string, by: string) {
    if (!SECRET_NAME.test(name)) throw new Error("Credential names use lowercase letters, digits and underscores");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(name));
    const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
    const packed = ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
    this.db.prepare(`INSERT INTO secrets (name, ciphertext, updated_at, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(name, packed, Date.now(), by);
  }

  /** Creates an empty slot so an admin sees "needs a value" in the UI. Used by the MCP tools. */
  request(name: string, description: string, by: string) {
    if (!SECRET_NAME.test(name)) throw new Error("Credential names use lowercase letters, digits and underscores");
    this.db.prepare(`INSERT INTO secrets (name, ciphertext, description, updated_at, updated_by) VALUES (?, NULL, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET description = excluded.description`).run(name, description.slice(0, 300), Date.now(), by);
  }

  delete(name: string) { this.db.prepare("DELETE FROM secrets WHERE name = ?").run(name); }

  list(): { name: string; set: boolean; description: string; updated_at: number; updated_by: string | null }[] {
    return (this.db.prepare("SELECT name, ciphertext IS NOT NULL AS has, description, updated_at, updated_by FROM secrets ORDER BY name").all() as
      { name: string; has: number; description: string; updated_at: number; updated_by: string | null }[])
      .map(r => ({ name: r.name, set: !!r.has, description: r.description, updated_at: r.updated_at, updated_by: r.updated_by }));
  }

  /** Internal only. Never expose through an API route or MCP tool. */
  reveal(name: string): string | undefined {
    const row = this.db.prepare("SELECT ciphertext FROM secrets WHERE name = ?").get(name) as { ciphertext: string | null } | undefined;
    if (!row?.ciphertext) return undefined;
    const [, iv, tag, ct] = row.ciphertext.split(":");
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    d.setAAD(Buffer.from(name));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
  }

  /** Stable per-purpose token (ping URLs, webhook bearer) derived from the instance key. */
  derive(purpose: string, id: string): string {
    return createHmac("sha256", this.key).update(`${purpose}:${id}`).digest("base64url").slice(0, 32);
  }

  /** Replaces ${secret:name} anywhere in a JSON-ish value. Returns the values used, for redaction. */
  resolve<T>(value: T): { value: T; used: string[] } {
    const used: string[] = [], missing = new Set<string>();
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return v.replace(REF, (_, n: string) => {
        const s = this.reveal(n);
        if (s === undefined) { missing.add(n); return ""; }
        used.push(s); return s;
      });
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    const out = walk(value) as T;
    if (missing.size) throw new MissingSecretError([...missing]);
    return { value: out, used };
  }
}

export function secretRefs(value: unknown): string[] {
  const s = JSON.stringify(value ?? null);
  return [...new Set([...s.matchAll(REF)].map(m => m[1]))];
}

import { openDb, type DB } from "./db/index.ts";
import { loadConnectorDir } from "./connectors/registry.ts";
import { Engine } from "./engine/engine.ts";
import { Runner } from "./engine/runner.ts";
import { Vault, loadKey } from "./secrets/vault.ts";
import type { SafeFetch } from "./connectors/fetch.ts";
import { log } from "./util/log.ts";
import { ensureDefaultView } from "./engine/boards.ts";

/** Wires the pieces together; used by main.ts, the CLI and integration tests. */
export function boot(opts: { db: string | DB; connectorsDir?: string; key: Buffer; fetch?: SafeFetch }) {
  const db = typeof opts.db === "string" ? openDb(opts.db) : opts.db;
  const engine = new Engine(db);
  ensureDefaultView(db);
  const vault = new Vault(db, opts.key);
  const runner = new Runner(engine, vault, opts.fetch);
  const problems: string[] = [];
  if (opts.connectorsDir) {
    const files = loadConnectorDir(opts.connectorsDir);
    for (const f of files) if (!f.result.ok) problems.push(`${f.file}: ${f.result.errors.join("; ")}`);
    engine.syncConnectors(files.flatMap(f => (f.result.ok ? [f.result.connector] : [])), "repo");
    for (const p of problems) log("warn", "connector skipped", { problem: p });
  }
  return { db, engine, vault, runner, problems };
}

export { loadKey };

import { randomBytes } from "node:crypto";
import { openDb } from "../src/db/index.ts";
import { Engine } from "../src/engine/engine.ts";
import { ConnectorSchema, type ConnectorInput } from "../src/connectors/schema.ts";
import { Vault } from "../src/secrets/vault.ts";

export function setup(...defs: Partial<ConnectorInput>[]) {
  const db = openDb(":memory:");
  const engine = new Engine(db);
  const vault = new Vault(db, randomBytes(32));
  engine.syncConnectors((defs.length ? defs : [{}]).map(d => ConnectorSchema.parse({ id: "svc", name: "Service", driver: "statuspage", options: { url: "https://s.test/api/v2/summary.json" }, ...d })), "repo", T0);
  return { db, engine, vault };
}
export const T0 = Date.parse("2026-10-07T12:00:00Z");
export const min = (n: number) => T0 + n * 60e3;

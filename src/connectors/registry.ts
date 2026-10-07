import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { ConnectorSchema, formatZodError, type Connector } from "./schema.ts";
import { DRIVERS } from "./drivers/index.ts";

export interface Validated { ok: true; connector: Connector; options: unknown }
export interface Invalid { ok: false; errors: string[] }

/** Checks the envelope, then the driver's own options. `${secret:...}` refs stay unresolved. */
export function validateConnector(input: unknown): Validated | Invalid {
  const env = ConnectorSchema.safeParse(input);
  if (!env.success) return { ok: false, errors: formatZodError(env.error) };
  const driver = DRIVERS[env.data.driver];
  if (!driver) return { ok: false, errors: [`driver: unknown driver "${env.data.driver}". Available: ${Object.keys(DRIVERS).join(", ")}`] };
  // Secret refs may sit where a URL or number is expected; validate with placeholders.
  const probe = JSON.parse(JSON.stringify(env.data.options).replace(/\$\{secret:[a-z0-9_]+\}/g, "x0secret"));
  const opts = (driver.options as z.ZodType).safeParse(probe);
  if (!opts.success) return { ok: false, errors: formatZodError(opts.error).map(e => `options.${e}`) };
  return { ok: true, connector: env.data, options: opts.data };
}

export function parseConnectorYaml(text: string): Validated | Invalid {
  let doc: unknown;
  try { doc = parseYaml(text); } catch (e) { return { ok: false, errors: [`YAML: ${(e as Error).message}`] }; }
  return validateConnector(doc);
}

export interface LoadedFile { file: string; result: Validated | Invalid }

/** Reads every *.yaml under a directory tree (the repo's connectors/ folder). */
export function loadConnectorDir(dir: string): LoadedFile[] {
  const out: LoadedFile[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) { if (name !== "templates") walk(p); continue; }
      if (!/\.ya?ml$/.test(name)) continue;
      out.push({ file: relative(dir, p), result: parseConnectorYaml(readFileSync(p, "utf8")) });
    }
  };
  walk(dir);
  const seen = new Map<string, string>();
  for (const f of out) {
    if (!f.result.ok) continue;
    const prev = seen.get(f.result.connector.id);
    if (prev) f.result = { ok: false, errors: [`id "${f.result.connector.id}" is also used by ${prev}`] };
    else seen.set(f.result.connector.id, f.file);
  }
  return out;
}

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { boot, loadKey } from "./app.ts";
import { config } from "./config.ts";
import { loadConnectorDir, parseConnectorYaml } from "./connectors/registry.ts";
import { createApiToken, createUser } from "./access/identity.ts";
import { isLevel, isRole, type Principal } from "./access/policy.ts";
import { worst } from "./model.ts";
import { wrapUi } from "./http/server.ts";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const positional = rest.filter((a, i) => !a.startsWith("--") && !rest[i - 1]?.startsWith("--"));
const key = () => loadKey({ env: config.secretKeyEnv, file: config.secretKeyFile });

const HELP = `Mission Control CLI

  validate [dir]                       Check every connector file (and templates)
  poll <id | file.yaml>                Poll one connector once and print what it would show
  snapshot [--out site/status.json]    Poll all public connectors once; writes the public demo feed
  user:add <username> --role <role> [--clearance <level>] [--groups a,b]
                                       Password comes from IMC_PASSWORD, or one is generated
  token:add <username> [--name "Claude"] [--scopes view,manage_connectors]
                                       API token for an MCP client, printed once
  secret:set <name>                    Reads the value from stdin
`;

async function main() {
  switch (cmd) {
    case "validate": {
      const dir = positional[0] ?? config.connectorsDir;
      let bad = 0, good = 0;
      for (const sub of ["", "templates"]) {
        const d = sub ? join(dir, sub) : dir;
        if (!existsSync(d)) continue;
        for (const f of loadConnectorDir(d)) {
          if (f.result.ok) { good++; continue; }
          bad++; console.error(`✗ ${join(sub, f.file)}\n    ${f.result.errors.join("\n    ")}`);
        }
      }
      console.log(`${good} connector file(s) valid, ${bad} with problems`);
      process.exit(bad ? 1 : 0);
    }
    case "poll": {
      const target = positional[0]; if (!target) throw new Error("poll needs a connector id or a YAML file");
      const { engine, runner } = boot({ db: config.db, connectorsDir: config.connectorsDir, key: key() });
      let c = engine.connector(target);
      if (!c && existsSync(target)) {
        const r = parseConnectorYaml(readFileSync(target, "utf8"));
        if (!r.ok) throw new Error(r.errors.join("\n"));
        c = r.connector;
      }
      if (!c) throw new Error(`No connector "${target}"`);
      const r = await runner.dryRun(c);
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    }
    case "snapshot": {
      // Public demo feed: only connectors marked public, polled once, no database writes.
      const out = flag("out") ?? join(config.root, "site/status.json");
      const { engine, runner } = boot({ db: ":memory:", connectorsDir: config.connectorsDir, key: randomBytes(32) });
      const pub = engine.checks().filter(r => r.enabled && r.connector.sensitivity === "public");
      const checks = await Promise.all(pub.map(async ({ connector: c }) => {
        const r = await runner.dryRun(c);
        const issues = r.ok ? r.observation.issues : [];
        return {
          id: c.id, name: c.name, group: c.group, icon: c.icon ?? null, link: c.link ?? null, driver: c.driver,
          platform: c.platform, components: c.components,
          state: r.ok ? worst(issues.map(i => i.state)) : "stale",
          summary: r.ok ? (issues[0]?.summary ?? r.observation.okSummary ?? "Operational") : `Can't read source: ${r.error}`,
          issues,
        };
      }));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify({ generated_at: Date.now(), checks }, null, 2));
      // The page that reads it: the same UI in public (read-only, browser-history) mode.
      writeFileSync(join(dirname(out), "index.html"), wrapUi(readFileSync(config.uiFile, "utf8"), "public"));
      console.log(`Wrote ${checks.length} checks to ${out} and the page to ${join(dirname(out), "index.html")}`);
      return;
    }
    case "user:add": {
      const username = positional[0], role = flag("role"), clearance = flag("clearance");
      if (!username || !isRole(role)) throw new Error("Usage: user:add <username> --role <global_admin|instance_admin|dashboard_admin|technician|viewer|guest>");
      if (clearance && !isLevel(clearance)) throw new Error("Unknown clearance");
      const password = process.env.IMC_PASSWORD ?? randomBytes(12).toString("base64url");
      const { db } = boot({ db: config.db, key: key() });
      await createUser(db, { username, password, role, clearance: clearance as never, groups: flag("groups")?.split(",").filter(Boolean) });
      console.log(`Created ${username} (${role}).${process.env.IMC_PASSWORD ? "" : `\nPassword: ${password}\nChange it after first sign-in.`}`);
      return;
    }
    case "token:add": {
      const { db } = boot({ db: config.db, key: key() });
      const u = db.prepare("SELECT id, username, role, clearance FROM users WHERE username = ?").get(positional[0] ?? "") as
        { id: number; username: string; role: never; clearance: never } | undefined;
      if (!u) throw new Error("token:add needs an existing username");
      const by: Principal = { kind: "user", id: String(u.id), name: u.username, role: u.role, clearance: u.clearance, groups: [] };
      const t = createApiToken(db, by, flag("name") ?? "MCP client", (flag("scopes") ?? "view,manage_connectors").split(",") as never);
      console.log(`Token (shown once): ${t.token}\nMCP endpoint: ${config.publicUrl}/mcp  (Authorization: Bearer <token>)`);
      return;
    }
    case "secret:set": {
      const name = positional[0]; if (!name) throw new Error("secret:set needs a name");
      const value = readFileSync(0, "utf8").replace(/\r?\n$/, "");
      const { vault } = boot({ db: config.db, key: key() });
      vault.set(name, value, "cli");
      console.log(`Stored ${name}.`);
      return;
    }
    default:
      console.log(HELP);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

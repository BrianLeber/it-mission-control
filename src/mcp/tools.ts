import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { stringify as toYaml } from "yaml";
import { audit } from "../db/index.ts";
import { can, canSee, levelIndex, type Permission, type Principal } from "../access/policy.ts";
import { DRIVERS } from "../connectors/drivers/index.ts";
import { parseConnectorYaml } from "../connectors/registry.ts";
import { redact } from "../connectors/fetch.ts";
import { secretRefs, type Vault } from "../secrets/vault.ts";
import type { Engine } from "../engine/engine.ts";
import type { Runner } from "../engine/runner.ts";
import { getIncident, incidentMarkdown, listIncidents } from "../engine/incidents.ts";

// MCP tools for building connectors with any LLM client.
// The assistant can read docs, validate, dry-run and save DRAFTS, and ask for credential slots.
// It can never read a credential value or enable a connector: a person does that in the web UI.

export interface ToolContext { engine: Engine; runner: Runner; vault: Vault; principal: Principal }

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

export function buildMcpServer(ctx: ToolContext): McpServer {
  const { engine, runner, vault, principal: p } = ctx;
  const server = new McpServer(
    { name: "it-mission-control", version: "0.1.0" },
    { instructions: "Tools for authoring Mission Control connectors. Start with list_drivers and describe_driver, write a connector as YAML, run validate_connector and test_connector, then save_connector_draft. Put credentials in YAML only as ${secret:name}; use request_credential to create the slot, and tell the user to paste the value under Settings → Credentials. An admin enables drafts in the web UI." },
  );
  const need = (perm: Permission) => can(p, perm) ? null : fail(`This token lacks the "${perm}" permission.`);

  server.registerTool("list_drivers", {
    title: "List connector drivers",
    description: "Built-in drivers a connector can use, with what each one reads.",
  }, async () => text(Object.values(DRIVERS).map(d => ({ name: d.name, kind: d.kind, summary: d.summary }))));

  server.registerTool("describe_driver", {
    title: "Describe a driver",
    description: "Options schema (JSON Schema) and a complete example connector file for one driver.",
    inputSchema: { name: z.string() },
  }, async ({ name }) => {
    const d = DRIVERS[name];
    if (!d) return fail(`Unknown driver "${name}". Use list_drivers.`);
    return text({ name: d.name, kind: d.kind, summary: d.summary, options_schema: z.toJSONSchema(d.options, { io: "input", unrepresentable: "any" }), example_yaml: d.example });
  });

  server.registerTool("list_connectors", {
    title: "List connectors",
    description: "Connectors you are cleared to see, with driver, source (repo/custom/draft), enabled flag and current state.",
  }, async () => text(engine.checks()
    .filter(r => canSee(p, r.connector))
    .map(r => ({ id: r.id, name: r.connector.name, driver: r.connector.driver, source: r.source, enabled: !!r.enabled, state: engine.state(r.id)?.state, sensitivity: r.connector.sensitivity }))));

  server.registerTool("get_connector", {
    title: "Get a connector",
    description: "The connector definition as YAML. Credentials appear only as ${secret:name} references.",
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    const c = engine.connector(id);
    if (!c || !canSee(p, c)) return fail(`No connector "${id}".`); // same answer whether hidden or absent
    return text(toYaml(c));
  });

  server.registerTool("validate_connector", {
    title: "Validate a connector",
    description: "Checks a connector YAML against the envelope and driver schema. Reports credentials it references that aren't set yet.",
    inputSchema: { yaml: z.string() },
  }, async ({ yaml }) => {
    const r = parseConnectorYaml(yaml);
    if (!r.ok) return text({ valid: false, errors: r.errors });
    const set = new Set(vault.list().filter(s => s.set).map(s => s.name));
    return text({ valid: true, id: r.connector.id, driver: r.connector.driver, missing_credentials: secretRefs(r.connector.options).filter(n => !set.has(n)) });
  });

  server.registerTool("test_connector", {
    title: "Dry-run a connector",
    description: "Polls the source once using stored credentials and returns the state and issues it would produce. Nothing is saved.",
    inputSchema: { yaml: z.string() },
  }, async ({ yaml }) => {
    const denied = need("manage_connectors"); if (denied) return denied;
    const r = parseConnectorYaml(yaml);
    if (!r.ok) return text({ valid: false, errors: r.errors });
    const result = await runner.dryRun(r.connector);
    if (!result.ok) return text({ valid: true, ran: false, error: result.error, missing_credentials: result.missing ?? [] });
    const issues = result.observation.issues;
    const state = issues.length ? issues.map(i => i.state).sort((a, b) => ["crit", "warn", "stale", "maint"].indexOf(a) - ["crit", "warn", "stale", "maint"].indexOf(b))[0] : "ok";
    // Belt and braces: scrub any credential that a source echoed back into a summary.
    const used = vault.resolve(r.connector.options).used;
    return text(JSON.parse(redact(JSON.stringify({ valid: true, ran: true, ms: result.ms, state, ok_summary: result.observation.okSummary, issues }), used)));
  });

  server.registerTool("save_connector_draft", {
    title: "Save a connector draft",
    description: "Stores the connector as a disabled draft. A dashboard or instance admin reviews and enables it in the web UI.",
    inputSchema: { yaml: z.string() },
  }, async ({ yaml }) => {
    const denied = need("manage_connectors"); if (denied) return denied;
    const r = parseConnectorYaml(yaml);
    if (!r.ok) return text({ saved: false, errors: r.errors });
    const c = r.connector;
    if (levelIndex(c.sensitivity) > levelIndex(p.clearance)) return fail(`You can't create a connector above your own clearance (${p.clearance}).`);
    const existing = engine.checks().find(x => x.id === c.id);
    if (existing && existing.source !== "draft") return fail(`"${c.id}" already exists and isn't a draft. Pick another id.`);
    engine.syncConnectors([c], "draft");
    audit(engine.db, `${p.kind}:${p.name}`, "connector.draft", c.id);
    return text({ saved: true, id: c.id, status: "draft (disabled)", next: "Ask an admin to review it under Connectors and enable it. Add any missing credentials under Settings → Credentials." });
  });

  server.registerTool("list_incidents", {
    title: "List incidents",
    description: "Incidents you are cleared to see. Filter by status (open, closed, tracked, archived, all), check id, or text such as a vendor reference (SP1489449).",
    inputSchema: { status: z.enum(["open", "closed", "tracked", "archived", "all"]).optional(), check: z.string().optional(), q: z.string().optional() },
  }, async ({ status, check, q }) => text(listIncidents(engine, p, { status, check, q, limit: 100 })));

  server.registerTool("get_incident", {
    title: "Get an incident",
    description: "One incident's full record as Markdown: service, status, impact, and the timeline of vendor updates, state changes, actions and notes.",
    inputSchema: { id: z.number().int() },
  }, async ({ id }) => {
    const i = getIncident(engine, p, id);
    return i ? text(incidentMarkdown(i)) : fail(`No incident ${id}.`);
  });

  server.registerTool("list_credentials", {
    title: "List credential slots",
    description: "Names of stored credentials and whether each has a value. Values are never returned.",
  }, async () => {
    const denied = need("manage_connectors"); if (denied) return denied;
    return text(vault.list().map(s => ({ name: s.name, has_value: s.set, description: s.description })));
  });

  server.registerTool("request_credential", {
    title: "Request a credential",
    description: "Creates an empty credential slot with a description so a person can paste the value in the web UI. Never send the value itself here.",
    inputSchema: { name: z.string().regex(/^[a-z0-9_]{2,64}$/), description: z.string().max(300) },
  }, async ({ name, description }) => {
    const denied = need("manage_connectors"); if (denied) return denied;
    vault.request(name, description, `${p.kind}:${p.name}`);
    return text({ requested: name, next: `Ask the user to paste the value under Settings → Credentials → ${name}. Reference it in YAML as \${secret:${name}}.` });
  });

  return server;
}

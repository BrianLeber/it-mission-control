import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadConnectorDir, parseConnectorYaml } from "../src/connectors/registry.ts";
import { DRIVERS } from "../src/connectors/drivers/index.ts";

const dir = join(import.meta.dirname, "..", "connectors");

test("every repo connector is valid and ids are unique", () => {
  const files = loadConnectorDir(dir);
  assert.ok(files.length >= 10);
  for (const f of files) assert.ok(f.result.ok, `${f.file}: ${!f.result.ok && f.result.errors.join("; ")}`);
});

test("everything under public/ is marked public and has a link", () => {
  for (const f of loadConnectorDir(join(dir, "public"))) {
    assert.ok(f.result.ok);
    assert.equal(f.result.connector.sensitivity, "public", f.file);
    assert.ok(f.result.connector.link, `${f.file} needs a link for "Open source"`);
  }
});

test("templates are valid", () => {
  for (const f of loadConnectorDir(join(dir, "templates"))) assert.ok(f.result.ok, `${f.file}: ${!f.result.ok && f.result.errors.join("; ")}`);
});

test("every driver's example is a valid connector", () => {
  for (const d of Object.values(DRIVERS)) {
    const r = parseConnectorYaml(d.example);
    assert.ok(r.ok, `${d.name}: ${!r.ok && r.errors.join("; ")}`);
  }
});

test("helpful errors", () => {
  const r = parseConnectorYaml("id: X\nname: x\ndriver: nope\n");
  assert.ok(!r.ok && r.errors.some(e => e.startsWith("id:")));
  const r2 = parseConnectorYaml("id: ok-id\nname: x\ndriver: statuspage\noptions: { url: not-a-url }\n");
  assert.ok(!r2.ok && r2.errors.some(e => e.startsWith("options.url")));
  const r3 = parseConnectorYaml("id: ok-id\nname: x\ndriver: statuspage\noptions: { url: https://a.test/x }\n");
  assert.ok(r3.ok && r3.connector.sensitivity === "viewer", "default sensitivity is never public");
});

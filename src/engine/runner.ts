import type { z } from "zod";
import { DRIVERS } from "../connectors/drivers/index.ts";
import { redact, safeFetch, type SafeFetch } from "../connectors/fetch.ts";
import type { Connector } from "../connectors/schema.ts";
import type { Observation } from "../model.ts";
import { MissingSecretError, type Vault } from "../secrets/vault.ts";
import { log } from "../util/log.ts";
import type { Engine } from "./engine.ts";

const ORIGIN: Record<string, string> = {
  statuspage: "Statuspage API", "slack-status": "Slack status API", "google-incidents": "Google incidents feed",
  rss: "RSS feed", json: "JSON API", http: "HTTP check", "ms-graph-service-health": "Microsoft Graph",
  heartbeat: "Heartbeat", webhook: "Webhook",
};
export const originFor = (driver: string) => ORIGIN[driver] ?? driver;

export type DryRun = { ok: true; observation: Observation; ms: number } | { ok: false; error: string; missing?: string[] };

/** Polls due connectors. Credentials are decrypted per run and scrubbed from any error text. */
export class Runner {
  private engine: Engine;
  private vault: Vault;
  private fetch: SafeFetch;
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();
  concurrency = 4;

  constructor(engine: Engine, vault: Vault, fetch: SafeFetch = safeFetch) {
    this.engine = engine; this.vault = vault; this.fetch = fetch;
  }

  /** Runs one connector definition without touching the database. Used by tests and the MCP test tool. */
  async dryRun(c: Connector, now = Date.now()): Promise<DryRun> {
    const driver = DRIVERS[c.driver];
    if (!driver?.poll) return { ok: false, error: `Driver "${c.driver}" is push-based; there is nothing to poll.` };
    let used: string[] = [];
    try {
      const resolved = this.vault.resolve(c.options);
      used = resolved.used;
      const opts = (driver.options as z.ZodType).parse(resolved.value);
      const t = Date.now();
      const observation = await driver.poll(opts, { fetch: this.fetch, now });
      return { ok: true, observation, ms: Date.now() - t };
    } catch (e) {
      if (e instanceof MissingSecretError) return { ok: false, error: e.message, missing: e.names };
      return { ok: false, error: redact((e as Error).message || String(e), used) };
    }
  }

  async runCheck(id: string, now = Date.now()) {
    const row = this.engine.checks().find(c => c.id === id);
    if (!row || !row.enabled) return;
    const c = row.connector;
    this.running.add(id);
    try {
      const r = await this.dryRun(c, now);
      const origin = originFor(c.driver);
      if (r.ok) this.engine.observe(id, r.observation, origin);
      else {
        const msg = r.missing ? `waiting for credentials (${r.missing.join(", ")})` : r.error;
        // Missing credentials won't fix themselves on retry: show NO SIGNAL straight away.
        this.engine.fail(id, msg, origin, Date.now(), { immediate: !!r.missing });
        log("warn", "poll failed", { check: id, error: msg });
      }
    } finally {
      this.running.delete(id);
      const st = this.engine.state(id);
      // A failed poll retries at the fast interval too, so a blip is confirmed or cleared quickly.
      const unhealthy = st && ((!["ok", "maint"].includes(st.state) && !st.parked) || st.fail_count > 0);
      const base = unhealthy ? c.fast_every : c.every;
      const jitter = base * (Math.random() * 0.1 - 0.05);
      this.engine.db.prepare("UPDATE check_state SET next_due = ? WHERE check_id = ?").run(Date.now() + base + jitter, id);
    }
  }

  private lastPurge = 0;
  async tick(now = Date.now()) {
    this.engine.sweep(now);
    if (now - this.lastPurge > 6 * 3600e3) { this.lastPurge = now; this.engine.purge(now); }
    const due = this.engine.checks().filter(r => {
      if (!r.enabled || !DRIVERS[r.connector.driver]?.poll || this.running.has(r.id)) return false;
      return (this.engine.state(r.id)?.next_due ?? 0) <= now;
    });
    const queue = [...due];
    const workers = Array.from({ length: Math.min(this.concurrency, queue.length) }, async () => {
      for (let r = queue.shift(); r; r = queue.shift()) await this.runCheck(r.id, now).catch(e => log("error", "runner", { check: r!.id, error: String(e) }));
    });
    await Promise.all(workers);
  }

  start(everyMs = 15_000) {
    // Spread first polls over 30s so a cold start doesn't hit every vendor at once.
    const stmt = this.engine.db.prepare("UPDATE check_state SET next_due = ? WHERE check_id = ? AND next_due = 0");
    for (const r of this.engine.checks()) stmt.run(Date.now() + Math.random() * 30_000, r.id);
    const loop = () => { this.tick().catch(e => log("error", "tick", { error: String(e) })).finally(() => { this.timer = setTimeout(loop, everyMs); }); };
    this.timer = setTimeout(loop, 1000);
  }
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
}

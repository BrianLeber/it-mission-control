import { z } from "zod";
import { defineDriver } from "./types.ts";

// Push sources: the outside world calls us. URLs and tokens are shown to connector admins.

export const heartbeat = defineDriver({
  name: "heartbeat",
  kind: "push",
  summary: "Cron jobs, scripts and appliances ping us; missing pings become NO SIGNAL, then DOWN.",
  options: z.object({
    down_after: z.string().optional().describe("Escalate NO SIGNAL to DOWN after this long, e.g. 6h"),
  }),
  example: `id: backup-nas
name: backup-nas
group: Infrastructure
icon: { mono: NAS, color: "#3b3b3b" }
sensitivity: viewer
driver: heartbeat
every: 5m      # expected ping interval
grace: 2       # NO SIGNAL after 2 missed intervals
options:
  down_after: 1h
# Ping: curl -fsS -X POST https://<host>/api/ping/backup-nas/<token>
# Fail: curl -fsS -X POST https://<host>/api/ping/backup-nas/<token>/fail
`,
});

export const webhook = defineDriver({
  name: "webhook",
  kind: "push",
  summary: 'Anything that can POST JSON: {"state":"warn","summary":"...","key":"optional"}. state "ok" clears.',
  options: z.object({
    expect_every: z.string().optional().describe("If set, NO SIGNAL when nothing arrives for this long"),
  }),
  example: `id: ninja-fs01
name: FS01
group: Infrastructure
icon: { mono: FS, color: "#00597a" }
sensitivity: viewer
driver: webhook
# POST https://<host>/api/ingest/ninja-fs01  with header  Authorization: Bearer <token>
# Body: {"key":"disk-d","state":"warn","summary":"Disk D: 92% used"}
`,
});

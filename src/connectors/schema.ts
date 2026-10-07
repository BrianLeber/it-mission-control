import { z } from "zod";
import { LEVELS } from "../access/policy.ts";
import { parseDuration } from "../util/duration.ts";

const duration = z.union([z.string(), z.number()]).transform((v, ctx) => {
  try { return parseDuration(v); }
  catch (e) { ctx.addIssue({ code: "custom", message: (e as Error).message }); return z.NEVER; }
});

/** The common envelope every connector file shares. `options` is checked by the driver. */
export const ConnectorSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "lowercase letters, digits and dashes, 2-63 chars"),
  name: z.string().min(1).max(80),
  group: z.string().min(1).max(40).default("Other"),
  icon: z.object({
    mono: z.string().min(1).max(4),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }).optional(),
  /** Where "Open source" goes: the vendor status page, console or runbook. */
  link: z.url().optional(),
  /** Who may know this check exists. Defaults to registered viewers, never public. */
  sensitivity: z.enum(LEVELS).default("viewer"),
  /** Selective access: only members of at least one of these groups can see it. */
  groups: z.array(z.string().min(1)).default([]),
  enabled: z.boolean().default(true),
  driver: z.string().min(1),
  /** Normal poll interval, and the faster one used while the check isn't operational. */
  every: duration.default(3600e3),
  fast_every: duration.default(300e3),
  /** Consecutive polls an issue must be gone before it clears (attack fast, release slow). */
  release: z.number().int().min(1).max(10).default(2),
  /** NO SIGNAL after this many intervals without a good reading. */
  grace: z.number().min(1).max(20).default(2),
  options: z.record(z.string(), z.unknown()).default({}),
  notes: z.string().max(2000).optional(),
});

export type ConnectorInput = z.input<typeof ConnectorSchema>;
export type Connector = z.output<typeof ConnectorSchema>;

export const formatZodError = (e: z.ZodError) =>
  e.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`);

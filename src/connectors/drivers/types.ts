import type { z } from "zod";
import type { Observation } from "../../model.ts";
import type { SafeFetch } from "../fetch.ts";

export interface PollContext { fetch: SafeFetch; now: number }

export interface Driver<S extends z.ZodType = z.ZodType> {
  name: string;
  /** poll: we fetch on a schedule. push: the source calls us (heartbeat, webhook). */
  kind: "poll" | "push";
  /** One line for people and for the MCP describe_driver tool. */
  summary: string;
  options: S;
  /** A complete, valid connector file showing typical use. */
  example: string;
  poll?: (opts: z.output<S>, ctx: PollContext) => Promise<Observation>;
}

export const defineDriver = <S extends z.ZodType>(d: Driver<S>) => d;

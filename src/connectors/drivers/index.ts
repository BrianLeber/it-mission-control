import type { Driver } from "./types.ts";
import statuspage from "./statuspage.ts";
import slack from "./slack.ts";
import google from "./google.ts";
import rss from "./rss.ts";
import json from "./json.ts";
import http from "./http.ts";
import msgraph from "./msgraph.ts";
import { heartbeat, webhook } from "./push.ts";

export const DRIVERS: Record<string, Driver> = Object.fromEntries(
  [statuspage, slack, google, rss, json, http, msgraph, heartbeat, webhook].map(d => [d.name, d as unknown as Driver]),
);

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface FetchResult {
  status: number;
  ok: boolean;
  headers: Headers;
  ms: number;
  text: string;
  json<T = unknown>(): T;
}

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Allow cloud metadata / link-local targets. Off by default (SSRF guard). */
  allowLinkLocal?: boolean;
}

export type SafeFetch = (url: string, opts?: FetchOptions) => Promise<FetchResult>;

const UA = "it-mission-control/0.1 (+https://github.com/BrianLeber/it-mission-control)";

function isLinkLocal(ip: string): boolean {
  if (isIP(ip) === 4) return ip.startsWith("169.254.") || ip === "100.100.100.200"; // AWS/Azure/GCP and Alibaba metadata
  const v6 = ip.toLowerCase();
  return v6.startsWith("fe80:") || v6 === "fd00:ec2::254";
}

/**
 * fetch() with a timeout, a body cap, and a guard against cloud metadata addresses.
 * Private ranges stay allowed on purpose: internal servers are legitimate targets.
 */
export const safeFetch: SafeFetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol)) throw new Error(`Unsupported protocol ${u.protocol}`);
  if (!opts.allowLinkLocal) {
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map(a => a.address);
    if (addrs.some(isLinkLocal)) throw new Error(`Blocked link-local address for ${u.hostname}`);
  }
  const started = Date.now();
  const res = await fetch(u, {
    method: opts.method ?? "GET",
    headers: { "user-agent": UA, accept: "application/json, application/xml, text/xml, */*;q=0.5", ...opts.headers },
    body: opts.body,
    redirect: "follow",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  const max = opts.maxBytes ?? 5 * 1024 * 1024;
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); throw new Error(`Response larger than ${max} bytes`); }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return {
    status: res.status, ok: res.ok, headers: res.headers, ms: Date.now() - started, text,
    json<T>() {
      try { return JSON.parse(text) as T; }
      catch { throw new Error(`Expected JSON from ${u.host}, got ${res.headers.get("content-type") ?? "unknown content"}`); }
    },
  };
};

/** Replaces any secret values that leaked into a message (e.g. an error echoing a URL). */
export function redact(message: string, secrets: string[]): string {
  let out = message;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("•••");
  return out;
}

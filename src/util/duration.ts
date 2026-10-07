const UNITS: Record<string, number> = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 };

/** Parses "90s", "5m", "1h", "1h30m", "2d" into milliseconds. */
export function parseDuration(input: string | number): number {
  if (typeof input === "number") return input;
  const parts = [...input.trim().matchAll(/(\d+(?:\.\d+)?)\s*([smhdw])/g)];
  if (!parts.length || parts.map(p => p[0]).join("") !== input.replace(/\s+/g, "")) {
    throw new Error(`Invalid duration "${input}". Use forms like 30s, 5m, 1h, 2d.`);
  }
  return parts.reduce((ms, [, n, u]) => ms + Number(n) * UNITS[u], 0);
}

export const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;

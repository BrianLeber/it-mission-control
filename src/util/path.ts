/** Reads "a.b[0].c" (or "$" for the root) out of parsed JSON. Arrays expose .length. */
export function getPath(obj: unknown, path: string): unknown {
  if (path === "$" || path === "") return obj;
  const parts = path.replace(/^\$\.?/, "").replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Fills {{path}} placeholders. Unknown paths render as "?". */
export function template(t: string, ctx: unknown, get: (ctx: unknown, path: string) => unknown = getPath): string {
  return t.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, p: string) => {
    const v = get(ctx, p);
    return v === undefined || v === null ? "?" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

// Minimal RSS 2.0 / Atom reader: enough for status feeds, tolerant of messy markup.

export interface FeedItem { id: string; title: string; link: string; date: number | null; text: string }

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
      e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()] ?? m);
}
const stripTags = (s: string) => decode(decode(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function tag(block: string, names: string[]): string {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, "i"));
    if (m) return m[1];
  }
  return "";
}

export function parseFeed(xml: string): FeedItem[] {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  return blocks.map(b => {
    const atomLink = b.match(/<link[^>]*href="([^"]+)"[^>]*\/?>/i)?.[1];
    const link = decode(atomLink ?? tag(b, ["link"])).trim();
    const title = stripTags(tag(b, ["title"]));
    const id = decode(tag(b, ["guid", "id"])).trim() || link || title;
    const d = Date.parse(decode(tag(b, ["updated", "pubDate", "published", "dc:date"])).trim());
    return { id, title, link, date: Number.isNaN(d) ? null : d, text: stripTags(tag(b, ["description", "summary", "content", "content:encoded"])) };
  });
}

/** Vendor posts arrive as HTML; keep readable text only. */
export const plain = (html: string) => html.replace(/<br\s*\/?>|<\/p>|<\/li>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, " ").split("\n").map(l => l.trim()).filter(Boolean).join("\n");

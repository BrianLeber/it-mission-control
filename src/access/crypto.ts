import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 32768, R = 8, P = 1, KEYLEN = 32;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(pw, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt") return false;
  const key = await derive(pw, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
  const want = Buffer.from(hash, "base64");
  return key.length === want.length && timingSafeEqual(key, want);
}

function derive(pw: string, salt: Buffer, n = N, r = R, p = P): Promise<Buffer> {
  return new Promise((res, rej) => scrypt(pw.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (e, k) => e ? rej(e) : res(k)));
}

/** Opaque bearer secrets: we store only their SHA-256, so a database leak doesn't leak sessions. */
export const newToken = (prefix = "") => prefix + randomBytes(32).toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Pairing codes: 6 characters without look-alikes (no 0/O, 1/I/L), shown as ABC-DEF. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function pairCode(): string {
  const b = randomBytes(6);
  const c = [...b].map(x => ALPHABET[x % ALPHABET.length]).join("");
  return `${c.slice(0, 3)}-${c.slice(3)}`;
}
export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

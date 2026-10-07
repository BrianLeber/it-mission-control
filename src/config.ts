import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

export const config = {
  root,
  port: Number(process.env.IMC_PORT ?? 8080),
  host: process.env.IMC_HOST ?? "0.0.0.0",
  db: process.env.IMC_DB ?? resolve(root, "data/imc.db"),
  connectorsDir: process.env.IMC_CONNECTORS ?? resolve(root, "connectors"),
  secretKeyFile: process.env.IMC_SECRET_KEY_FILE ?? resolve(root, "data/secret.key"),
  secretKeyEnv: process.env.IMC_SECRET_KEY,
  uiFile: resolve(root, "prototype/index.html"),
  publicUrl: process.env.IMC_PUBLIC_URL ?? `http://localhost:${process.env.IMC_PORT ?? 8080}`,
  pollTickMs: Number(process.env.IMC_TICK_MS ?? 15_000),
};
export const secureCookies = () => config.publicUrl.startsWith("https://");

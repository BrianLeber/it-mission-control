import { boot, loadKey } from "./app.ts";
import { config, secureCookies } from "./config.ts";
import { createApp } from "./http/server.ts";
import { userCount } from "./access/identity.ts";
import { log } from "./util/log.ts";

const { db, engine, vault, runner } = boot({
  db: config.db,
  connectorsDir: config.connectorsDir,
  key: loadKey({ env: config.secretKeyEnv, file: config.secretKeyFile }),
});

const server = createApp({ db, engine, runner, vault, config: { uiFile: config.uiFile, publicUrl: config.publicUrl, secureCookies: secureCookies() } });
server.listen(config.port, config.host, () => {
  log("info", "Mission Control listening", { url: config.publicUrl, checks: engine.checks().filter(c => c.enabled).length });
  if (userCount(db) === 0) log("warn", "No users yet. Create the first admin: npm run cli -- user:add <name> --role instance_admin");
});
runner.start(config.pollTickMs);

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { runner.stop(); server.close(); db.close(); process.exit(0); });

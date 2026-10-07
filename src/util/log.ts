type Level = "debug" | "info" | "warn" | "error";
const order: Level[] = ["debug", "info", "warn", "error"];
const min = order.indexOf((process.env.IMC_LOG_LEVEL as Level) || "info");

export function log(level: Level, msg: string, extra?: Record<string, unknown>) {
  if (order.indexOf(level) < min) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

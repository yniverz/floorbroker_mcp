import { mkdirSync } from "node:fs";
import { hashPassword, validatePasswordStrength } from "./auth/password.js";
import { loadConfig } from "./config.js";
import { createContext } from "./context.js";
import { openAppDb } from "./db/app.js";
import { openMarketDb } from "./db/marketdata.js";
import { createApp } from "./http/app.js";
import { logger, setLogLevel } from "./logger.js";
import { configureOutboundProxy, proxyLabel } from "./platforms/http.js";

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  mkdirSync(config.dataDir, { recursive: true });
  configureOutboundProxy(config.outboundProxy, config.outboundProxyPlatforms, config.outboundProxyVia);
  if (config.outboundProxy) logger.info("outbound proxy enabled", { proxy: proxyLabel(), via: config.outboundProxyVia, platforms: config.outboundProxyPlatforms });

  const db = openAppDb(config.appDbPath);
  const marketDb = openMarketDb(config.marketDbPath);
  const ctx = createContext(config, db, marketDb);

  if (ctx.users.count() === 0) {
    if (!config.adminPassword) throw new Error("No users exist yet: set ADMIN_PASSWORD to create the first admin account.");
    const weak = validatePasswordStrength(config.adminPassword);
    if (weak) throw new Error(`ADMIN_PASSWORD: ${weak}`);
    ctx.users.create({ username: config.adminUsername, passwordHash: await hashPassword(config.adminPassword), role: "admin", mustChange: false });
    logger.info("created initial admin account", { username: config.adminUsername });
  }

  const app = createApp(ctx);
  const server = app.listen(config.port, () => {
    logger.info("floorbroker listening", { port: config.port, publicUrl: config.publicUrl, mcp: config.mcpResourceUrl });
  });

  ctx.sync.start();
  void ctx.strategies.resumeAll().catch((err) => logger.warn("resuming strategy runs failed", { err: String(err) }));
  const housekeeping = setInterval(() => {
    try {
      ctx.connections.purgeExpired();
      ctx.webSessions.purge();
      ctx.activity.purge(config.toolLogRetentionDays);
    } catch (err) {
      logger.warn("housekeeping failed", { err: String(err) });
    }
  }, 3_600_000);

  const shutdown = (signal: string) => {
    logger.info("shutting down", { signal });
    clearInterval(housekeeping);
    ctx.sync.stop();
    void ctx.strategies.closeAll();
    void ctx.streams.closeAll();
    server.close(() => {
      void ctx.accountService.closeAll().finally(() => {
        db.close();
        marketDb.close();
        process.exit(0);
      });
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error("fatal", { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

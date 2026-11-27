import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import helmet from "helmet";
import { attachWebSession, requireLogin, verifyCsrf } from "../auth/middleware.js";
import type { AppContext } from "../context.js";
import { logger } from "../logger.js";
import { mcpRouter } from "../mcp/transport.js";
import { metadataRouter } from "../oauth/metadata.js";
import { oauthRouter } from "../oauth/router.js";
import { sha256 } from "../util/crypto.js";
import { errorPage } from "../web/layout.js";
import { accountsRouter } from "../web/routes/accounts.js";
import { activityRouter } from "../web/routes/activity.js";
import { adminRouter, meRouter } from "../web/routes/admin.js";
import { authRouter } from "../web/routes/auth.js";
import { connectionsRouter } from "../web/routes/connections.js";
import { strategiesRouter } from "../web/routes/strategies.js";
import { dashboardRouter } from "../web/routes/dashboard.js";
import { CSP_DIRECTIVES } from "./csp.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "public");

export function createApp(ctx: AppContext): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.set("trust proxy", ctx.config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { ...CSP_DIRECTIVES, ...(ctx.config.cookieSecure ? { "upgrade-insecure-requests": [] } : {}) },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "same-origin" },
      referrerPolicy: { policy: "no-referrer" },
      hsts: ctx.config.cookieSecure ? { maxAge: 31_536_000, includeSubDomains: false } : false,
      frameguard: { action: "deny" },
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.type("text/plain").send("ok");
  });

  app.use(rateLimit({ windowMs: 60_000, limit: 1200, standardHeaders: "draft-7", legacyHeaders: false }));

  // --- MCP (public, bearer-authenticated) ---------------------------------------
  const mcpLimiter = rateLimit({
    windowMs: 60_000,
    limit: ctx.config.rateLimit.mcpPerMin,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => {
      const h = req.headers.authorization;
      return typeof h === "string" && h.startsWith("Bearer ") ? sha256(h.slice(7)).slice(0, 32) : ipKeyGenerator(req.ip ?? "0.0.0.0");
    },
    message: { jsonrpc: "2.0", error: { code: -32029, message: "Rate limit exceeded." }, id: null },
  });
  app.use("/mcp", mcpLimiter, express.json({ limit: "1mb" }), mcpRouter(ctx));

  // --- OAuth (metadata, register, token, revoke are public; authorize needs a browser login) ---
  app.use(metadataRouter(ctx));
  app.use(
    "/oauth/register",
    rateLimit({
      windowMs: 3_600_000,
      limit: ctx.config.rateLimit.registerPerHour,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: { error: "temporarily_unavailable", error_description: "Too many registrations." },
    }),
  );
  app.use(
    "/oauth",
    rateLimit({ windowMs: 15 * 60_000, limit: ctx.config.rateLimit.oauthPer15Min, standardHeaders: "draft-7", legacyHeaders: false }),
    express.json({ limit: "64kb" }),
    express.urlencoded({ extended: false, limit: "64kb" }),
    attachWebSession(ctx),
    oauthRouter(ctx),
  );

  // --- Web UI ------------------------------------------------------------------
  app.use("/assets", express.static(PUBLIC_DIR, { maxAge: "1h", index: false, dotfiles: "deny" }));
  app.use(express.urlencoded({ extended: false, limit: "256kb" }), attachWebSession(ctx));
  app.use(authRouter(ctx));

  const ui = express.Router();
  ui.use(requireLogin, verifyCsrf, (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  ui.use("/accounts", accountsRouter(ctx));
  ui.use("/activity", activityRouter(ctx));
  ui.use("/connections", connectionsRouter(ctx));
  ui.use("/strategies", strategiesRouter(ctx));
  ui.use("/account", meRouter(ctx));
  ui.use("/admin", adminRouter(ctx));
  ui.use(dashboardRouter(ctx));
  app.use(ui);

  app.use((req: Request, res: Response) => {
    if (req.accepts("html")) return errorPage(res, req, 404, "Not found", "That page does not exist.");
    res.status(404).json({ error: "not_found" });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    logger.error("unhandled request error", { err: err instanceof Error ? err.stack : String(err), path: req.path });
    if (res.headersSent) return;
    if (req.accepts("html")) return errorPage(res, req, 500, "Something went wrong", "The request could not be completed.");
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Router, type NextFunction, type Request, type Response } from "express";
import type { AppContext } from "../context.js";
import { logger } from "../logger.js";
import type { Connection } from "../repos/connections.js";
import { registerTools } from "./tools.js";

export const SERVER_INSTRUCTIONS = `floorbroker gives you access to trading accounts on one or more platforms (for example Bybit and IG) through one generic interface.

Workflow: call list_accounts first. Every other tool takes an account_id from that list. Find instruments with search_instruments and read get_instrument before ordering: it tells you what one unit of size means, the minimum size, size step and price tick.

Each account has an environment of "live" or "demo". Treat every account, demo included, as real money with real risk: size positions deliberately, prefer attaching stop losses, and verify results with get_positions / get_orders after trading.

Historic candles are cached on this server. Check list_cached_candles and request only the range you need; some platforms have a limited historic data allowance, reported in the quota field.

Times are ISO 8601 UTC. Errors come back as {"error": code, "message": text}; read the message, it usually says what to change.`;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      mcpAuth?: { userId: string; connection: Connection; tokenId: string };
    }
  }
}

function unauthorized(ctx: AppContext, res: Response, error: string, description: string): void {
  res.setHeader(
    "WWW-Authenticate",
    `Bearer realm="floorbroker", error="${error}", error_description="${description}", ` +
      `resource_metadata="${ctx.config.publicUrl}/.well-known/oauth-protected-resource/mcp"`,
  );
  res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: description }, id: null });
}

/** DNS-rebinding protection: reject untrusted browser origins and unexpected Host headers. */
function validateOriginAndHost(ctx: AppContext) {
  const origins = new Set(ctx.config.allowedOrigins);
  const hosts = new Set(ctx.config.allowedHosts);
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin !== "null" && origin !== ctx.config.publicOrigin && !origins.has(origin)) {
      logger.warn("rejected MCP request with untrusted origin", { origin });
      res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden origin." }, id: null });
      return;
    }
    const host = req.headers.host?.toLowerCase();
    if (host && !hosts.has(host)) {
      logger.warn("rejected MCP request with unexpected Host; add it to ALLOWED_HOSTS if your proxy rewrites Host", { host });
      res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden host." }, id: null });
      return;
    }
    next();
  };
}

function authenticate(ctx: AppContext) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      unauthorized(ctx, res, "invalid_request", "A bearer token is required.");
      return;
    }
    const token = ctx.connections.resolveAccessToken(header.slice(7));
    if (!token) {
      unauthorized(ctx, res, "invalid_token", "The access token is invalid or expired.");
      return;
    }
    if (token.resource !== null && token.resource !== ctx.config.mcpResourceUrl) {
      unauthorized(ctx, res, "invalid_token", "The access token was issued for a different resource.");
      return;
    }
    if (token.client_id && !ctx.oauthClients.findActive(token.client_id)) {
      unauthorized(ctx, res, "invalid_token", "The client is no longer authorized.");
      return;
    }
    const user = ctx.users.findById(token.user_id);
    const connection = ctx.connections.findById(token.connection_id);
    if (!user || user.is_active !== 1 || !connection || connection.revoked_at !== null) {
      unauthorized(ctx, res, "invalid_token", "The connection was revoked.");
      return;
    }
    req.mcpAuth = { userId: user.id, connection, tokenId: token.id };
    next();
  };
}

export function buildMcpServer(ctx: AppContext, auth: { userId: string; connection: Connection }, ip: string | null): McpServer {
  const server = new McpServer(
    { name: "floorbroker", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {} } },
  );
  registerTools(server, ctx, { userId: auth.userId, connection: auth.connection, ip });
  return server;
}

export function mcpRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(validateOriginAndHost(ctx));
  router.use(authenticate(ctx));

  // Stateless Streamable HTTP: a fresh server per request, so permission changes apply immediately.
  router.post("/", async (req: Request, res: Response) => {
    const auth = req.mcpAuth!;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = buildMcpServer(ctx, auth, req.ip ?? null);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error("mcp request failed", { err: String(err) });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error." }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).setHeader("Allow", "POST");
    res.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  };
  router.get("/", methodNotAllowed);
  router.delete("/", methodNotAllowed);
  return router;
}

import { Router, type Response } from "express";
import type { AppContext } from "../context.js";

export const SCOPES = ["trading:read", "trading:trade"] as const;
export const DEFAULT_SCOPE = "trading:read trading:trade";

/** RFC 8414 authorization server metadata and RFC 9728 protected resource metadata. */
export function metadataRouter(ctx: AppContext): Router {
  const router = Router();
  const base = ctx.config.publicUrl;

  const as = {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: [...SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: ctx.config.cimdEnabled,
    service_documentation: `${base}/`,
  };

  const pr = {
    resource: ctx.config.mcpResourceUrl,
    authorization_servers: [base],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "floorbroker",
  };

  const send = (body: unknown) => (_req: unknown, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(body);
  };

  router.get("/.well-known/oauth-authorization-server", send(as));
  router.get("/.well-known/oauth-authorization-server/mcp", send(as));
  router.get("/.well-known/openid-configuration", send(as));
  router.get("/.well-known/oauth-protected-resource", send(pr));
  router.get("/.well-known/oauth-protected-resource/mcp", send(pr));
  return router;
}

export function normalizeScope(raw: string | null | undefined): string | null {
  if (!raw || raw.trim() === "") return DEFAULT_SCOPE;
  const parts = raw.split(/\s+/).filter(Boolean);
  // Unknown scopes are ignored rather than rejected, since clients often send generic ones.
  const known = parts.filter((p) => (SCOPES as readonly string[]).includes(p));
  return known.length > 0 ? [...new Set(known)].join(" ") : DEFAULT_SCOPE;
}

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { AppContext } from "../context.js";
import { logger } from "../logger.js";
import type { OAuthClientRow } from "../repos/oauthClients.js";
import { validateRedirectUri } from "./redirectUri.js";

const REFRESH_AFTER_MS = 3_600_000;
const MAX_BYTES = 64 * 1024;

/** True for an https URL with a path, the shape MCP uses for Client ID Metadata Documents. */
export function isCimdClientId(clientId: string): boolean {
  try {
    const u = new URL(clientId);
    return u.protocol === "https:" && u.pathname.length > 1 && !u.hash && !u.username;
  } catch {
    return false;
  }
}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("::ffff:");
}

/**
 * Resolves a client identified by a Client ID Metadata Document URL (MCP 2025-11 spec).
 * The document is fetched from the public internet only, without redirects, and cached.
 */
export async function resolveCimdClient(ctx: AppContext, clientId: string): Promise<OAuthClientRow | null> {
  if (!ctx.config.cimdEnabled || !isCimdClientId(clientId)) return null;
  const existing = ctx.oauthClients.find(clientId);
  if (existing && existing.is_active !== 1) return null;
  if (existing && existing.refreshed_at && Date.now() - existing.refreshed_at < REFRESH_AFTER_MS) return existing;

  try {
    const url = new URL(clientId);
    const addrs = await lookup(url.hostname, { all: true });
    if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
      logger.warn("refusing CIMD fetch to a private address", { host: url.hostname });
      return existing ?? null;
    }
    const res = await fetch(clientId, { redirect: "error", signal: AbortSignal.timeout(5000), headers: { Accept: "application/json" } });
    if (!res.ok) return existing ?? null;
    const text = await res.text();
    if (text.length > MAX_BYTES) return existing ?? null;
    const doc = JSON.parse(text) as { client_id?: string; client_name?: string; redirect_uris?: unknown; client_uri?: string };
    if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0) return existing ?? null;
    const redirectUris = doc.redirect_uris.filter((u): u is string => typeof u === "string" && validateRedirectUri(u, ctx.config).ok).slice(0, 20);
    if (redirectUris.length === 0) return existing ?? null;
    return ctx.oauthClients.upsertCimd({
      clientId,
      clientName: typeof doc.client_name === "string" && doc.client_name ? doc.client_name : url.hostname,
      redirectUris,
      clientUri: typeof doc.client_uri === "string" ? doc.client_uri.slice(0, 500) : null,
    });
  } catch (err) {
    logger.warn("CIMD fetch failed", { clientId, err: String(err) });
    return existing ?? null;
  }
}

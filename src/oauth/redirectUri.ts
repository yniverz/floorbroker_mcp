import type { Config } from "../config.js";

/** https redirect URIs, plus http on loopback for local clients (RFC 8252 §7.3). */
export function validateRedirectUri(raw: string, config: Config): { ok: boolean; reason?: string } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2000) return { ok: false, reason: "redirect_uri missing or too long" };
  if (raw.includes("*")) return { ok: false, reason: "wildcards are not allowed" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "redirect_uri must be an absolute URL" };
  }
  if (url.hash !== "") return { ok: false, reason: "redirect_uri must not contain a fragment" };
  if (url.username || url.password) return { ok: false, reason: "redirect_uri must not contain credentials" };
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:") {
    if (!loopback) return { ok: false, reason: "http redirect_uri is only allowed on loopback" };
  } else if (url.protocol !== "https:") {
    // Native apps may use private-use URI schemes (e.g. cursor://). Allow those, but never javascript:/data:.
    if (["javascript:", "data:", "file:", "vbscript:"].includes(url.protocol)) return { ok: false, reason: "scheme not allowed" };
  }
  if (config.oauthAllowedRedirectHosts.length > 0 && !loopback && !config.oauthAllowedRedirectHosts.includes(url.hostname.toLowerCase())) {
    return { ok: false, reason: "redirect_uri host is not allowlisted" };
  }
  return { ok: true };
}

/** Loopback redirect URIs may use any port (RFC 8252 §7.3); everything else must match exactly. */
export function matchRedirectUri(registered: string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  let p: URL;
  try {
    p = new URL(presented);
  } catch {
    return false;
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(p.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === p.protocol && u.hostname === p.hostname && u.pathname === p.pathname && u.search === p.search;
    } catch {
      return false;
    }
  });
}

export function normalizeResource(raw: unknown, config: Config): { ok: boolean; value: string | null } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, value: null };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, value: null };
  }
  url.hash = "";
  const canonical = url.toString().replace(/\/$/, "");
  const expected = config.mcpResourceUrl;
  if (canonical !== expected && canonical !== config.publicOrigin) return { ok: false, value: null };
  return { ok: true, value: expected };
}

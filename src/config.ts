import { createHash } from "node:crypto";
import path from "node:path";

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback === undefined) throw new Error(`Missing required environment variable ${name}`);
    return fallback;
  }
  return v;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number`);
  return n;
}

function list(name: string, fallback: string): string[] {
  return env(name, fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export interface Config {
  port: number;
  publicUrl: string;
  publicOrigin: string;
  mcpResourceUrl: string;
  dataDir: string;
  appDbPath: string;
  marketDbPath: string;
  encryptionKey: Buffer;
  adminUsername: string;
  adminPassword: string | null;
  trustProxy: number | boolean;
  cookieSecure: boolean;
  allowedOrigins: string[];
  allowedHosts: string[];
  oauthAllowedRedirectHosts: string[];
  oauthAccessTokenTtlMs: number;
  oauthRefreshTokenTtlMs: number;
  oauthMaxClients: number;
  cimdEnabled: boolean;
  webSessionIdleTtlMs: number;
  webSessionAbsoluteTtlMs: number;
  lockout: { threshold: number; minutes: number };
  rateLimit: { loginPer15Min: number; mcpPerMin: number; oauthPer15Min: number; registerPerHour: number };
  snapshotIntervalMs: number;
  pnlSyncIntervalMs: number;
  toolLogRetentionDays: number;
  logLevel: string;
}

export function loadConfig(): Config {
  const publicUrl = env("PUBLIC_URL", "http://localhost:8080").replace(/\/+$/, "");
  const parsed = new URL(publicUrl);
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error("PUBLIC_URL must be an origin without a path");
  }
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !isLocal) {
    throw new Error("PUBLIC_URL must use https (except for localhost)");
  }

  const rawKey = env("ENCRYPTION_KEY");
  // Any string works as input; it is stretched to 32 bytes. A random 32+ byte base64 value is recommended.
  if (rawKey.length < 32) throw new Error("ENCRYPTION_KEY must be at least 32 characters (openssl rand -base64 32)");
  const encryptionKey = createHash("sha256").update(`floorbroker:v1:${rawKey}`).digest();

  const dataDir = path.resolve(env("DATA_DIR", "./data"));
  const trustRaw = env("TRUST_PROXY", "1");
  const trustProxy = trustRaw === "true" ? true : trustRaw === "false" ? false : Number(trustRaw);

  return {
    port: int("PORT", 8080),
    publicUrl,
    publicOrigin: parsed.origin,
    mcpResourceUrl: `${publicUrl}/mcp`,
    dataDir,
    appDbPath: path.join(dataDir, "app.db"),
    marketDbPath: path.join(dataDir, "marketdata.db"),
    encryptionKey,
    adminUsername: env("ADMIN_USERNAME", "admin"),
    adminPassword: process.env.ADMIN_PASSWORD || null,
    trustProxy,
    cookieSecure: parsed.protocol === "https:",
    allowedOrigins: list("ALLOWED_ORIGINS", "https://claude.ai,https://www.claude.ai,https://chatgpt.com"),
    allowedHosts: [parsed.host.toLowerCase(), ...list("ALLOWED_HOSTS", "").map((h) => h.toLowerCase())],
    oauthAllowedRedirectHosts: list("OAUTH_ALLOWED_REDIRECT_HOSTS", "").map((h) => h.toLowerCase()),
    oauthAccessTokenTtlMs: int("OAUTH_ACCESS_TOKEN_TTL_MIN", 60) * 60_000,
    oauthRefreshTokenTtlMs: int("OAUTH_REFRESH_TOKEN_TTL_DAYS", 30) * 86_400_000,
    oauthMaxClients: int("OAUTH_MAX_CLIENTS", 500),
    cimdEnabled: bool("OAUTH_CIMD_ENABLED", true),
    webSessionIdleTtlMs: int("WEB_SESSION_IDLE_TTL_MIN", 240) * 60_000,
    webSessionAbsoluteTtlMs: int("WEB_SESSION_ABSOLUTE_TTL_MIN", 1440) * 60_000,
    lockout: { threshold: int("ACCOUNT_LOCKOUT_THRESHOLD", 10), minutes: int("ACCOUNT_LOCKOUT_MINUTES", 15) },
    rateLimit: {
      loginPer15Min: int("RATE_LIMIT_LOGIN_PER_15MIN", 20),
      mcpPerMin: int("RATE_LIMIT_MCP_PER_MIN", 300),
      oauthPer15Min: int("RATE_LIMIT_OAUTH_PER_15MIN", 200),
      registerPerHour: int("RATE_LIMIT_REGISTER_PER_HOUR", 30),
    },
    snapshotIntervalMs: int("SNAPSHOT_INTERVAL_MIN", 5) * 60_000,
    pnlSyncIntervalMs: int("PNL_SYNC_INTERVAL_MIN", 15) * 60_000,
    toolLogRetentionDays: int("TOOL_LOG_RETENTION_DAYS", 365),
    logLevel: env("LOG_LEVEL", "info"),
  };
}

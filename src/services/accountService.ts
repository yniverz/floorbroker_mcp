import type { Db } from "../db/app.js";
import { logger } from "../logger.js";
import { getPlatform } from "../platforms/registry.js";
import { PlatformError } from "../platforms/errors.js";
import type { DataQuota, EnvironmentId, PlatformClient, PlatformDefinition, QuotaStore, ValidationResult } from "../platforms/types.js";
import type { AccountRepo, PlatformAccountRow } from "../repos/accounts.js";

/** Quota/rate-limit state shared across restarts, kept in the market data DB. */
export class SqliteQuotaStore implements QuotaStore {
  constructor(private readonly db: Db) {}

  get(key: string): DataQuota | null {
    const row = this.db.prepare<[string], { json: string }>("SELECT json FROM quota_state WHERE quota_key = ?").get(key);
    if (!row) return null;
    try {
      return JSON.parse(row.json) as DataQuota;
    } catch {
      return null;
    }
  }

  set(key: string, quota: DataQuota): void {
    const value = { ...quota, updatedAt: Date.now() };
    this.db
      .prepare("INSERT OR REPLACE INTO quota_state (quota_key, json, updated_at) VALUES (?, ?, ?)")
      .run(key, JSON.stringify(value), Date.now());
  }
}

interface CachedClient {
  client: PlatformClient;
  version: number;
}

/**
 * Hands out one platform client per account and keeps it alive, so session-based
 * platforms (IG) reuse their login. Clients are rebuilt when the account changes.
 */
export class AccountService {
  private clients = new Map<string, CachedClient>();

  constructor(
    private readonly accounts: AccountRepo,
    readonly quotaStore: QuotaStore,
  ) {}

  platformOf(row: PlatformAccountRow): PlatformDefinition {
    const p = getPlatform(row.platform);
    if (!p) throw new PlatformError("unsupported", `Platform "${row.platform}" is not available on this server.`);
    return p;
  }

  client(row: PlatformAccountRow): PlatformClient {
    const cached = this.clients.get(row.id);
    if (cached && cached.version === row.updated_at) return cached.client;
    if (cached) void cached.client.close?.().catch(() => undefined);

    const platform = this.platformOf(row);
    const client = platform.createClient({
      accountId: row.id,
      environment: row.environment,
      credentials: this.accounts.credentials(row),
      meta: this.accounts.meta(row),
      saveMeta: (meta) => this.accounts.saveMeta(row.id, meta),
      quotaStore: this.quotaStore,
    });
    this.clients.set(row.id, { client, version: row.updated_at });
    return client;
  }

  invalidate(accountId: string): void {
    const cached = this.clients.get(accountId);
    if (cached) void cached.client.close?.().catch(() => undefined);
    this.clients.delete(accountId);
  }

  /** Builds a throwaway client and validates the credentials (used before saving). */
  async validate(platform: PlatformDefinition, environment: EnvironmentId, credentials: Record<string, string>): Promise<ValidationResult> {
    const client = platform.createClient({
      accountId: "validation",
      environment,
      credentials,
      meta: {},
      quotaStore: this.quotaStore,
    });
    try {
      return await client.validate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.info("credential validation failed", { platform: platform.id, err: msg });
      return { errors: [msg], warnings: [], canTrade: false, externalId: null, description: null, currency: null, meta: {} };
    } finally {
      await client.close?.().catch(() => undefined);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.client.close?.().catch(() => undefined)));
    this.clients.clear();
  }
}

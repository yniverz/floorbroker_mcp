import type { Db } from "../db/app.js";
import type { AgentEnvironment, EnvironmentId } from "../platforms/types.js";
import { decryptJson, encryptJson, newId } from "../util/crypto.js";

export interface PlatformAccountRow {
  id: string;
  user_id: string;
  platform: string;
  label: string;
  /** The real platform environment (which endpoint is used). Shown in the UI. */
  environment: EnvironmentId;
  /** What the agent is told via MCP. Configurable independently of `environment`. */
  agent_environment: AgentEnvironment;
  credentials_enc: string;
  meta_json: string;
  external_id: string | null;
  description: string | null;
  currency: string | null;
  can_trade: number;
  is_active: number;
  last_error: string | null;
  last_error_at: number | null;
  created_at: number;
  updated_at: number;
}

export class AccountRepo {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
  ) {}

  private aad(id: string): string {
    return `platform_account:${id}`;
  }

  create(input: {
    userId: string;
    platform: string;
    label: string;
    environment: EnvironmentId;
    agentEnvironment: AgentEnvironment;
    credentials: Record<string, string>;
    meta: Record<string, unknown>;
    externalId: string | null;
    description: string | null;
    currency: string | null;
    canTrade: boolean;
  }): PlatformAccountRow {
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO platform_accounts (id, user_id, platform, label, environment, agent_environment, credentials_enc, meta_json,
           external_id, description, currency, can_trade, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        input.userId,
        input.platform,
        input.label.slice(0, 80),
        input.environment,
        input.agentEnvironment,
        encryptJson(this.key, input.credentials, this.aad(id)),
        JSON.stringify(input.meta),
        input.externalId,
        input.description,
        input.currency,
        input.canTrade ? 1 : 0,
        now,
        now,
      );
    return this.findById(id)!;
  }

  findById(id: string): PlatformAccountRow | undefined {
    return this.db.prepare<[string], PlatformAccountRow>("SELECT * FROM platform_accounts WHERE id = ?").get(id);
  }

  findForUser(id: string, userId: string): PlatformAccountRow | undefined {
    const a = this.findById(id);
    return a && a.user_id === userId ? a : undefined;
  }

  listForUser(userId: string): PlatformAccountRow[] {
    return this.db
      .prepare<[string], PlatformAccountRow>("SELECT * FROM platform_accounts WHERE user_id = ? ORDER BY created_at")
      .all(userId);
  }

  listActive(): PlatformAccountRow[] {
    return this.db
      .prepare<[], PlatformAccountRow>(
        `SELECT a.* FROM platform_accounts a JOIN users u ON u.id = a.user_id
          WHERE a.is_active = 1 AND u.is_active = 1`,
      )
      .all();
  }

  credentials(row: PlatformAccountRow): Record<string, string> {
    return decryptJson<Record<string, string>>(this.key, row.credentials_enc, this.aad(row.id));
  }

  meta(row: PlatformAccountRow): Record<string, unknown> {
    try {
      return JSON.parse(row.meta_json) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  updateSettings(id: string, userId: string, input: { label: string; agentEnvironment: AgentEnvironment; isActive: boolean }): void {
    this.db
      .prepare("UPDATE platform_accounts SET label = ?, agent_environment = ?, is_active = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(input.label.slice(0, 80), input.agentEnvironment, input.isActive ? 1 : 0, Date.now(), id, userId);
  }

  updateCredentials(
    id: string,
    input: { credentials: Record<string, string>; meta: Record<string, unknown>; externalId: string | null; description: string | null; currency: string | null; canTrade: boolean },
  ): void {
    this.db
      .prepare(
        `UPDATE platform_accounts SET credentials_enc = ?, meta_json = ?, external_id = ?, description = ?, currency = ?, can_trade = ?,
           last_error = NULL, last_error_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(encryptJson(this.key, input.credentials, this.aad(id)), JSON.stringify(input.meta), input.externalId, input.description, input.currency, input.canTrade ? 1 : 0, Date.now(), id);
  }

  saveMeta(id: string, meta: Record<string, unknown>): void {
    this.db.prepare("UPDATE platform_accounts SET meta_json = ? WHERE id = ?").run(JSON.stringify(meta), id);
  }

  setError(id: string, error: string | null): void {
    this.db
      .prepare("UPDATE platform_accounts SET last_error = ?, last_error_at = ? WHERE id = ?")
      .run(error ? error.slice(0, 500) : null, error ? Date.now() : null, id);
  }

  delete(id: string, userId: string): boolean {
    return this.db.prepare("DELETE FROM platform_accounts WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
  }
}

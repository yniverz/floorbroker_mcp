import type { Db } from "../db/app.js";
import { generateToken, parseToken } from "../auth/tokens.js";
import { newId, sha256 } from "../util/crypto.js";

/** Optional per-connection risk limits. Missing fields mean "no limit". */
export interface RiskLimits {
  /** Maximum notional per order, in the instrument's quote currency. */
  maxOrderNotional?: number;
  /** Maximum resulting position notional per instrument, in the instrument's quote currency. */
  maxPositionNotional?: number;
  /** Maximum leverage the agent may set. */
  maxLeverage?: number;
  /** Instrument ids the agent may trade. A trailing * matches a prefix. Empty = all. */
  allowedInstruments?: string[];
}

export interface ConnectionRow {
  id: string;
  user_id: string;
  kind: "oauth" | "token";
  name: string;
  client_id: string | null;
  can_trade: number;
  risk_json: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface Connection extends ConnectionRow {
  risk: RiskLimits;
  accountIds: string[];
}

export interface AccessTokenRow {
  id: string;
  user_id: string;
  connection_id: string;
  client_id: string | null;
  scope: string;
  resource: string | null;
  expires_at: number | null;
  revoked_at: number | null;
}

export interface AuthCodeRow {
  id: string;
  client_id: string;
  user_id: string;
  connection_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  resource: string | null;
  expires_at: number;
  consumed_at: number | null;
}

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  connection_id: string;
  client_id: string;
  access_token_id: string | null;
  scope: string;
  resource: string | null;
  expires_at: number;
  consumed_at: number | null;
  revoked_at: number | null;
}

export function parseRisk(json: string): RiskLimits {
  try {
    const v = JSON.parse(json) as RiskLimits;
    return typeof v === "object" && v ? v : {};
  } catch {
    return {};
  }
}

export class ConnectionRepo {
  constructor(private readonly db: Db) {}

  private hydrate(row: ConnectionRow | undefined): Connection | undefined {
    if (!row) return undefined;
    const accountIds = this.db
      .prepare<[string], { account_id: string }>("SELECT account_id FROM connection_accounts WHERE connection_id = ?")
      .all(row.id)
      .map((r) => r.account_id);
    return { ...row, risk: parseRisk(row.risk_json), accountIds };
  }

  create(input: {
    userId: string;
    kind: "oauth" | "token";
    name: string;
    clientId: string | null;
    canTrade: boolean;
    risk: RiskLimits;
    accountIds: string[];
  }): Connection {
    const id = newId();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO connections (id, user_id, kind, name, client_id, can_trade, risk_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.userId, input.kind, input.name.slice(0, 120), input.clientId, input.canTrade ? 1 : 0, JSON.stringify(input.risk), Date.now());
      this.setAccountsInner(id, input.accountIds);
    })();
    return this.findById(id)!;
  }

  private setAccountsInner(connectionId: string, accountIds: string[]): void {
    this.db.prepare("DELETE FROM connection_accounts WHERE connection_id = ?").run(connectionId);
    const ins = this.db.prepare("INSERT OR IGNORE INTO connection_accounts (connection_id, account_id) VALUES (?, ?)");
    for (const a of accountIds) ins.run(connectionId, a);
  }

  update(id: string, userId: string, input: { name: string; canTrade: boolean; risk: RiskLimits; accountIds: string[] }): void {
    this.db.transaction(() => {
      const r = this.db
        .prepare("UPDATE connections SET name = ?, can_trade = ?, risk_json = ? WHERE id = ? AND user_id = ?")
        .run(input.name.slice(0, 120), input.canTrade ? 1 : 0, JSON.stringify(input.risk), id, userId);
      if (r.changes > 0) this.setAccountsInner(id, input.accountIds);
    })();
  }

  findById(id: string): Connection | undefined {
    return this.hydrate(this.db.prepare<[string], ConnectionRow>("SELECT * FROM connections WHERE id = ?").get(id));
  }

  findActiveForUser(id: string, userId: string): Connection | undefined {
    const c = this.findById(id);
    return c && c.user_id === userId && c.revoked_at === null ? c : undefined;
  }

  listForUser(userId: string): Connection[] {
    return this.db
      .prepare<[string], ConnectionRow>("SELECT * FROM connections WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC")
      .all(userId)
      .map((r) => this.hydrate(r)!);
  }

  markUsed(id: string): void {
    this.db.prepare("UPDATE connections SET last_used_at = ? WHERE id = ?").run(Date.now(), id);
  }

  revoke(id: string, userId?: string): void {
    const now = Date.now();
    this.db.transaction(() => {
      const r = userId
        ? this.db.prepare("UPDATE connections SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(now, id, userId)
        : this.db.prepare("UPDATE connections SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id);
      if (r.changes === 0) return;
      this.db.prepare("UPDATE access_tokens SET revoked_at = ? WHERE connection_id = ? AND revoked_at IS NULL").run(now, id);
      this.db.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE connection_id = ? AND revoked_at IS NULL").run(now, id);
    })();
  }

  /** Removes an account from all of the user's connections (used when an account is deleted). */
  detachAccount(accountId: string): void {
    this.db.prepare("DELETE FROM connection_accounts WHERE account_id = ?").run(accountId);
  }

  // --- tokens ---------------------------------------------------------------

  issueAccessToken(input: {
    userId: string;
    connectionId: string;
    clientId: string | null;
    scope: string;
    resource: string | null;
    ttlMs: number | null;
    kind?: "at" | "pat";
  }): { id: string; value: string } {
    const token = generateToken(input.kind ?? "at");
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO access_tokens (id, prefix, token_hash, user_id, connection_id, client_id, scope, resource, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, token.prefix, token.hash, input.userId, input.connectionId, input.clientId, input.scope, input.resource, now, input.ttlMs ? now + input.ttlMs : null);
    return { id, value: token.value };
  }

  resolveAccessToken(raw: string): AccessTokenRow | undefined {
    const parsed = parseToken(raw);
    if (!parsed || parsed.kind === "rt") return undefined;
    const row = this.db
      .prepare<[string, string], AccessTokenRow>("SELECT * FROM access_tokens WHERE prefix = ? AND token_hash = ?")
      .get(parsed.prefix, parsed.hash);
    if (!row || row.revoked_at !== null) return undefined;
    if (row.expires_at !== null && row.expires_at <= Date.now()) return undefined;
    return row;
  }

  revokeAccessToken(id: string): void {
    this.db.prepare("UPDATE access_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now(), id);
  }

  createAuthCode(input: Omit<AuthCodeRow, "id" | "expires_at" | "consumed_at"> & { ttlMs: number }): string {
    const code = `fbc_${newId().replace(/-/g, "")}${newId().replace(/-/g, "")}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO oauth_auth_codes (id, code_hash, client_id, user_id, connection_id, redirect_uri, scope, code_challenge, resource, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(newId(), sha256(code), input.client_id, input.user_id, input.connection_id, input.redirect_uri, input.scope, input.code_challenge, input.resource, now, now + input.ttlMs);
    return code;
  }

  consumeAuthCode(code: string): { row: AuthCodeRow; replayed: boolean } | null {
    return this.db.transaction(() => {
      const row = this.db.prepare<[string], AuthCodeRow>("SELECT * FROM oauth_auth_codes WHERE code_hash = ?").get(sha256(code));
      if (!row) return null;
      if (row.consumed_at !== null) return { row, replayed: true };
      this.db.prepare("UPDATE oauth_auth_codes SET consumed_at = ? WHERE id = ?").run(Date.now(), row.id);
      return { row, replayed: false };
    })();
  }

  createRefreshToken(input: {
    userId: string;
    connectionId: string;
    clientId: string;
    accessTokenId: string;
    scope: string;
    resource: string | null;
    ttlMs: number;
  }): string {
    const token = generateToken("rt");
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO refresh_tokens (id, prefix, token_hash, user_id, connection_id, client_id, access_token_id, scope, resource, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(newId(), token.prefix, token.hash, input.userId, input.connectionId, input.clientId, input.accessTokenId, input.scope, input.resource, now, now + input.ttlMs);
    return token.value;
  }

  consumeRefreshToken(raw: string): { row: RefreshTokenRow; replayed: boolean } | null {
    const parsed = parseToken(raw);
    if (!parsed || parsed.kind !== "rt") return null;
    return this.db.transaction(() => {
      const row = this.db
        .prepare<[string, string], RefreshTokenRow>("SELECT * FROM refresh_tokens WHERE prefix = ? AND token_hash = ?")
        .get(parsed.prefix, parsed.hash);
      if (!row) return null;
      if (row.revoked_at !== null || row.consumed_at !== null) return { row, replayed: true };
      this.db.prepare("UPDATE refresh_tokens SET consumed_at = ? WHERE id = ?").run(Date.now(), row.id);
      return { row, replayed: false };
    })();
  }

  /** RFC 7009 revocation by raw token value. Returns the connection id it belonged to. */
  revokeByTokenValue(raw: string, clientId: string): void {
    const parsed = parseToken(raw);
    if (!parsed) return;
    const now = Date.now();
    if (parsed.kind === "rt") {
      const row = this.db
        .prepare<[string, string], RefreshTokenRow>("SELECT * FROM refresh_tokens WHERE prefix = ? AND token_hash = ?")
        .get(parsed.prefix, parsed.hash);
      if (row && row.client_id === clientId) {
        this.db.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?").run(now, row.id);
        if (row.access_token_id) this.revokeAccessToken(row.access_token_id);
      }
    } else {
      const row = this.resolveAccessToken(raw);
      if (row && row.client_id === clientId) this.revokeAccessToken(row.id);
    }
  }

  purgeExpired(): void {
    const now = Date.now();
    const week = 7 * 86_400_000;
    this.db.prepare("DELETE FROM oauth_auth_codes WHERE expires_at < ?").run(now - 3_600_000);
    this.db.prepare("DELETE FROM refresh_tokens WHERE expires_at < ? OR revoked_at < ? OR consumed_at < ?").run(now, now - week, now - week);
    this.db.prepare("DELETE FROM access_tokens WHERE (expires_at IS NOT NULL AND expires_at < ?) OR revoked_at < ?").run(now - week, now - week);
  }
}

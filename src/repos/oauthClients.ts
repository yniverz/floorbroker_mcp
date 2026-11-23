import type { Db } from "../db/app.js";
import { randomToken, sha256 } from "../util/crypto.js";

export interface OAuthClientRow {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string;
  redirect_uris: string;
  grant_types: string;
  token_endpoint_auth_method: string;
  client_uri: string | null;
  kind: "dcr" | "cimd";
  is_active: number;
  created_ip: string | null;
  created_at: number;
  refreshed_at: number | null;
  last_used_at: number | null;
}

export class OAuthClientRepo {
  constructor(private readonly db: Db) {}

  count(): number {
    return this.db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM oauth_clients").get()!.c;
  }

  list(): OAuthClientRow[] {
    return this.db.prepare<[], OAuthClientRow>("SELECT * FROM oauth_clients ORDER BY created_at DESC").all();
  }

  find(clientId: string): OAuthClientRow | undefined {
    return this.db.prepare<[string], OAuthClientRow>("SELECT * FROM oauth_clients WHERE client_id = ?").get(clientId);
  }

  findActive(clientId: string): OAuthClientRow | undefined {
    const c = this.find(clientId);
    return c && c.is_active === 1 ? c : undefined;
  }

  redirectUris(c: OAuthClientRow): string[] {
    try {
      return JSON.parse(c.redirect_uris) as string[];
    } catch {
      return [];
    }
  }

  register(input: {
    clientName: string;
    redirectUris: string[];
    grantTypes: string[];
    authMethod: string;
    clientUri: string | null;
    ip: string | null;
  }): { row: OAuthClientRow; clientSecret: string | null } {
    const clientId = `fbcl_${randomToken(18)}`;
    const clientSecret = input.authMethod === "none" ? null : randomToken(32);
    this.db
      .prepare(
        `INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, token_endpoint_auth_method, client_uri, kind, created_ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'dcr', ?, ?)`,
      )
      .run(
        clientId,
        clientSecret ? sha256(clientSecret) : null,
        input.clientName.slice(0, 200),
        JSON.stringify(input.redirectUris),
        JSON.stringify(input.grantTypes),
        input.authMethod,
        input.clientUri,
        input.ip,
        Date.now(),
      );
    return { row: this.find(clientId)!, clientSecret };
  }

  /** Inserts or refreshes a client described by a Client ID Metadata Document. */
  upsertCimd(input: { clientId: string; clientName: string; redirectUris: string[]; clientUri: string | null }): OAuthClientRow {
    const existing = this.find(input.clientId);
    const now = Date.now();
    if (existing) {
      this.db
        .prepare("UPDATE oauth_clients SET client_name = ?, redirect_uris = ?, client_uri = ?, refreshed_at = ? WHERE client_id = ?")
        .run(input.clientName.slice(0, 200), JSON.stringify(input.redirectUris), input.clientUri, now, input.clientId);
    } else {
      this.db
        .prepare(
          `INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, token_endpoint_auth_method, client_uri, kind, created_at, refreshed_at)
           VALUES (?, NULL, ?, ?, '["authorization_code","refresh_token"]', 'none', ?, 'cimd', ?, ?)`,
        )
        .run(input.clientId, input.clientName.slice(0, 200), JSON.stringify(input.redirectUris), input.clientUri, now, now);
    }
    return this.find(input.clientId)!;
  }

  markUsed(clientId: string): void {
    this.db.prepare("UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?").run(Date.now(), clientId);
  }

  setActive(clientId: string, active: boolean): void {
    this.db.prepare("UPDATE oauth_clients SET is_active = ? WHERE client_id = ?").run(active ? 1 : 0, clientId);
  }

  delete(clientId: string): void {
    this.db.prepare("DELETE FROM oauth_clients WHERE client_id = ?").run(clientId);
  }

  /** Drops registrations that were never used, oldest first. */
  pruneUnused(olderThanMs: number): void {
    this.db
      .prepare(
        `DELETE FROM oauth_clients WHERE last_used_at IS NULL AND created_at < ?
           AND client_id NOT IN (SELECT DISTINCT client_id FROM connections WHERE client_id IS NOT NULL)`,
      )
      .run(Date.now() - olderThanMs);
  }
}

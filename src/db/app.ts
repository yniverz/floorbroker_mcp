import Database from "better-sqlite3";

export type Db = Database.Database;

/**
 * Application database: users, credentials, agent connections, OAuth state,
 * the tool-call log and PnL history. Small and important, so this is the file to back up.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','user')),
    is_active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE TABLE web_sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_secret TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    absolute_exp INTEGER NOT NULL,
    revoked_at INTEGER
  );

  CREATE TABLE platform_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    label TEXT NOT NULL,
    environment TEXT NOT NULL,
    agent_environment TEXT NOT NULL CHECK (agent_environment IN ('live','demo')),
    credentials_enc TEXT NOT NULL,
    meta_json TEXT NOT NULL DEFAULT '{}',
    external_id TEXT,
    description TEXT,
    currency TEXT,
    can_trade INTEGER NOT NULL DEFAULT 1,
    is_active INTEGER NOT NULL DEFAULT 1,
    last_error TEXT,
    last_error_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_platform_accounts_user ON platform_accounts(user_id);

  CREATE TABLE oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_secret_hash TEXT,
    client_name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    grant_types TEXT NOT NULL,
    token_endpoint_auth_method TEXT NOT NULL,
    client_uri TEXT,
    kind TEXT NOT NULL DEFAULT 'dcr' CHECK (kind IN ('dcr','cimd')),
    is_active INTEGER NOT NULL DEFAULT 1,
    created_ip TEXT,
    created_at INTEGER NOT NULL,
    refreshed_at INTEGER,
    last_used_at INTEGER
  );

  -- An agent connection is one authorized agent: an OAuth grant or a personal token.
  -- It decides which platform accounts the agent sees, whether it may trade, and its risk limits.
  CREATE TABLE connections (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('oauth','token')),
    name TEXT NOT NULL,
    client_id TEXT,
    can_trade INTEGER NOT NULL DEFAULT 0,
    risk_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX idx_connections_user ON connections(user_id);

  CREATE TABLE connection_accounts (
    connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
    PRIMARY KEY (connection_id, account_id)
  );

  CREATE TABLE oauth_auth_codes (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    scope TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    resource TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
  );

  CREATE TABLE access_tokens (
    id TEXT PRIMARY KEY,
    prefix TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    client_id TEXT,
    scope TEXT NOT NULL,
    resource TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX idx_access_tokens_lookup ON access_tokens(prefix);

  CREATE TABLE refresh_tokens (
    id TEXT PRIMARY KEY,
    prefix TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    access_token_id TEXT,
    scope TEXT NOT NULL,
    resource TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX idx_refresh_tokens_lookup ON refresh_tokens(prefix);

  CREATE TABLE tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    connection_id TEXT,
    account_id TEXT,
    tool TEXT NOT NULL,
    is_trade INTEGER NOT NULL DEFAULT 0,
    args_json TEXT NOT NULL,
    result_json TEXT,
    ok INTEGER NOT NULL,
    error TEXT,
    duration_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_tool_calls_user_time ON tool_calls(user_id, created_at);
  CREATE INDEX idx_tool_calls_account_time ON tool_calls(account_id, created_at);

  -- Orders the agent placed, so fills and closed PnL can be attributed to agents.
  CREATE TABLE agent_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
    connection_id TEXT,
    order_id TEXT NOT NULL,
    instrument_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (account_id, order_id)
  );

  CREATE TABLE equity_snapshots (
    account_id TEXT NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    currency TEXT NOT NULL,
    equity REAL NOT NULL,
    balance REAL,
    unrealized_pnl REAL,
    positions INTEGER,
    PRIMARY KEY (account_id, ts)
  );

  CREATE TABLE closed_pnl (
    account_id TEXT NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
    record_id TEXT NOT NULL,
    instrument_id TEXT NOT NULL,
    side TEXT,
    size REAL,
    entry_price REAL,
    exit_price REAL,
    pnl REAL NOT NULL,
    currency TEXT,
    order_id TEXT,
    closed_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, record_id)
  );
  CREATE INDEX idx_closed_pnl_time ON closed_pnl(account_id, closed_at);

  CREATE TABLE sync_state (
    account_id TEXT NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (account_id, key)
  );

  CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    action TEXT NOT NULL,
    detail_json TEXT,
    ip TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_audit_time ON audit_events(created_at);
  `,
];

export function openAppDb(file: string): Db {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  migrate(db, MIGRATIONS);
  return db;
}

export function migrate(db: Db, migrations: string[]): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let i = current; i < migrations.length; i++) {
    db.transaction(() => {
      db.exec(migrations[i]!);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}

import Database from "better-sqlite3";
import { migrate, type Db } from "./app.js";

/**
 * Market data cache, shared by all users. Historic candles never change, so each
 * range is fetched from a platform once. This file can grow large but can always
 * be rebuilt; it does not need to be backed up and may be deleted at any time.
 *
 * market_key separates data sources whose prices differ, e.g. "ig:demo" vs "ig:live".
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE candles (
    market_key TEXT NOT NULL,
    instrument_id TEXT NOT NULL,
    resolution TEXT NOT NULL,
    t INTEGER NOT NULL,
    o REAL NOT NULL,
    h REAL NOT NULL,
    l REAL NOT NULL,
    c REAL NOT NULL,
    v REAL,
    spread REAL,
    PRIMARY KEY (market_key, instrument_id, resolution, t)
  ) WITHOUT ROWID;

  -- Time ranges [from_ts, to_ts) that are completely stored (all finished candles present).
  CREATE TABLE coverage (
    market_key TEXT NOT NULL,
    instrument_id TEXT NOT NULL,
    resolution TEXT NOT NULL,
    from_ts INTEGER NOT NULL,
    to_ts INTEGER NOT NULL,
    PRIMARY KEY (market_key, instrument_id, resolution, from_ts)
  ) WITHOUT ROWID;

  CREATE TABLE quota_state (
    quota_key TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
];

export function openMarketDb(file: string): Db {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  migrate(db, MIGRATIONS);
  return db;
}

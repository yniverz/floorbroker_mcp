import type { Db } from "../db/app.js";
import type { ClosedPnl } from "../platforms/types.js";

export interface SnapshotRow {
  account_id: string;
  ts: number;
  currency: string;
  equity: number;
  balance: number | null;
  unrealized_pnl: number | null;
  positions: number | null;
}

export interface ClosedPnlRow {
  account_id: string;
  record_id: string;
  instrument_id: string;
  side: string | null;
  size: number | null;
  entry_price: number | null;
  exit_price: number | null;
  pnl: number;
  currency: string | null;
  order_id: string | null;
  closed_at: number;
}

export class PnlRepo {
  constructor(private readonly db: Db) {}

  addSnapshot(s: SnapshotRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO equity_snapshots (account_id, ts, currency, equity, balance, unrealized_pnl, positions)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.account_id, s.ts, s.currency, s.equity, s.balance, s.unrealized_pnl, s.positions);
  }

  latestSnapshot(accountId: string): SnapshotRow | undefined {
    return this.db
      .prepare<[string], SnapshotRow>("SELECT * FROM equity_snapshots WHERE account_id = ? ORDER BY ts DESC LIMIT 1")
      .get(accountId);
  }

  snapshotAtOrBefore(accountId: string, ts: number): SnapshotRow | undefined {
    return this.db
      .prepare<[string, number], SnapshotRow>("SELECT * FROM equity_snapshots WHERE account_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1")
      .get(accountId, ts);
  }

  /** Snapshots in a range, thinned to at most ~maxPoints by bucketing (last value per bucket). */
  snapshots(accountId: string, from: number, to: number, maxPoints = 400): SnapshotRow[] {
    const bucket = Math.max(1, Math.floor((to - from) / maxPoints));
    return this.db
      .prepare<[string, number, number, number], SnapshotRow>(
        // SQLite returns the bare columns from the row holding MAX(ts) within each bucket.
        `SELECT account_id, MAX(ts) AS ts, currency, equity, balance, unrealized_pnl, positions
           FROM equity_snapshots WHERE account_id = ? AND ts >= ? AND ts <= ?
          GROUP BY ts / ? ORDER BY ts`,
      )
      .all(accountId, from, to, bucket);
  }

  upsertClosedPnl(accountId: string, rows: ClosedPnl[]): number {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO closed_pnl (account_id, record_id, instrument_id, side, size, entry_price, exit_price, pnl, currency, order_id, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    this.db.transaction(() => {
      for (const r of rows) {
        inserted += stmt.run(accountId, r.id, r.instrumentId, r.side, r.size, r.entryPrice, r.exitPrice, r.pnl, r.currency, r.orderId, r.closedAt).changes;
      }
    })();
    return inserted;
  }

  closedPnl(accountId: string, from: number, to: number, limit = 500): ClosedPnlRow[] {
    return this.db
      .prepare<[string, number, number, number], ClosedPnlRow>(
        "SELECT * FROM closed_pnl WHERE account_id = ? AND closed_at >= ? AND closed_at <= ? ORDER BY closed_at DESC LIMIT ?",
      )
      .all(accountId, from, to, limit);
  }

  realizedSum(accountId: string, from: number, to: number): { pnl: number; trades: number; wins: number } {
    return this.db
      .prepare<[string, number, number], { pnl: number; trades: number; wins: number }>(
        `SELECT COALESCE(SUM(pnl), 0) AS pnl, COUNT(*) AS trades, COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0) AS wins
           FROM closed_pnl WHERE account_id = ? AND closed_at >= ? AND closed_at <= ?`,
      )
      .get(accountId, from, to)!;
  }

  /** Daily realized PnL buckets (UTC days). */
  realizedDaily(accountId: string, from: number, to: number): { day: number; pnl: number }[] {
    return this.db
      .prepare<[string, number, number], { day: number; pnl: number }>(
        `SELECT (closed_at / 86400000) * 86400000 AS day, SUM(pnl) AS pnl
           FROM closed_pnl WHERE account_id = ? AND closed_at >= ? AND closed_at <= ?
          GROUP BY day ORDER BY day`,
      )
      .all(accountId, from, to);
  }

  getSyncState(accountId: string, key: string): string | null {
    return (
      this.db.prepare<[string, string], { value: string }>("SELECT value FROM sync_state WHERE account_id = ? AND key = ?").get(accountId, key)?.value ?? null
    );
  }

  setSyncState(accountId: string, key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO sync_state (account_id, key, value) VALUES (?, ?, ?)").run(accountId, key, value);
  }
}

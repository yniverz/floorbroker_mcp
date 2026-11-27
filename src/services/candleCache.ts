import type { Db } from "../db/app.js";
import { PlatformError } from "../platforms/errors.js";
import { RESOLUTION_MS, type Candle, type DataQuota, type PlatformClient, type Resolution } from "../platforms/types.js";

export interface CandleRequest {
  instrumentId: string;
  resolution: Resolution;
  from?: number;
  to?: number;
  limit: number;
  /** Only return what is already stored; never call the platform. */
  cacheOnly?: boolean;
}

export interface CandleResponse {
  candles: Candle[];
  from: number;
  to: number;
  stats: { fromCache: number; fetched: number; requests: number; truncated: boolean };
  quota: DataQuota | null;
}

export interface CoverageRow {
  market_key: string;
  instrument_id: string;
  resolution: string;
  from_ts: number;
  to_ts: number;
}

/** Hard cap on candles fetched from a platform per tool call, to protect quotas. */
const MAX_FETCH_PER_CALL = 5000;

/**
 * Read-through cache for historic candles. Coverage ranges record which [from, to)
 * windows are fully stored. Unfinished (still forming) candles are returned but never stored.
 */
export class CandleCache {
  private inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly db: Db) {}

  async get(client: PlatformClient, req: CandleRequest): Promise<CandleResponse> {
    const step = RESOLUTION_MS[req.resolution];
    const now = Date.now();
    let to = Math.min(req.to ?? now, now);
    let from = req.from ?? to - req.limit * step;
    if (from >= to) throw new PlatformError("invalid_request", "`from` must be before `to`.");
    // Do not let a single request span an absurd number of candles.
    if ((to - from) / step > req.limit) {
      if (req.from !== undefined && req.to === undefined) to = Math.min(now, from + req.limit * step);
      else from = to - req.limit * step;
    }
    // Align to candle boundaries (exact for intraday and daily candles in UTC), after applying the limit.
    if (step <= RESOLUTION_MS["1d"]) from = Math.floor(from / step) * step;

    const key = client.marketDataKey();
    const missing = req.cacheOnly ? [] : this.missingRanges(key, req.instrumentId, req.resolution, from, to);
    let fetched = 0;
    let requests = 0;
    let quota: DataQuota | null = null;
    let truncated = false;
    const live: Candle[] = [];

    for (const [a, b] of missing) {
      if (fetched >= MAX_FETCH_PER_CALL) {
        truncated = true;
        break;
      }
      // Serialize identical fetches so two agents do not spend quota twice.
      const lockKey = `${key}|${req.instrumentId}|${req.resolution}|${a}|${b}`;
      const prior = this.inflight.get(lockKey);
      if (prior) {
        await prior.catch(() => undefined);
        continue;
      }
      const job = (async () => {
        const res = await client.fetchCandles({ instrumentId: req.instrumentId, resolution: req.resolution, from: a, to: b });
        requests++;
        if (res.quota) quota = res.quota;
        // A candle is finished once its full period has elapsed.
        const finished = res.candles.filter((c) => c.t + step <= now && c.t >= a && c.t < b);
        const unfinished = res.candles.filter((c) => c.t + step > now && c.t >= a && c.t < b);
        fetched += res.candles.length;
        live.push(...unfinished);
        this.store(key, req.instrumentId, req.resolution, finished);
        // Coverage extends up to the first unfinished period, never beyond "now - step".
        const coverEnd = Math.min(b, unfinished.length > 0 ? Math.min(...unfinished.map((c) => c.t)) : b, now - step);
        if (coverEnd > a) this.addCoverage(key, req.instrumentId, req.resolution, a, coverEnd);
      })();
      this.inflight.set(lockKey, job);
      try {
        await job;
      } finally {
        this.inflight.delete(lockKey);
      }
    }

    const stored = this.read(key, req.instrumentId, req.resolution, from, to);
    const byTime = new Map<number, Candle>();
    for (const c of stored) byTime.set(c.t, c);
    for (const c of live) byTime.set(c.t, c);
    const candles = [...byTime.values()].sort((x, y) => x.t - y.t);
    const tail = candles.length > req.limit ? candles.slice(candles.length - req.limit) : candles;

    return {
      candles: tail,
      from,
      to,
      stats: { fromCache: Math.max(0, tail.length - Math.min(fetched, tail.length)), fetched, requests, truncated },
      quota,
    };
  }

  missingRanges(key: string, instrumentId: string, resolution: string, from: number, to: number): [number, number][] {
    const cov = this.db
      .prepare<[string, string, string, number, number], { from_ts: number; to_ts: number }>(
        `SELECT from_ts, to_ts FROM coverage WHERE market_key = ? AND instrument_id = ? AND resolution = ?
           AND to_ts > ? AND from_ts < ? ORDER BY from_ts`,
      )
      .all(key, instrumentId, resolution, from, to);
    const out: [number, number][] = [];
    let cursor = from;
    for (const r of cov) {
      if (r.from_ts > cursor) out.push([cursor, r.from_ts]);
      cursor = Math.max(cursor, r.to_ts);
    }
    if (cursor < to) out.push([cursor, to]);
    return out.filter(([a, b]) => b > a);
  }

  /** Stores one completed candle from a live stream and marks its period as covered. */
  storeStreamCandle(key: string, instrumentId: string, resolution: Resolution, candle: Candle): void {
    const step = RESOLUTION_MS[resolution];
    if (candle.t + step > Date.now() + 5_000) return; // not finished yet
    this.store(key, instrumentId, resolution, [candle]);
    this.addCoverage(key, instrumentId, resolution, candle.t, candle.t + step);
  }

  private store(key: string, instrumentId: string, resolution: string, candles: Candle[]): void {
    if (candles.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO candles (market_key, instrument_id, resolution, t, o, h, l, c, v, spread)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const c of candles) stmt.run(key, instrumentId, resolution, c.t, c.o, c.h, c.l, c.c, c.v, c.spread);
    })();
  }

  private addCoverage(key: string, instrumentId: string, resolution: string, from: number, to: number): void {
    this.db.transaction(() => {
      const overlapping = this.db
        .prepare<[string, string, string, number, number], { from_ts: number; to_ts: number }>(
          `SELECT from_ts, to_ts FROM coverage WHERE market_key = ? AND instrument_id = ? AND resolution = ?
             AND to_ts >= ? AND from_ts <= ?`,
        )
        .all(key, instrumentId, resolution, from, to);
      let a = from;
      let b = to;
      for (const r of overlapping) {
        a = Math.min(a, r.from_ts);
        b = Math.max(b, r.to_ts);
      }
      this.db
        .prepare(
          "DELETE FROM coverage WHERE market_key = ? AND instrument_id = ? AND resolution = ? AND to_ts >= ? AND from_ts <= ?",
        )
        .run(key, instrumentId, resolution, from, to);
      this.db
        .prepare("INSERT OR REPLACE INTO coverage (market_key, instrument_id, resolution, from_ts, to_ts) VALUES (?, ?, ?, ?, ?)")
        .run(key, instrumentId, resolution, a, b);
    })();
  }

  private read(key: string, instrumentId: string, resolution: string, from: number, to: number): Candle[] {
    return this.db
      .prepare<[string, string, string, number, number], Candle>(
        `SELECT t, o, h, l, c, v, spread FROM candles WHERE market_key = ? AND instrument_id = ? AND resolution = ?
           AND t >= ? AND t < ? ORDER BY t`,
      )
      .all(key, instrumentId, resolution, from, to);
  }

  /** What is stored locally, for the list_cached_candles tool. */
  coverage(key: string, instrumentId?: string): (CoverageRow & { candles: number })[] {
    const rows = instrumentId
      ? this.db
          .prepare<[string, string], CoverageRow>("SELECT * FROM coverage WHERE market_key = ? AND instrument_id = ? ORDER BY instrument_id, resolution, from_ts")
          .all(key, instrumentId)
      : this.db.prepare<[string], CoverageRow>("SELECT * FROM coverage WHERE market_key = ? ORDER BY instrument_id, resolution, from_ts").all(key);
    const countStmt = this.db.prepare<[string, string, string, number, number], { n: number }>(
      "SELECT COUNT(*) AS n FROM candles WHERE market_key = ? AND instrument_id = ? AND resolution = ? AND t >= ? AND t < ?",
    );
    return rows.map((r) => ({ ...r, candles: countStmt.get(r.market_key, r.instrument_id, r.resolution, r.from_ts, r.to_ts)!.n }));
  }

  stats(): { candles: number; series: number } {
    const candles = this.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM candles").get()!.n;
    const series = this.db
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM (SELECT DISTINCT market_key, instrument_id, resolution FROM coverage)")
      .get()!.n;
    return { candles, series };
  }
}

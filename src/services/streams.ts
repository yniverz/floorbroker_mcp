import { logger } from "../logger.js";
import { PlatformError } from "../platforms/errors.js";
import { RESOLUTION_MS, type AccountEvent, type Candle, type CandleUpdate, type PlatformStream, type Resolution, type StreamStatus, type Tick, type Unsubscribe } from "../platforms/types.js";
import type { AccountRepo, PlatformAccountRow } from "../repos/accounts.js";
import type { AccountService } from "./accountService.js";
import type { CandleCache } from "./candleCache.js";

/** Aggregation is only done for intraday resolutions, where UTC bucketing matches the platforms' own candles. */
const MAX_AGGREGATED_MS = RESOLUTION_MS["12h"];

type Attach = (stream: PlatformStream, row: PlatformAccountRow) => Unsubscribe;

interface Subscription {
  accountId: string;
  attach: Attach;
  detach: Unsubscribe | null;
  stream: PlatformStream | null;
}

/**
 * Live data for the rest of floorbroker (later: the strategy runtime).
 * - One platform stream per account (owned by the account's client), shared by all subscribers.
 * - Completed candles go into the candle cache, so streamed history is free (and IG's
 *   weekly data allowance is not touched).
 * - Resolutions a platform cannot stream natively are aggregated from a smaller one.
 * - When an account's client is replaced (new credentials, settings change), all
 *   subscriptions move to the new client automatically.
 */
export class StreamService {
  private readonly subs = new Set<Subscription>();

  constructor(
    private readonly accounts: AccountRepo,
    private readonly service: AccountService,
    private readonly candles: CandleCache,
  ) {
    service.onClientReplaced((accountId) => this.reattach(accountId));
  }

  ticks(accountId: string, instrumentId: string, cb: (t: Tick) => void): Unsubscribe {
    return this.subscribe(accountId, (stream) => stream.subscribeTicks(instrumentId, cb));
  }

  candleStream(accountId: string, instrumentId: string, resolution: Resolution, cb: (c: CandleUpdate) => void): Unsubscribe {
    return this.subscribe(accountId, (stream, row) => {
      const key = this.service.client(row).marketDataKey();
      if (stream.candleResolutions.includes(resolution)) {
        return stream.subscribeCandles(instrumentId, resolution, (u) => {
          if (u.final) this.persist(key, u);
          cb(u);
        });
      }
      const base = baseResolution(stream.candleResolutions, resolution);
      if (!base) {
        throw new PlatformError(
          "unsupported",
          `Live ${resolution} candles are not available on this platform (it streams ${stream.candleResolutions.join(", ")}).`,
        );
      }
      const agg = new Aggregator(instrumentId, resolution, base, cb);
      return stream.subscribeCandles(instrumentId, base, (u) => {
        if (u.final) this.persist(key, u);
        agg.push(u);
      });
    });
  }

  accountEvents(accountId: string, cb: (e: AccountEvent) => void): Unsubscribe {
    return this.subscribe(accountId, (stream) => {
      if (!stream.subscribeAccount) throw new PlatformError("unsupported", "This platform does not stream account events.");
      return stream.subscribeAccount(cb);
    });
  }

  /** Status of an account's stream, or null if it has never been used. */
  status(accountId: string): StreamStatus | null {
    const client = this.service.peek(accountId);
    if (!client?.stream || ![...this.subs].some((s) => s.accountId === accountId)) return null;
    return client.stream().status();
  }

  async closeAll(): Promise<void> {
    for (const s of this.subs) s.detach?.();
    this.subs.clear();
  }

  // ----------------------------------------------------------------------------

  private subscribe(accountId: string, attach: Attach): Unsubscribe {
    const sub: Subscription = { accountId, attach, detach: null, stream: null };
    this.connect(sub); // throws for unknown/inactive accounts and unsupported requests
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
      sub.detach?.();
      sub.detach = null;
    };
  }

  private connect(sub: Subscription): void {
    const row = this.accounts.findById(sub.accountId);
    if (!row || row.is_active !== 1) throw new PlatformError("not_found", "Account not found or disabled.");
    const client = this.service.client(row);
    if (!client.stream) throw new PlatformError("unsupported", `${row.platform} has no live data stream.`);
    const stream = client.stream();
    sub.detach = sub.attach(stream, row);
    sub.stream = stream;
  }

  private reattach(accountId: string): void {
    for (const sub of this.subs) {
      if (sub.accountId !== accountId) continue;
      sub.detach?.();
      sub.detach = null;
      try {
        this.connect(sub);
      } catch (err) {
        // Account disabled or removed: the subscription stays dormant until the caller unsubscribes.
        logger.warn("stream subscription could not be moved to the new client", { accountId, err: String(err) });
      }
    }
  }

  private persist(key: string, u: CandleUpdate): void {
    try {
      this.candles.storeStreamCandle(key, u.instrumentId, u.resolution, u.candle);
    } catch (err) {
      logger.warn("could not store streamed candle", { err: String(err) });
    }
  }
}

/** Largest native resolution that divides the target (e.g. 15m from 5m, 4h from 1h). */
export function baseResolution(native: Resolution[], target: Resolution): Resolution | null {
  const t = RESOLUTION_MS[target];
  if (t > MAX_AGGREGATED_MS) return null;
  const options = native.filter((r) => RESOLUTION_MS[r] < t && t % RESOLUTION_MS[r] === 0).sort((a, b) => RESOLUTION_MS[b] - RESOLUTION_MS[a]);
  return options[0] ?? null;
}

/** Builds target-resolution candles (UTC-aligned) from base-resolution updates. */
export class Aggregator {
  private bucket = -1;
  private readonly parts = new Map<number, Candle>();
  private readonly step: number;
  private readonly baseStep: number;

  constructor(
    private readonly instrumentId: string,
    private readonly resolution: Resolution,
    base: Resolution,
    private readonly emit: (c: CandleUpdate) => void,
  ) {
    this.step = RESOLUTION_MS[resolution];
    this.baseStep = RESOLUTION_MS[base];
  }

  push(u: CandleUpdate): void {
    const bucket = Math.floor(u.candle.t / this.step) * this.step;
    if (bucket < this.bucket) return; // late update for an already emitted bucket
    if (bucket !== this.bucket) {
      this.bucket = bucket;
      this.parts.clear();
    }
    this.parts.set(u.candle.t, u.candle);
    const sorted = [...this.parts.values()].sort((a, b) => a.t - b.t);
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const volumes = sorted.map((c) => c.v).filter((v): v is number => v !== null);
    const candle: Candle = {
      t: bucket,
      o: first.o,
      h: Math.max(...sorted.map((c) => c.h)),
      l: Math.min(...sorted.map((c) => c.l)),
      c: last.c,
      v: volumes.length ? volumes.reduce((s, v) => s + v, 0) : null,
      spread: last.spread,
    };
    // The aggregate is final when the base candle that closes the bucket is final.
    const final = u.final && u.candle.t + this.baseStep >= bucket + this.step;
    this.emit({ instrumentId: this.instrumentId, resolution: this.resolution, candle, final });
  }
}

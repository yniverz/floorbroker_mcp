import { logger } from "../../logger.js";
import { StatusTracker, Topics } from "../streamKit.js";
import type { AccountEvent, CandleUpdate, Fill, Order, PlatformStream, Position, Resolution, StreamStatus, Tick, Unsubscribe } from "../types.js";
import { LightstreamerClient, type LsCredentials } from "./lightstreamer.js";
import { epicSymbol, parseIgUtc, toCandle } from "./mappers.js";

/** IG streams candles natively only at these scales. */
const CHART_SCALES: Partial<Record<Resolution, string>> = { "1m": "1MINUTE", "5m": "5MINUTE", "1h": "HOUR" };

const CHART_FIELDS = [
  "UTM",
  "BID_OPEN", "BID_HIGH", "BID_LOW", "BID_CLOSE",
  "OFR_OPEN", "OFR_HIGH", "OFR_LOW", "OFR_CLOSE",
  "LTP_OPEN", "LTP_HIGH", "LTP_LOW", "LTP_CLOSE",
  "LTV", "CONS_END",
];

const n = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

export class IgStream implements PlatformStream {
  readonly candleResolutions = Object.keys(CHART_SCALES) as Resolution[];

  private readonly ls: LightstreamerClient;
  private readonly ticks = new Topics<Tick>();
  private readonly candles = new Topics<CandleUpdate>();
  private readonly account = new Topics<AccountEvent>();
  private readonly tables = new Map<string, number>();

  constructor(name: string, credentials: (fresh: boolean) => Promise<LsCredentials>) {
    this.ls = new LightstreamerClient(name, credentials);
  }

  subscribeTicks(epic: string, cb: (t: Tick) => void): Unsubscribe {
    const topic = `MARKET:${epic}`;
    return this.ticks.add(
      topic,
      cb,
      () =>
        // IG serves live prices as PRICE:<accountId>:<epic> via the "Pricing" adapter
        // (the older MARKET:<epic> items answer "ERROR 21 Invalid group" on this API).
        this.open(topic, {
          mode: "MERGE",
          adapter: "Pricing",
          items: (accountId) => [`PRICE:${accountId}:${epic}`],
          fields: ["BIDPRICE1", "ASKPRICE1", "TIMESTAMP"],
          onUpdate: (_i, v) =>
            this.ticks.emit(topic, { instrumentId: epic, time: n(v.TIMESTAMP) ?? Date.now(), bid: n(v.BIDPRICE1), ask: n(v.ASKPRICE1), last: null }),
        }),
      () => this.close1(topic),
    );
  }

  subscribeCandles(epic: string, resolution: Resolution, cb: (c: CandleUpdate) => void): Unsubscribe {
    const scale = CHART_SCALES[resolution];
    if (!scale) throw new Error(`IG streams only ${this.candleResolutions.join(", ")} candles.`);
    const topic = `CHART:${epic}:${scale}`;
    return this.candles.add(
      topic,
      cb,
      () =>
        this.open(topic, {
          mode: "MERGE",
          items: () => [topic],
          fields: CHART_FIELDS,
          onUpdate: (_i, v) => {
            const utm = n(v.UTM);
            if (utm === null) return;
            const candle = toCandle({
              snapshotTimeUTC: new Date(utm).toISOString(),
              openPrice: { bid: n(v.BID_OPEN), ask: n(v.OFR_OPEN), lastTraded: n(v.LTP_OPEN) },
              highPrice: { bid: n(v.BID_HIGH), ask: n(v.OFR_HIGH), lastTraded: n(v.LTP_HIGH) },
              lowPrice: { bid: n(v.BID_LOW), ask: n(v.OFR_LOW), lastTraded: n(v.LTP_LOW) },
              closePrice: { bid: n(v.BID_CLOSE), ask: n(v.OFR_CLOSE), lastTraded: n(v.LTP_CLOSE) },
              lastTradedVolume: n(v.LTV),
            });
            if (!candle) return;
            // CONS_END = 1 marks the last update of a completed candle.
            this.candles.emit(topic, { instrumentId: epic, resolution, candle, final: v.CONS_END === "1" });
          },
        }),
      () => this.close1(topic),
    );
  }

  subscribeAccount(cb: (e: AccountEvent) => void): Unsubscribe {
    const topic = "TRADE";
    return this.account.add(
      topic,
      cb,
      () =>
        this.open(topic, {
          mode: "DISTINCT",
          items: (accountId) => [`TRADE:${accountId}`],
          fields: ["CONFIRMS", "OPU", "WOU"],
          onUpdate: (_i, v) => this.onTrade(v),
        }),
      () => this.close1(topic),
    );
  }

  status(): StreamStatus {
    const subs = [
      ...this.ticks.keys().map((k) => `ticks ${k.slice("MARKET:".length)}`),
      ...this.candles.keys().map((k) => {
        const [, epic, scale] = k.split(":");
        const res = Object.entries(CHART_SCALES).find(([, s]) => s === scale)?.[0] ?? scale;
        return `candles ${res} ${epic}`;
      }),
      ...(this.account.size ? ["account events"] : []),
    ];
    return this.ls.tableCount ? this.ls.status.snapshot(subs) : new StatusTracker().snapshot(subs);
  }

  async close(): Promise<void> {
    this.ls.stop();
  }

  private open(topic: string, spec: Parameters<LightstreamerClient["add"]>[0]): void {
    this.tables.set(topic, this.ls.add({ ...spec, onError: (m) => logger.warn("IG subscription error", { topic, err: m }) }));
  }

  private close1(topic: string): void {
    const id = this.tables.get(topic);
    this.tables.delete(topic);
    if (id !== undefined) this.ls.remove(id);
  }

  // --- TRADE:<account> → orders, fills, positions ----------------------------

  private onTrade(v: Record<string, string | null>): void {
    for (const [field, raw] of Object.entries(v)) {
      if (!raw) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      try {
        if (field === "OPU") this.onOpu(msg);
        else if (field === "WOU") this.onWou(msg);
        else if (field === "CONFIRMS") this.onConfirm(msg);
      } catch (err) {
        logger.warn("IG trade event could not be mapped", { field, err: String(err) });
      }
    }
  }

  private onOpu(m: Record<string, unknown>): void {
    const epic = String(m.epic ?? "");
    const dealId = String(m.dealId ?? "");
    const buy = m.direction === "BUY";
    const status = String(m.status ?? "");
    const time = parseIgUtc(m.timestamp) ?? Date.now();
    const size = Number(m.size ?? 0);
    const level = n(m.level as string | null);
    const position: Position = {
      id: dealId,
      instrumentId: epic,
      symbol: epicSymbol(epic),
      side: buy ? "long" : "short",
      size,
      entryPrice: status === "OPEN" ? level : null,
      markPrice: null,
      unrealizedPnl: null,
      realizedPnl: null,
      currency: typeof m.currency === "string" ? m.currency : null,
      leverage: null,
      margin: null,
      liquidationPrice: null,
      stopLoss: n(m.stopLevel as string | null),
      takeProfit: n(m.limitLevel as string | null),
      trailingStop: null,
      openedAt: status === "OPEN" ? time : null,
      extra: { igStatus: status, dealReference: m.dealReference ?? null },
    };
    const closed = status === "DELETED";
    this.account.emit("TRADE", { type: "position", position, closed });
    if ((status === "OPEN" || closed) && level !== null) {
      // An opening deal buys/sells in its direction; closing trades the opposite way at the close level.
      const fill: Fill = {
        id: `${dealId}:${closed ? "close" : "open"}`,
        orderId: typeof m.dealReference === "string" ? m.dealReference : dealId,
        instrumentId: epic,
        symbol: epicSymbol(epic),
        side: closed ? (buy ? "sell" : "buy") : buy ? "buy" : "sell",
        size,
        price: level,
        fee: null,
        feeCurrency: null,
        realizedPnl: null,
        isMaker: null,
        time,
      };
      this.account.emit("TRADE", { type: "fill", fill });
    }
  }

  private onWou(m: Record<string, unknown>): void {
    const epic = String(m.epic ?? "");
    const status = String(m.status ?? "");
    const type = m.orderType === "STOP" ? "stop" : "limit";
    const level = n(m.level as string | null);
    const order: Order = {
      id: String(m.dealId ?? ""),
      clientOrderId: typeof m.dealReference === "string" ? m.dealReference : null,
      instrumentId: epic,
      symbol: epicSymbol(epic),
      side: m.direction === "BUY" ? "buy" : "sell",
      type,
      // DELETED covers both "filled" and "cancelled"; a fill also arrives as an OPU OPEN.
      status: status === "DELETED" ? "unknown" : "open",
      size: Number(m.size ?? 0),
      filledSize: null,
      price: type === "limit" ? level : null,
      triggerPrice: type === "stop" ? level : null,
      avgFillPrice: null,
      timeInForce: m.timeInForce === "GOOD_TILL_DATE" ? null : "gtc",
      reduceOnly: null,
      stopLoss: n(m.stopLevel as string | null),
      takeProfit: n(m.limitLevel as string | null),
      createdAt: parseIgUtc(m.timestamp),
      updatedAt: Date.now(),
      rejectReason: null,
      extra: { igStatus: status },
    };
    this.account.emit("TRADE", { type: "order", order });
  }

  private onConfirm(m: Record<string, unknown>): void {
    if (m.dealStatus !== "REJECTED") return; // accepted deals arrive as OPU/WOU
    const epic = String(m.epic ?? "");
    const order: Order = {
      id: String(m.dealId ?? m.dealReference ?? ""),
      clientOrderId: typeof m.dealReference === "string" ? m.dealReference : null,
      instrumentId: epic,
      symbol: epicSymbol(epic),
      side: m.direction === "BUY" ? "buy" : "sell",
      type: "market",
      status: "rejected",
      size: Number(m.size ?? 0),
      filledSize: 0,
      price: null,
      triggerPrice: null,
      avgFillPrice: null,
      timeInForce: null,
      reduceOnly: null,
      stopLoss: null,
      takeProfit: null,
      createdAt: parseIgUtc(m.date) ?? Date.now(),
      updatedAt: Date.now(),
      rejectReason: typeof m.reason === "string" ? m.reason : null,
    };
    this.account.emit("TRADE", { type: "order", order });
  }
}

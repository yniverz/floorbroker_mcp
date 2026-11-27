import type { CostModel, InstrumentRules, Intent, OrderEvent, SimFill, SimOrder, SimPosition } from "./types.js";

/**
 * Simulated execution shared by backtests and paper runs (one net position per
 * instrument, like Bybit one-way mode and IG netting). Conservative by design:
 * market orders fill on the next price after they were placed, limit orders only
 * when the price trades through, stops at the worse of trigger and open, and when
 * stop loss and take profit are both reachable in one candle the stop loss wins.
 * Funding / overnight financing is not simulated.
 */

/** A price window the broker can fill against: one candle, or one quote (all fields equal). */
export interface PriceEvent {
  instrument: string;
  /** Start of the window (orders created before it may fill). */
  t: number;
  /** End of the window; positions opened inside it get SL/TP checks only afterwards. */
  end: number;
  openBid: number;
  openAsk: number;
  bidLow: number;
  bidHigh: number;
  askLow: number;
  askHigh: number;
  /** Mark for unrealized PnL. */
  mid: number;
}

export function barEvent(instrument: string, bar: { t: number; o: number; h: number; l: number; c: number; spread: number | null }, stepMs: number, useSpread: boolean): PriceEvent {
  const hs = useSpread && bar.spread ? bar.spread / 2 : 0;
  return {
    instrument,
    t: bar.t,
    end: bar.t + stepMs,
    openBid: bar.o - hs,
    openAsk: bar.o + hs,
    bidLow: bar.l - hs,
    bidHigh: bar.h - hs,
    askLow: bar.l + hs,
    askHigh: bar.h + hs,
    mid: bar.c,
  };
}

export function quoteEvent(instrument: string, time: number, bid: number, ask: number): PriceEvent {
  return { instrument, t: time, end: time, openBid: bid, openAsk: ask, bidLow: bid, bidHigh: bid, askLow: ask, askHigh: ask, mid: (bid + ask) / 2 };
}

export interface BrokerOptions {
  rules: Map<string, InstrumentRules>;
  costs: CostModel;
  initialCash: number;
  currency: string;
  /** Converts an amount in the instrument's quote currency into account currency. */
  fx: (quoteCurrency: string | null) => number;
  /** Maximum position notional as a multiple of equity (default 10). */
  maxLeverage?: number;
}

export interface BrokerSnapshot {
  cash: number;
  fees: number;
  seq: number;
  positions: SimPosition[];
  orders: SimOrder[];
  marks: [string, number][];
}

export class SimBroker {
  cash: number;
  fees = 0;
  private seq = 0;
  readonly positions = new Map<string, SimPosition>();
  readonly orders = new Map<string, SimOrder>();
  private readonly marks = new Map<string, number>();

  constructor(private readonly o: BrokerOptions) {
    this.cash = o.initialCash;
  }

  // --- reads (used by the sandbox host API) --------------------------------------

  mark(instrument: string): number | null {
    return this.marks.get(instrument) ?? null;
  }

  unrealized(instrument: string): number {
    const p = this.positions.get(instrument);
    const m = this.marks.get(instrument);
    if (!p || m === undefined) return 0;
    const r = this.o.rules.get(instrument);
    return (m - p.avgPrice) * p.qty * (r?.contractSize ?? 1) * this.o.fx(r?.quoteCurrency ?? null);
  }

  equity(): number {
    let e = this.cash;
    for (const inst of this.positions.keys()) e += this.unrealized(inst);
    return e;
  }

  positionView(instrument: string) {
    const p = this.positions.get(instrument);
    if (!p) return null;
    return {
      instrument,
      side: p.qty > 0 ? "long" : "short",
      size: Math.abs(p.qty),
      entryPrice: p.avgPrice,
      unrealizedPnl: this.unrealized(instrument),
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      openedAt: p.openedAt,
    };
  }

  openOrders(instrument: string | null): SimOrder[] {
    return [...this.orders.values()].filter((o) => !instrument || o.instrument === instrument);
  }

  // --- intents ---------------------------------------------------------------------

  /** Applies one intent from the strategy. Returns order status changes. */
  submit(intent: Intent, now: number): OrderEvent[] {
    switch (intent.kind) {
      case "order":
        return [this.placeOrder(intent, now)];
      case "cancel": {
        const hits = [...this.orders.values()].filter((o) => o.id === intent.target || o.tag === intent.target);
        return hits.map((o) => this.cancelOrder(o, "cancelled by strategy"));
      }
      case "cancelAll":
        return this.openOrders(intent.instrument).map((o) => this.cancelOrder(o, "cancelled by strategy"));
      case "close": {
        const p = this.positions.get(intent.instrument);
        if (!p) return [];
        const size = intent.size ? Math.min(intent.size, Math.abs(p.qty)) : Math.abs(p.qty);
        return [
          this.placeOrder(
            { kind: "order", localId: intent.localId, instrument: intent.instrument, side: p.qty > 0 ? "sell" : "buy", type: "market", size, reduceOnly: true, tag: "close" },
            now,
          ),
        ];
      }
      case "protect": {
        const p = this.positions.get(intent.instrument);
        if (!p) return [];
        if (intent.stopLoss !== undefined) p.stopLoss = intent.stopLoss ?? null;
        if (intent.takeProfit !== undefined) p.takeProfit = intent.takeProfit ?? null;
        return [];
      }
    }
  }

  private placeOrder(i: Extract<Intent, { kind: "order" }>, now: number): OrderEvent {
    const id = i.localId;
    const reject = (reason: string): OrderEvent => ({ id, tag: i.tag, instrument: i.instrument, status: "rejected", reason });
    const rules = this.o.rules.get(i.instrument);
    if (!rules) return reject(`instrument ${i.instrument} is not in strategy.data`);
    if (rules.contractKind !== "linear") return reject("inverse contracts are not supported in simulation");
    if (i.side !== "buy" && i.side !== "sell") return reject("side must be buy or sell");
    if (!["market", "limit", "stop"].includes(i.type)) return reject("type must be market, limit or stop");
    let size = roundDown(Number(i.size), rules.sizeStep);
    if (!(size > 0) || (rules.minSize && size < rules.minSize)) return reject(`size ${i.size} is below the minimum ${rules.minSize ?? "step"}`);
    if (i.type === "limit" && !(Number(i.price) > 0)) return reject("limit orders need price");
    if (i.type === "stop" && !(Number(i.triggerPrice) > 0)) return reject("stop orders need triggerPrice");
    if (i.reduceOnly) {
      const p = this.positions.get(i.instrument);
      const opposite = p && ((p.qty > 0 && i.side === "sell") || (p.qty < 0 && i.side === "buy"));
      if (!opposite) return reject("reduceOnly order without an opposite position");
      size = Math.min(size, Math.abs(p.qty));
    }
    const order: SimOrder = {
      id,
      tag: i.tag,
      instrument: i.instrument,
      side: i.side,
      type: i.type,
      size,
      price: i.type === "limit" ? Number(i.price) : null,
      triggerPrice: i.type === "stop" ? Number(i.triggerPrice) : null,
      stopLoss: i.stopLoss ?? null,
      takeProfit: i.takeProfit ?? null,
      reduceOnly: i.reduceOnly,
      createdAt: now,
    };
    this.orders.set(id, order);
    return { id, tag: i.tag, instrument: i.instrument, status: "open", reason: null };
  }

  private cancelOrder(o: SimOrder, reason: string): OrderEvent {
    this.orders.delete(o.id);
    return { id: o.id, tag: o.tag, instrument: o.instrument, status: "cancelled", reason };
  }

  // --- prices ---------------------------------------------------------------------

  /** Processes resting orders and position protection against a price window. */
  onPrice(ev: PriceEvent): { fills: SimFill[]; orders: OrderEvent[] } {
    const fills: SimFill[] = [];
    const events: OrderEvent[] = [];
    const slip = this.o.costs.slippageBps / 10_000;

    // Stop loss / take profit of positions that existed before this window.
    const p = this.positions.get(ev.instrument);
    if (p && ev.t >= p.protectFrom) {
      const long = p.qty > 0;
      const size = Math.abs(p.qty);
      let exit: { price: number; reason: "stop_loss" | "take_profit"; bps: number } | null = null;
      if (long) {
        if (p.stopLoss !== null && ev.bidLow <= p.stopLoss) exit = { price: Math.min(p.stopLoss, ev.openBid) * (1 - slip), reason: "stop_loss", bps: this.o.costs.takerBps };
        else if (p.takeProfit !== null && ev.bidHigh >= p.takeProfit) exit = { price: Math.max(p.takeProfit, ev.openBid), reason: "take_profit", bps: this.o.costs.makerBps };
      } else {
        if (p.stopLoss !== null && ev.askHigh >= p.stopLoss) exit = { price: Math.max(p.stopLoss, ev.openAsk) * (1 + slip), reason: "stop_loss", bps: this.o.costs.takerBps };
        else if (p.takeProfit !== null && ev.askLow <= p.takeProfit) exit = { price: Math.min(p.takeProfit, ev.openAsk), reason: "take_profit", bps: this.o.costs.makerBps };
      }
      if (exit) {
        fills.push(this.fill(ev.instrument, long ? "sell" : "buy", size, exit.price, exit.bps, exit.reason, `${exit.reason}-${++this.seq}`, null, ev));
        // Reduce-only orders that no longer have anything to reduce are cancelled.
        for (const o of this.openOrders(ev.instrument)) if (o.reduceOnly) events.push(this.cancelOrder(o, "position closed"));
      }
    }

    // Resting orders placed before this window, oldest first.
    for (const o of [...this.orders.values()].filter((x) => x.instrument === ev.instrument && x.createdAt <= ev.t)) {
      const buy = o.side === "buy";
      let price: number | null = null;
      let bps = this.o.costs.takerBps;
      if (o.type === "market") {
        price = buy ? ev.openAsk * (1 + slip) : ev.openBid * (1 - slip);
      } else if (o.type === "limit") {
        if (buy && ev.askLow <= o.price!) price = Math.min(o.price!, ev.openAsk);
        if (!buy && ev.bidHigh >= o.price!) price = Math.max(o.price!, ev.openBid);
        bps = this.o.costs.makerBps;
      } else if (o.type === "stop") {
        if (buy && ev.askHigh >= o.triggerPrice!) price = Math.max(o.triggerPrice!, ev.openAsk) * (1 + slip);
        if (!buy && ev.bidLow <= o.triggerPrice!) price = Math.min(o.triggerPrice!, ev.openBid) * (1 - slip);
      }
      if (price === null) continue;

      let size = o.size;
      if (o.reduceOnly) {
        const pos = this.positions.get(o.instrument);
        const opposite = pos && ((pos.qty > 0 && !buy) || (pos.qty < 0 && buy));
        if (!opposite) {
          events.push(this.cancelOrder(o, "nothing left to reduce"));
          continue;
        }
        size = Math.min(size, Math.abs(pos.qty));
      } else if (!this.withinLeverage(o.instrument, buy ? size : -size, price)) {
        events.push(this.cancelOrder(o, `rejected: position would exceed ${this.o.maxLeverage ?? 10}x equity`));
        continue;
      }
      this.orders.delete(o.id);
      fills.push(this.fill(o.instrument, o.side, size, price, bps, "order", o.id, o.tag, ev, o.stopLoss, o.takeProfit));
      events.push({ id: o.id, tag: o.tag, instrument: o.instrument, status: "filled", reason: null });
    }

    this.marks.set(ev.instrument, ev.mid);
    return { fills, orders: events };
  }

  private withinLeverage(instrument: string, deltaQty: number, price: number): boolean {
    const r = this.o.rules.get(instrument)!;
    const cur = this.positions.get(instrument)?.qty ?? 0;
    const next = cur + deltaQty;
    if (Math.abs(next) <= Math.abs(cur)) return true;
    const notional = Math.abs(next) * r.contractSize * price * this.o.fx(r.quoteCurrency);
    return notional <= Math.max(0, this.equity()) * (this.o.maxLeverage ?? 10);
  }

  private fill(
    instrument: string,
    side: "buy" | "sell",
    size: number,
    price: number,
    feeBps: number,
    reason: SimFill["reason"],
    orderId: string,
    tag: string | null,
    ev: PriceEvent,
    stopLoss: number | null = null,
    takeProfit: number | null = null,
  ): SimFill {
    const r = this.o.rules.get(instrument)!;
    const fx = this.o.fx(r.quoteCurrency);
    const fee = size * r.contractSize * price * (feeBps / 10_000) * fx;
    const delta = side === "buy" ? size : -size;
    let pnl = 0;
    const p = this.positions.get(instrument);
    if (!p || Math.sign(p.qty) === Math.sign(delta)) {
      const qty = (p?.qty ?? 0) + delta;
      const avg = p ? (p.avgPrice * Math.abs(p.qty) + price * size) / Math.abs(qty) : price;
      this.positions.set(instrument, {
        instrument,
        qty,
        avgPrice: avg,
        stopLoss: stopLoss ?? p?.stopLoss ?? null,
        takeProfit: takeProfit ?? p?.takeProfit ?? null,
        openedAt: p?.openedAt ?? ev.t,
        protectFrom: ev.end,
      });
    } else {
      const closing = Math.min(Math.abs(p.qty), size);
      pnl = (price - p.avgPrice) * closing * Math.sign(p.qty) * r.contractSize * fx;
      const qty = p.qty + delta;
      if (Math.abs(qty) < 1e-12) this.positions.delete(instrument);
      else if (Math.sign(qty) === Math.sign(p.qty)) p.qty = qty;
      else
        this.positions.set(instrument, {
          instrument,
          qty,
          avgPrice: price,
          stopLoss,
          takeProfit,
          openedAt: ev.t,
          protectFrom: ev.end,
        });
    }
    this.cash += pnl - fee;
    this.fees += fee;
    return { id: `f${++this.seq}`, orderId, tag, instrument, side, size, price, fee, pnl, reason, time: ev.end > ev.t ? ev.t : ev.t };
  }

  // --- persistence ------------------------------------------------------------------

  snapshot(): BrokerSnapshot {
    return {
      cash: this.cash,
      fees: this.fees,
      seq: this.seq,
      positions: [...this.positions.values()],
      orders: [...this.orders.values()],
      marks: [...this.marks.entries()],
    };
  }

  restore(s: BrokerSnapshot): void {
    this.cash = s.cash;
    this.fees = s.fees;
    this.seq = s.seq;
    this.positions.clear();
    for (const p of s.positions) this.positions.set(p.instrument, p);
    this.orders.clear();
    for (const o of s.orders) this.orders.set(o.id, o);
    this.marks.clear();
    for (const [k, v] of s.marks) this.marks.set(k, v);
  }
}

function roundDown(size: number, step: number | null): number {
  if (!step || step <= 0) return size;
  return Number((Math.floor(size / step + 1e-9) * step).toFixed(10));
}

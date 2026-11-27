import { logger } from "../logger.js";
import type { AccountEvent, AccountSummary, Fill, Order, PlatformClient, Position } from "../platforms/types.js";
import type { RiskLimits } from "../repos/connections.js";
import { checkOrder } from "../services/risk.js";
import type { Venue } from "./engine.js";
import type { InstrumentRules, Intent, OrderEvent, SimFill } from "./types.js";

export interface LiveVenueState {
  /** Strategy-local order id → platform order id. */
  orderIds: Record<string, string>;
  tags: Record<string, string | null>;
  seenFills: string[];
  startedAt: number;
  lastFillCheck: number;
  seq: number;
  /** The run's own ledger (platforms differ in how they report realized PnL). */
  ledger: Record<string, { qty: number; avg: number }>;
  /** Realized PnL and fees in account currency since the run started. */
  realized: number;
  fees: number;
  seeded: boolean;
  /** Other platform references of the run's orders (e.g. IG deal references) → local id. */
  aliases?: Record<string, string>;
  /** Recent fills for de-duplication across stream and REST, which may use different fill ids (IG). */
  recent?: { i: string; s: string; z: number; p: number; t: number }[];
}

export interface LiveVenueOptions {
  client: PlatformClient;
  runId: string;
  instruments: string[];
  /** Risk limits of the agent connection that started the run. */
  risk: RiskLimits;
  maxLeverage: number;
  /** Called for every executed action (activity log, agent order attribution). */
  onAction: (action: string, args: Record<string, unknown>, ok: boolean, result: unknown, error: string | null, ms: number) => void;
  onPlatformOrder: (orderId: string, instrument: string) => void;
  /** Delivers asynchronous fills / order updates to the engine. */
  emit: (now: number, fills: SimFill[], orders: OrderEvent[]) => void;
  rules: Map<string, InstrumentRules>;
  /** Factor from a quote currency into account currency. */
  fx: (quoteCurrency: string | null) => number;
  state?: LiveVenueState;
}

/**
 * Executes a strategy's intents on the real account through the platform client.
 * The host API is synchronous, so positions, open orders and the account are kept as
 * caches, refreshed after every action, on account stream events and every 30 s.
 */
export class LiveVenue implements Venue {
  state: LiveVenueState;
  private positions: Position[] = [];
  private orders: Order[] = [];
  private summary: AccountSummary | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly o: LiveVenueOptions) {
    const now = Date.now();
    this.state = o.state ?? { orderIds: {}, tags: {}, seenFills: [], startedAt: now, lastFillCheck: now, seq: 0, ledger: {}, realized: 0, fees: 0, seeded: false };
  }

  async init(): Promise<void> {
    await this.refresh();
    if (!this.state.seeded) {
      // Positions that already exist on the strategy's instruments become part of its ledger.
      for (const p of this.positions) {
        if (p.size > 0 && p.entryPrice) this.state.ledger[p.instrumentId] = { qty: p.side === "long" ? p.size : -p.size, avg: p.entryPrice };
      }
      this.state.seeded = true;
    }
    this.pollTimer = setInterval(() => void this.refresh().then(() => this.pollFills()), 30_000);
  }

  close(): void {
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }

  // --- reads ----------------------------------------------------------------------------

  positionView(instrument: string) {
    const p = this.positions.find((x) => x.instrumentId === instrument && x.size > 0);
    if (!p) return null;
    return {
      instrument,
      side: p.side,
      size: p.size,
      entryPrice: p.entryPrice,
      unrealizedPnl: p.unrealizedPnl,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      openedAt: p.openedAt,
    };
  }

  openOrders(instrument: string | null) {
    const mine = new Set(Object.values(this.state.orderIds));
    return this.orders
      .filter((o) => mine.has(o.id) && (!instrument || o.instrumentId === instrument))
      .map((o) => ({
        id: this.localIdOf(o.id) ?? o.id,
        tag: this.state.tags[this.localIdOf(o.id) ?? ""] ?? null,
        instrument: o.instrumentId,
        side: o.side,
        type: o.type,
        size: o.size,
        price: o.price,
        triggerPrice: o.triggerPrice,
        reduceOnly: o.reduceOnly,
      }));
  }

  account() {
    const s = this.summary;
    return { equity: s?.equity ?? 0, cash: s?.balance ?? null, currency: s?.currency ?? "" };
  }

  mark(instrument: string): number | null {
    return this.positions.find((p) => p.instrumentId === instrument)?.markPrice ?? null;
  }

  // --- intents ----------------------------------------------------------------------------

  submit(intent: Intent, now: number): OrderEvent[] {
    // Actions run one after another, in the order the strategy issued them.
    this.queue = this.queue.then(() => this.execute(intent, now)).catch((err) => logger.warn("live venue action failed", { err: String(err) }));
    return [];
  }

  private async execute(intent: Intent, now: number): Promise<void> {
    if (this.closed) return;
    const c = this.o.client;
    const t0 = Date.now();
    const act = async (name: string, args: Record<string, unknown>, fn: () => Promise<unknown>): Promise<unknown> => {
      try {
        const res = await fn();
        this.o.onAction(name, args, true, res, null, Date.now() - t0);
        return res;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.o.onAction(name, args, false, null, msg, Date.now() - t0);
        throw err;
      }
    };

    try {
      if (intent.kind === "order") {
        const req = {
          instrumentId: intent.instrument,
          side: intent.side,
          type: intent.type,
          size: intent.size,
          price: intent.price,
          triggerPrice: intent.triggerPrice,
          stopLoss: intent.stopLoss,
          takeProfit: intent.takeProfit,
          reduceOnly: intent.reduceOnly || undefined,
          clientOrderId: `fb${this.o.runId.slice(0, 8)}${(++this.state.seq).toString(36)}`.slice(0, 36),
        };
        await checkOrder(c, this.o.risk, req);
        if (!req.reduceOnly) await this.checkLeverage(intent.instrument, intent.side, intent.size, intent.price ?? intent.triggerPrice);
        const res = (await act("place_order", req, () => c.placeOrder(req))) as {
          orderId: string | null;
          status: string;
          message: string | null;
          extra?: Record<string, unknown>;
        };
        if (res.orderId) {
          this.state.orderIds[intent.localId] = res.orderId;
          this.state.tags[intent.localId] = intent.tag;
          this.o.onPlatformOrder(res.orderId, intent.instrument);
        }
        this.alias(intent.localId, res);
        const status = res.status === "rejected" ? "rejected" : res.status === "filled" ? "filled" : "open";
        this.o.emit(Date.now(), [], [{ id: intent.localId, tag: intent.tag, instrument: intent.instrument, status: status === "filled" ? "open" : status, reason: res.message }]);
      } else if (intent.kind === "cancel" || intent.kind === "cancelAll") {
        const targets = Object.entries(this.state.orderIds).filter(([local, platform]) => {
          if (intent.kind === "cancel") return local === intent.target || platform === intent.target || this.state.tags[local] === intent.target;
          const o = this.orders.find((x) => x.id === platform);
          return !!o && (!intent.instrument || o.instrumentId === intent.instrument);
        });
        for (const [local, platform] of targets) {
          const o = this.orders.find((x) => x.id === platform);
          if (!o) continue;
          await act("cancel_order", { orderId: platform, instrumentId: o.instrumentId }, () => c.cancelOrder({ orderId: platform, instrumentId: o.instrumentId }));
          this.o.emit(Date.now(), [], [{ id: local, tag: this.state.tags[local] ?? null, instrument: o.instrumentId, status: "cancelled", reason: "cancelled by strategy" }]);
        }
      } else if (intent.kind === "close") {
        const p = this.positions.find((x) => x.instrumentId === intent.instrument && x.size > 0);
        if (p) {
          const res = (await act("close_position", { positionId: p.id, size: intent.size ?? undefined }, () =>
            c.closePosition({ positionId: p.id, size: intent.size ?? undefined }),
          )) as { orderId: string | null; positionId?: string | null; extra?: Record<string, unknown> };
          if (res.orderId) {
            this.state.orderIds[intent.localId] = res.orderId;
            this.state.tags[intent.localId] = "close";
            this.o.onPlatformOrder(res.orderId, intent.instrument);
          }
          this.alias(intent.localId, res);
        }
      } else if (intent.kind === "protect") {
        const p = this.positions.find((x) => x.instrumentId === intent.instrument && x.size > 0);
        if (p && c.setPositionProtection) {
          await act("set_position_protection", { positionId: p.id, stopLoss: intent.stopLoss, takeProfit: intent.takeProfit }, () =>
            c.setPositionProtection!({ positionId: p.id, stopLoss: intent.stopLoss, takeProfit: intent.takeProfit }),
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (intent.kind === "order") {
        this.o.emit(Date.now(), [], [{ id: intent.localId, tag: intent.tag, instrument: intent.instrument, status: "rejected", reason: msg }]);
      } else {
        logger.warn("live strategy action failed", { runId: this.o.runId, kind: intent.kind, err: msg });
      }
    }
    this.scheduleRefresh();
    void now;
  }

  private async checkLeverage(instrument: string, side: "buy" | "sell", size: number, price: number | undefined): Promise<void> {
    const inst = await this.o.client.getInstrument(instrument);
    let px = price;
    if (!px) {
      const [q] = await this.o.client.getQuotes([instrument]);
      px = (side === "buy" ? q?.ask : q?.bid) ?? q?.last ?? q?.mark ?? undefined;
    }
    if (!px) return;
    const pos = this.positions.find((p) => p.instrumentId === instrument && p.size > 0);
    const signed = pos ? (pos.side === "long" ? pos.size : -pos.size) : 0;
    const next = Math.abs(signed + (side === "buy" ? size : -size));
    if (next <= Math.abs(signed)) return;
    const notional = inst.contractKind === "inverse" ? next * inst.contractSize : next * inst.contractSize * px;
    const equity = this.summary?.equity ?? 0;
    if (equity > 0 && notional > equity * this.o.maxLeverage) {
      throw new Error(`run limit: position notional ≈ ${notional.toFixed(2)} would exceed ${this.o.maxLeverage}x equity (${equity.toFixed(2)})`);
    }
  }

  // --- refresh & fills -------------------------------------------------------------------

  /** Account stream events trigger a refresh and fill check. */
  onAccountEvent(e: AccountEvent): void {
    if (e.type === "fill") this.handleFill(e.fill);
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (this.closed || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh().then(() => this.pollFills());
    }, 1500);
  }

  async refresh(): Promise<void> {
    if (this.closed) return;
    const c = this.o.client;
    try {
      const [summary, positions, orders] = await Promise.all([c.getAccount(), c.getPositions({}), c.getOpenOrders({})]);
      this.summary = summary;
      this.positions = positions.filter((p) => this.o.instruments.includes(p.instrumentId));
      this.orders = orders;
    } catch (err) {
      logger.warn("live strategy refresh failed", { runId: this.o.runId, err: String(err) });
    }
  }

  /** REST fallback (and safety net) for fills the stream may have missed. */
  private async pollFills(): Promise<void> {
    if (this.closed) return;
    const from = this.state.lastFillCheck - 60_000;
    const now = Date.now();
    for (const instrument of this.o.instruments) {
      try {
        const fills = await this.o.client.getFills({ instrumentId: instrument, from, limit: 100 });
        for (const f of [...fills].reverse()) this.handleFill(f);
      } catch {
        /* next poll */
      }
    }
    this.state.lastFillCheck = now;
  }

  private handleFill(f: Fill): void {
    if (!this.o.instruments.includes(f.instrumentId)) return;
    if (this.state.seenFills.includes(f.id)) return;
    if (f.time < this.state.startedAt - 5_000) return;
    const recent = (this.state.recent ??= []);
    const dup = recent.find((r) => r.i === f.instrumentId && r.s === f.side && Math.abs(r.z - f.size) < 1e-12 && Math.abs(r.p - f.price) <= Math.abs(f.price) * 1e-9 && Math.abs(r.t - f.time) < 120_000);
    this.state.seenFills.push(f.id);
    if (dup) return;
    recent.push({ i: f.instrumentId, s: f.side, z: f.size, p: f.price, t: f.time });
    if (recent.length > 50) recent.splice(0, recent.length - 50);
    const { pnl, fee } = this.book(f);
    if (this.state.seenFills.length > 500) this.state.seenFills.splice(0, this.state.seenFills.length - 500);
    const local = f.orderId ? this.localIdOf(f.orderId) : null;
    const sim: SimFill = {
      id: f.id,
      orderId: local ?? f.orderId ?? "",
      tag: local ? (this.state.tags[local] ?? null) : null,
      instrument: f.instrumentId,
      side: f.side,
      size: f.size,
      price: f.price,
      fee,
      pnl,
      // Fills of orders the strategy did not place are exchange-side exits (stop loss / take profit).
      reason: local ? "order" : "close",
      time: f.time,
    };
    // Refresh positions first, so ctx.position() inside onFill already reflects the fill.
    this.queue = this.queue
      .then(() => this.refresh())
      .then(() => this.o.emit(Date.now(), [sim], local ? [{ id: local, tag: sim.tag, instrument: f.instrumentId, status: "filled", reason: null }] : []))
      .catch((err) => logger.warn("live fill delivery failed", { err: String(err) }));
  }

  private alias(localId: string, res: { orderId: string | null; positionId?: string | null; extra?: Record<string, unknown> }): void {
    const aliases = (this.state.aliases ??= {});
    const ref = res.extra?.dealReference;
    if (typeof ref === "string" && ref) aliases[ref] = localId;
  }

  /** Books a fill into the run's ledger; returns realized PnL and fee in account currency. */
  private book(f: Fill): { pnl: number; fee: number } {
    const r = this.o.rules.get(f.instrumentId);
    const cs = r?.contractSize ?? 1;
    const fx = this.o.fx(r?.quoteCurrency ?? null);
    const pos = this.state.ledger[f.instrumentId] ?? { qty: 0, avg: 0 };
    const signed = f.side === "buy" ? f.size : -f.size;
    let pnl = 0;
    if (pos.qty !== 0 && Math.sign(pos.qty) !== Math.sign(signed)) {
      const closing = Math.min(Math.abs(pos.qty), Math.abs(signed));
      pnl = closing * (f.price - pos.avg) * Math.sign(pos.qty) * cs * fx;
      const rest = signed + Math.sign(pos.qty) * closing; // what is left of the fill after closing
      pos.qty += Math.sign(signed) * closing;
      if (Math.abs(pos.qty) < 1e-12) pos.qty = 0;
      if (Math.abs(rest) > 1e-12) {
        pos.qty = rest;
        pos.avg = f.price;
      }
    } else {
      const total = Math.abs(pos.qty) + Math.abs(signed);
      pos.avg = total > 0 ? (pos.avg * Math.abs(pos.qty) + f.price * Math.abs(signed)) / total : f.price;
      pos.qty += signed;
    }
    this.state.ledger[f.instrumentId] = pos;
    // Fees are reported in the settlement/quote currency.
    const fee = Math.abs(f.fee ?? 0) * (f.feeCurrency && f.feeCurrency !== r?.quoteCurrency ? 1 : fx);
    this.state.realized += pnl;
    this.state.fees += fee;
    return { pnl: Number(pnl.toFixed(6)), fee: Number(fee.toFixed(6)) };
  }

  /** Strategy PnL in account currency: realized minus fees plus unrealized at the given prices. */
  pnl(price: (instrument: string) => number | null): number {
    let unrealized = 0;
    for (const [inst, pos] of Object.entries(this.state.ledger)) {
      if (pos.qty === 0) continue;
      const px = price(inst) ?? this.mark(inst);
      if (px === null) continue;
      const r = this.o.rules.get(inst);
      unrealized += pos.qty * (px - pos.avg) * (r?.contractSize ?? 1) * this.o.fx(r?.quoteCurrency ?? null);
    }
    return this.state.realized - this.state.fees + unrealized;
  }

  /** Open positions on the strategy's instruments (for flattening). */
  openPositions(): Position[] {
    return this.positions.filter((p) => p.size > 0);
  }

  /** Cancels the run's resting orders and optionally closes its positions. Used when a run stops. */
  async shutdown(closePositions: boolean): Promise<string[]> {
    await this.queue.catch(() => undefined);
    await this.refresh();
    const notes: string[] = [];
    const mine = new Set(Object.values(this.state.orderIds));
    for (const o of this.orders.filter((x) => mine.has(x.id))) {
      try {
        await this.o.client.cancelOrder({ orderId: o.id, instrumentId: o.instrumentId });
        this.o.onAction("cancel_order", { orderId: o.id, instrumentId: o.instrumentId }, true, null, null, 0);
        notes.push(`cancelled order ${o.id}`);
      } catch (err) {
        notes.push(`could not cancel ${o.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (closePositions) {
      for (const p of this.openPositions()) {
        try {
          const res = await this.o.client.closePosition({ positionId: p.id });
          this.o.onAction("close_position", { positionId: p.id }, true, res, null, 0);
          if (res.orderId) this.o.onPlatformOrder(res.orderId, p.instrumentId);
          notes.push(`closed ${p.side} ${p.size} ${p.instrumentId}`);
        } catch (err) {
          notes.push(`could not close ${p.instrumentId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await this.pollFills();
      await this.queue.catch(() => undefined);
    }
    return notes;
  }

  private localIdOf(platformId: string): string | null {
    for (const [local, p] of Object.entries(this.state.orderIds)) if (p === platformId) return local;
    return this.state.aliases?.[platformId] ?? null;
  }
}

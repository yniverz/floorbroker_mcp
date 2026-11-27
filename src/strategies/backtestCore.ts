import { RESOLUTION_MS, type Candle, type Resolution } from "../platforms/types.js";
import { SimBroker, barEvent } from "./broker.js";
import { StrategyEngine, type Venue } from "./engine.js";
import { StrategySandbox } from "./sandbox.js";
import type { CostModel, InstrumentRules, Intent, OrderEvent, SimFill, StrategyLog } from "./types.js";

export interface BacktestInput {
  code: string;
  params: Record<string, unknown>;
  from: number;
  to: number;
  /** Start of the check (out-of-sample) period. */
  splitAt: number;
  initialEquity: number;
  currency: string;
  costs: CostModel;
  rules: InstrumentRules[];
  /** Factor from a quote currency into account currency. */
  fx: Record<string, number>;
  feeds: { instrument: string; resolution: Resolution; bars: Candle[] }[];
  maxLeverage: number;
}

export interface Metrics {
  from: number;
  to: number;
  startEquity: number;
  endEquity: number;
  netPnl: number;
  returnPct: number;
  maxDrawdownPct: number;
  closedTrades: number;
  winRatePct: number | null;
  profitFactor: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  fees: number;
  exposurePct: number;
  sharpe: number | null;
}

export interface BacktestResult {
  total: Metrics;
  tuning: Metrics;
  check: Metrics;
  equity: [number, number][];
  trades: SimFill[];
  logs: StrategyLog[];
  stoppedEarly: string | null;
  barsProcessed: number;
  notes: string[];
}

export class SimVenue implements Venue {
  constructor(
    readonly broker: SimBroker,
    private readonly currency: string,
  ) {}
  submit(intent: Intent, now: number): OrderEvent[] {
    return this.broker.submit(intent, now);
  }
  positionView(instrument: string) {
    return this.broker.positionView(instrument);
  }
  openOrders(instrument: string | null) {
    return this.broker.openOrders(instrument).map((o) => ({
      id: o.id,
      tag: o.tag,
      instrument: o.instrument,
      side: o.side,
      type: o.type,
      size: o.size,
      price: o.price,
      triggerPrice: o.triggerPrice,
      reduceOnly: o.reduceOnly,
    }));
  }
  account() {
    return { equity: this.broker.equity(), cash: this.broker.cash, currency: this.currency };
  }
  mark(instrument: string) {
    return this.broker.mark(instrument);
  }
}

export async function runBacktest(input: BacktestInput): Promise<BacktestResult> {
  const rules = new Map(input.rules.map((r) => [r.instrumentId, r]));
  const broker = new SimBroker({
    rules,
    costs: input.costs,
    initialCash: input.initialEquity,
    currency: input.currency,
    fx: (ccy) => (ccy ? (input.fx[ccy] ?? 1) : 1),
    maxLeverage: input.maxLeverage,
  });
  const venue = new SimVenue(broker, input.currency);
  const logs: StrategyLog[] = [];
  const trades: SimFill[] = [];
  let stoppedEarly: string | null = null;

  // The engine needs the sandbox, and the sandbox's host calls need the engine.
  let engine: StrategyEngine | null = null;
  const sandbox = await StrategySandbox.create(input.code, (op, args) => engine!.host(op, args));
  engine = new StrategyEngine(sandbox, rules, venue, {
    onLog: (l) => {
      logs.push(l);
      if (logs.length > 300) logs.shift();
    },
    onFill: (f) => trades.push(f),
    onFatal: (reason) => (stoppedEarly = reason),
  });

  try {
    // Each instrument fills against its smallest-resolution feed.
    const execFeed = new Map<string, Resolution>();
    for (const f of input.feeds) {
      const cur = execFeed.get(f.instrument);
      if (!cur || RESOLUTION_MS[f.resolution] < RESOLUTION_MS[cur]) execFeed.set(f.instrument, f.resolution);
    }
    const events = input.feeds
      .flatMap((f) => f.bars.map((b) => ({ ...b, instrument: f.instrument, resolution: f.resolution, end: b.t + RESOLUTION_MS[f.resolution] })))
      .sort((a, b) => a.end - b.end || RESOLUTION_MS[a.resolution] - RESOLUTION_MS[b.resolution]);

    const warmup = events.filter((e) => e.end <= input.from);
    engine.preload(warmup);
    for (const w of warmup) if (execFeed.get(w.instrument) === w.resolution) broker.onPrice(barEvent(w.instrument, w, RESOLUTION_MS[w.resolution], input.costs.useSpread));

    engine.start(input.from, input.params, {});
    const curve: [number, number][] = [[input.from, broker.equity()]];
    let exposed = 0;
    let steps = 0;
    let processed = 0;
    const live = events.filter((e) => e.end > input.from && e.end <= input.to);
    for (const e of live) {
      if (engine.isStopped) break;
      if (execFeed.get(e.instrument) === e.resolution) {
        const { fills, orders } = broker.onPrice(barEvent(e.instrument, e, RESOLUTION_MS[e.resolution], input.costs.useSpread));
        if (fills.length || orders.length) engine.pushEvents(e.end, fills, orders);
      }
      engine.onBar(e);
      processed++;
      const last = curve[curve.length - 1]!;
      if (last[0] === e.end) last[1] = broker.equity();
      else {
        curve.push([e.end, broker.equity()]);
        steps++;
        if (broker.positions.size > 0) exposed++;
      }
    }
    engine.stop(Math.min(input.to, curve[curve.length - 1]![0]), stoppedEarly ? "error" : "end of backtest");

    const endT = curve[curve.length - 1]![0];
    const splitAt = Math.min(Math.max(input.splitAt, input.from), endT);
    const notes = [
      "Fills: market orders at the next candle's open plus slippage; limits only when traded through; stop loss wins when SL and TP are both hit in one candle.",
      "Not simulated: funding / overnight financing, partial fills, liquidity, and price moves inside a candle beyond its high/low.",
    ];
    if (input.costs.useSpread) notes.push("IG spreads from the candle data are applied to market and stop executions.");
    return {
      total: metrics(curve, trades, input.from, endT, exposed, steps),
      tuning: metrics(curve, trades, input.from, splitAt, null, null),
      check: metrics(curve, trades, splitAt, endT, null, null),
      equity: sample(curve, 150),
      trades: trades.slice(-100),
      logs: logs.slice(-150),
      stoppedEarly,
      barsProcessed: processed,
      notes,
    };
  } finally {
    sandbox.dispose();
  }
}

function equityAt(curve: [number, number][], t: number): number {
  let v = curve[0]![1];
  for (const [ct, cv] of curve) {
    if (ct > t) break;
    v = cv;
  }
  return v;
}

export function metrics(curve: [number, number][], fills: SimFill[], from: number, to: number, exposedSteps: number | null, totalSteps: number | null): Metrics {
  const seg = curve.filter(([t]) => t >= from && t <= to);
  const startEquity = equityAt(curve, from);
  const endEquity = equityAt(curve, to);
  let peak = startEquity;
  let maxDd = 0;
  for (const [, v] of seg) {
    peak = Math.max(peak, v);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - v) / peak);
  }
  const closes = fills.filter((f) => f.time >= from && f.time <= to && f.pnl !== 0);
  const wins = closes.filter((f) => f.pnl > 0);
  const losses = closes.filter((f) => f.pnl < 0);
  const grossWin = wins.reduce((s, f) => s + f.pnl, 0);
  const grossLoss = -losses.reduce((s, f) => s + f.pnl, 0);
  const fees = fills.filter((f) => f.time >= from && f.time <= to).reduce((s, f) => s + f.fee, 0);

  let sharpe: number | null = null;
  if (seg.length > 10) {
    const rets: number[] = [];
    for (let i = 1; i < seg.length; i++) if (seg[i - 1]![1] > 0) rets.push(seg[i]![1] / seg[i - 1]![1] - 1);
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length);
    const stepMs = (seg[seg.length - 1]![0] - seg[0]![0]) / (seg.length - 1);
    if (sd > 0 && stepMs > 0) sharpe = round((mean / sd) * Math.sqrt((365 * 86_400_000) / stepMs), 2);
  }
  return {
    from,
    to,
    startEquity: round(startEquity),
    endEquity: round(endEquity),
    netPnl: round(endEquity - startEquity),
    returnPct: startEquity > 0 ? round(((endEquity - startEquity) / startEquity) * 100, 2) : 0,
    maxDrawdownPct: round(maxDd * 100, 2),
    closedTrades: closes.length,
    winRatePct: closes.length ? round((wins.length / closes.length) * 100, 1) : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : grossWin > 0 ? null : null,
    avgWin: wins.length ? round(grossWin / wins.length) : null,
    avgLoss: losses.length ? round(-grossLoss / losses.length) : null,
    fees: round(fees),
    exposurePct: exposedSteps !== null && totalSteps ? round((exposedSteps / totalSteps) * 100, 1) : round(exposure(fills, from, to), 1),
    sharpe,
  };
}

/** Rough exposure for sub-periods: share of time between an opening fill and the next flat point. */
function exposure(fills: SimFill[], from: number, to: number): number {
  if (to <= from) return 0;
  const pos = new Map<string, number>();
  let openSince: number | null = null;
  let total = 0;
  for (const f of fills) {
    const cur = pos.get(f.instrument) ?? 0;
    pos.set(f.instrument, cur + (f.side === "buy" ? f.size : -f.size));
    const anyOpen = [...pos.values()].some((q) => Math.abs(q) > 1e-12);
    if (anyOpen && openSince === null) openSince = f.time;
    if (!anyOpen && openSince !== null) {
      total += Math.max(0, Math.min(f.time, to) - Math.max(openSince, from));
      openSince = null;
    }
  }
  if (openSince !== null) total += Math.max(0, to - Math.max(openSince, from));
  return (total / (to - from)) * 100;
}

function sample(curve: [number, number][], max: number): [number, number][] {
  if (curve.length <= max) return curve.map(([t, v]) => [t, round(v)]);
  const step = (curve.length - 1) / (max - 1);
  const out: [number, number][] = [];
  for (let i = 0; i < max; i++) {
    const p = curve[Math.round(i * step)]!;
    out.push([p[0], round(p[1])]);
  }
  return out;
}

function round(v: number, d = 4): number {
  return Number(v.toFixed(d));
}

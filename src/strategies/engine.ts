import { RESOLUTION_MS, type Resolution } from "../platforms/types.js";
import type { StrategySandbox } from "./sandbox.js";
import { StrategyError } from "./sandbox.js";
import type { Bar, InstrumentRules, Intent, OrderEvent, SimFill, StrategyLog } from "./types.js";

/** Where intents are executed: the simulated broker (backtest, paper) or a platform account (live). */
export interface Venue {
  /** Applies one intent. Synchronous venues return order events directly; async ones report later via Engine.pushEvents. */
  submit(intent: Intent, now: number): OrderEvent[];
  positionView(instrument: string): unknown;
  openOrders(instrument: string | null): unknown[];
  account(): { equity: number; cash: number | null; currency: string };
  mark(instrument: string): number | null;
}

export interface EngineHooks {
  onLog?: (log: StrategyLog) => void;
  onFill?: (fill: SimFill) => void;
  onOrder?: (ev: OrderEvent) => void;
  /** Called with the strategy's state after every handler (for persistence). */
  onState?: (state: Record<string, unknown>) => void;
  /** Called when the strategy must stop (too many errors, sandbox broken). */
  onFatal?: (reason: string) => void;
  /** Checked before every order intent; return a reason to block it. */
  guard?: (intent: Extract<Intent, { kind: "order" }>, now: number) => string | null;
}

export interface Quote {
  instrument: string;
  time: number;
  bid: number | null;
  ask: number | null;
  last: number | null;
}

const MAX_CONSECUTIVE_ERRORS = 5;
const MAX_CHAINED_EVENTS = 50;

export function feedKey(instrument: string, resolution: Resolution): string {
  return `${instrument}|${resolution}`;
}

/**
 * Runs one strategy: keeps candle buffers, answers the sandbox's host calls, turns
 * intents into venue actions and feeds fills/order updates back as events.
 */
export class StrategyEngine {
  private readonly buffers = new Map<string, Bar[]>();
  private readonly quotes = new Map<string, Quote>();
  private readonly maxBuffer: number;
  private consecutiveErrors = 0;
  private stopped = false;
  private busy = false;
  private readonly pending: { handler: string; now: number; payload: unknown }[] = [];
  state: Record<string, unknown> = {};

  constructor(
    readonly sandbox: StrategySandbox,
    readonly rules: Map<string, InstrumentRules>,
    readonly venue: Venue,
    private readonly hooks: EngineHooks = {},
  ) {
    const maxHistory = Math.max(100, ...sandbox.declaration.data.map((d) => Number(d.history) || 100));
    this.maxBuffer = Math.min(5000, maxHistory + 200);
  }

  /** Answers the sandbox's synchronous, read-only host calls. */
  host = (op: string, args: unknown[]): unknown => {
    switch (op) {
      case "candles": {
        const [instrument, resolution, count] = args as [string, Resolution, number];
        const buf = this.buffers.get(feedKey(instrument, resolution));
        if (!buf) throw new Error(`no candle feed ${instrument} ${resolution}; declare it in strategy.data`);
        const n = Math.max(1, Math.min(Number(count) || 100, buf.length));
        return buf.slice(buf.length - n).map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
      }
      case "lastPrice": {
        const [instrument] = args as [string];
        const q = this.quotes.get(instrument);
        const mark = this.venue.mark(instrument);
        if (q) {
          const mid = q.bid !== null && q.ask !== null ? (q.bid + q.ask) / 2 : (q.last ?? mark);
          return { bid: q.bid, ask: q.ask, last: q.last, mid, time: q.time };
        }
        return mark === null ? null : { bid: null, ask: null, last: mark, mid: mark, time: null };
      }
      case "position":
        return this.venue.positionView(String(args[0]));
      case "orders":
        return this.venue.openOrders((args[0] as string | null) ?? null);
      case "account":
        return this.venue.account();
      case "instrument": {
        const r = this.rules.get(String(args[0]));
        if (!r) throw new Error(`unknown instrument ${String(args[0])}; declare it in strategy.data`);
        return r;
      }
      default:
        throw new Error(`unknown host call ${op}`);
    }
  };

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Seeds candle history without calling the strategy. */
  preload(bars: Bar[]): void {
    for (const b of bars) this.append(b);
  }

  start(now: number, params: Record<string, unknown>, state: Record<string, unknown>): void {
    this.sandbox.init(params, state);
    this.state = state;
    this.run("onStart", now, undefined);
  }

  stop(now: number, reason: string): void {
    if (this.stopped) return;
    this.run("onStop", now, { reason });
    this.stopped = true;
  }

  /** A completed candle from a declared feed. */
  onBar(bar: Bar): void {
    this.append(bar);
    const now = bar.t + RESOLUTION_MS[bar.resolution];
    this.run("onCandle", now, { instrument: bar.instrument, resolution: bar.resolution, t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v });
  }

  onQuote(q: Quote, dispatch: boolean): void {
    this.quotes.set(q.instrument, q);
    if (dispatch && this.sandbox.declaration.handlers.includes("onTick")) this.run("onTick", q.time, q);
  }

  /** Fills and order updates produced by the venue (sync or async). */
  pushEvents(now: number, fills: SimFill[], orders: OrderEvent[]): void {
    for (const ev of orders) {
      this.hooks.onOrder?.(ev);
      if (this.sandbox.declaration.handlers.includes("onOrder") && ev.status !== "filled") this.run("onOrder", now, ev);
    }
    for (const f of fills) {
      this.hooks.onFill?.(f);
      if (this.sandbox.declaration.handlers.includes("onFill")) this.run("onFill", now, f);
    }
  }

  // ----------------------------------------------------------------------------------

  private append(bar: Bar): void {
    const key = feedKey(bar.instrument, bar.resolution);
    let buf = this.buffers.get(key);
    if (!buf) {
      buf = [];
      this.buffers.set(key, buf);
    }
    const last = buf[buf.length - 1];
    if (last && last.t === bar.t) buf[buf.length - 1] = bar;
    else if (!last || bar.t > last.t) buf.push(bar);
    if (buf.length > this.maxBuffer) buf.splice(0, buf.length - this.maxBuffer);
  }

  /** Runs a handler; events it causes are queued and processed afterwards (no recursion). */
  private run(handler: string, now: number, payload: unknown): void {
    if (this.stopped) return;
    this.pending.push({ handler, now, payload });
    if (this.busy) return;
    this.busy = true;
    try {
      let processed = 0;
      while (this.pending.length && !this.stopped) {
        const next = this.pending.shift()!;
        if (++processed > MAX_CHAINED_EVENTS) {
          this.fatal("too many chained events in one step (possible order loop)");
          break;
        }
        this.runOne(next.handler, next.now, next.payload);
      }
    } finally {
      this.busy = false;
      this.pending.length = 0;
    }
  }

  private runOne(handler: string, now: number, payload: unknown): void {
    if (handler !== "onStart" && handler !== "onStop" && !this.sandbox.declaration.handlers.includes(handler)) return;
    let result;
    try {
      result = this.sandbox.dispatch(handler, now, payload);
      this.consecutiveErrors = 0;
    } catch (err) {
      const logs = (err as { logs?: StrategyLog[] }).logs ?? [];
      for (const l of logs) this.hooks.onLog?.(l);
      const msg = err instanceof Error ? err.message : String(err);
      this.hooks.onLog?.({ t: now, msg: `ERROR ${msg}` });
      if (!(err instanceof StrategyError) || /out of memory/i.test(msg) || ++this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        this.fatal(`${msg}${this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS ? ` (${MAX_CONSECUTIVE_ERRORS} errors in a row)` : ""}`);
      }
      return;
    }
    for (const l of result.logs) this.hooks.onLog?.(l);
    this.state = result.state;
    this.hooks.onState?.(result.state);
    for (const intent of result.intents) {
      if (this.stopped) break;
      if (intent.kind === "order") {
        if (!this.rules.has(intent.instrument)) {
          this.pushEvents(now, [], [{ id: intent.localId, tag: intent.tag, instrument: intent.instrument, status: "rejected", reason: "instrument not declared in strategy.data" }]);
          continue;
        }
        const blocked = this.hooks.guard?.(intent, now);
        if (blocked) {
          this.hooks.onLog?.({ t: now, msg: `BLOCKED order ${intent.side} ${intent.size} ${intent.instrument}: ${blocked}` });
          this.pushEvents(now, [], [{ id: intent.localId, tag: intent.tag, instrument: intent.instrument, status: "rejected", reason: blocked }]);
          continue;
        }
      }
      const events = this.venue.submit(intent, now);
      if (events.length) this.pushEvents(now, [], events);
    }
  }

  private fatal(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.hooks.onFatal?.(reason);
  }
}

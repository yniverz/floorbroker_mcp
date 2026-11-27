// Offline tests for the strategy engine: sandbox isolation and limits, simulated broker
// fills, engine error handling and a deterministic backtest on synthetic candles.
// Usage: npm run build && node scripts/strategy-test.mjs
import path from "node:path";

const imp = (p) => import(path.resolve("dist", p));
const { StrategySandbox, StrategyError } = await imp("strategies/sandbox.js");
const { SimBroker, barEvent, quoteEvent } = await imp("strategies/broker.js");
const { StrategyEngine } = await imp("strategies/engine.js");
const { runBacktest, SimVenue } = await imp("strategies/backtestCore.js");
const { compileStrategy } = await imp("services/strategies.js");

let failures = 0;
const check = (cond, label, extra) => {
  console.log(`${cond ? "✓" : "✗"} ${label}${extra !== undefined ? ` — ${typeof extra === "string" ? extra : JSON.stringify(extra).slice(0, 300)}` : ""}`);
  if (!cond) failures++;
};
const throwsAsync = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};

const FEED = `data: [{ instrument: "X", resolution: "1h", history: 50 }]`;
const noHost = () => null;

// --- sandbox ---------------------------------------------------------------------
{
  const e = await throwsAsync(() => StrategySandbox.create(`const strategy = { ${FEED}, onCandle() {} }; while (true) {}`, noHost));
  check(e instanceof StrategyError && /interrupted/i.test(e.message), "infinite loop while loading is interrupted", e?.message);

  const sb = await StrategySandbox.create(`const strategy = { ${FEED},
    onCandle(ctx, p) { if (p.mode === "loop") { while (true) {} } if (p.mode === "mem") { const a = []; while (true) a.push(new Array(1e5).fill(1)); }
      if (p.mode === "throw") { ctx.buy("X", 1); throw new Error("boom"); }
      ctx.log(typeof fetch, typeof require, typeof process, typeof setTimeout, Date.now()); ctx.buy("X", 1, { tag: "t" }); } };`, noHost);
  sb.init({}, {});
  const t0 = Date.now();
  const loop = await throwsAsync(() => sb.dispatch("onCandle", 1, { mode: "loop" }));
  check(loop instanceof StrategyError && Date.now() - t0 < 1500, "infinite loop in a handler is interrupted (~250 ms)", `${Date.now() - t0} ms`);
  const thrown = await throwsAsync(() => sb.dispatch("onCandle", 1, { mode: "throw" }));
  check(thrown instanceof StrategyError && /boom/.test(thrown.message), "handler exception is reported", thrown?.message);
  const ok = sb.dispatch("onCandle", 12345, { mode: "ok" });
  check(ok.intents.length === 1 && ok.intents[0].tag === "t", "intents of a failed handler are dropped; next call is clean", ok.intents);
  check(ok.logs[0]?.msg === "undefined undefined undefined undefined 12345", "no fetch/require/process/timers; Date.now() is simulated time", ok.logs[0]?.msg);
  const mem = await throwsAsync(() => sb.dispatch("onCandle", 1, { mode: "mem" }, 5000));
  check(mem instanceof StrategyError && /memory/i.test(mem.message), "memory limit enforced", mem?.message);
  sb.dispose();

  const e2 = await throwsAsync(() => compileStrategy("const x = 1;"));
  check(e2 && /strategy/.test(e2.message), "missing strategy object is reported", e2?.message);
  const e3 = await throwsAsync(() => compileStrategy(`const strategy = { ${FEED} };`));
  check(e3 && /onCandle or onTick/.test(e3.message), "strategy without handlers is rejected", e3?.message);
  const d = await compileStrategy(`const strategy = { name: "n", params: { a: 1 }, ${FEED}, ticks: ["X"], onCandle() {}, onFill() {} };`);
  check(d.name === "n" && d.params.a === 1 && d.handlers.join() === "onCandle,onFill" && d.ticks[0] === "X", "declaration is read", d);
}

// --- broker ----------------------------------------------------------------------
const rules = new Map([["X", { instrumentId: "X", minSize: 0.01, sizeStep: 0.01, priceTick: 0.1, contractSize: 1, contractKind: "linear", quoteCurrency: "USDT" }]]);
const costs = { makerBps: 0, takerBps: 0, slippageBps: 0, useSpread: false };
const mkBroker = (extra = {}) => new SimBroker({ rules, costs, initialCash: 10_000, currency: "USDT", fx: () => 1, ...extra });
const H = 3_600_000;
const bar = (i, o, h, l, c) => barEvent("X", { t: i * H, o, h, l, c, spread: null }, H, false);
const order = (o) => ({ kind: "order", localId: o.id ?? "o", reduceOnly: false, tag: null, type: "market", ...o });
{
  const b = mkBroker();
  b.submit(order({ id: "m", instrument: "X", side: "buy", size: 1, stopLoss: 90, takeProfit: 120 }), 0);
  let r = b.onPrice(bar(0, 100, 101, 99, 100));
  check(r.fills.length === 1 && r.fills[0].price === 100, "market order fills at the next open", r.fills[0]);
  r = b.onPrice(bar(1, 100, 125, 85, 110));
  check(r.fills.length === 1 && r.fills[0].reason === "stop_loss" && r.fills[0].price === 90 && b.cash === 9990, "SL wins when SL and TP are hit in one candle", r.fills[0]);

  const b2 = mkBroker();
  b2.submit(order({ id: "l", instrument: "X", side: "buy", type: "limit", price: 95, size: 1 }), 0);
  r = b2.onPrice(bar(0, 100, 101, 95.5, 100));
  check(r.fills.length === 0, "limit not filled when price does not trade through");
  r = b2.onPrice(bar(1, 100, 101, 94, 100));
  check(r.fills.length === 1 && r.fills[0].price === 95, "limit fills at its price once traded through", r.fills[0]);
  b2.submit(order({ id: "s", instrument: "X", side: "sell", type: "stop", triggerPrice: 93, size: 1 }), 2 * H);
  r = b2.onPrice(bar(2, 92, 92.5, 91, 92));
  check(r.fills.length === 1 && r.fills[0].price === 92 && r.fills[0].pnl === -3, "stop fills at the worse of trigger and open (gap)", r.fills[0]);

  const b3 = mkBroker({ maxLeverage: 2 });
  b3.onPrice(bar(0, 100, 100, 100, 100));
  b3.submit(order({ id: "big", instrument: "X", side: "buy", size: 300 }), H);
  r = b3.onPrice(bar(1, 100, 100, 100, 100));
  check(r.fills.length === 0 && r.orders[0]?.status === "cancelled" && /exceed/.test(r.orders[0].reason), "leverage cap rejects oversize orders", r.orders[0]);
  const ro = b3.submit(order({ id: "ro", instrument: "X", side: "sell", size: 1, reduceOnly: true }), H);
  check(ro[0].status === "rejected", "reduce-only without a position is rejected");
  const small = b3.submit(order({ id: "tiny", instrument: "X", side: "buy", size: 0.001 }), H);
  check(small[0].status === "rejected", "below minimum size is rejected");

  const b4 = mkBroker();
  b4.submit(order({ id: "q", instrument: "X", side: "buy", size: 2 }), 1000);
  r = b4.onPrice(quoteEvent("X", 999, 99, 101));
  check(r.fills.length === 0, "quote older than the order does not fill it");
  r = b4.onPrice(quoteEvent("X", 1001, 99, 101));
  check(r.fills.length === 1 && r.fills[0].price === 101, "paper market buy fills at the ask", r.fills[0]);
  const snap = JSON.parse(JSON.stringify(b4.snapshot()));
  const b5 = mkBroker();
  b5.restore(snap);
  check(b5.positionView("X")?.size === 2 && b5.equity() === b4.equity(), "broker snapshot/restore", b5.positionView("X"));
}

// --- engine ------------------------------------------------------------------------
{
  let engine;
  const sb = await StrategySandbox.create(`const strategy = { ${FEED},
    onCandle(ctx, b) { if (b.c > 105) throw new Error("bad bar"); if (!ctx.position("X")) ctx.buy("X", 1, { tag: "e" }); ctx.state.n = (ctx.state.n || 0) + 1; },
    onFill(ctx, f) { ctx.log("fill", f.tag, f.price); } };`, (op, args) => engine.host(op, args));
  const broker = mkBroker();
  let fatal = null;
  const logs = [];
  engine = new StrategyEngine(sb, rules, new SimVenue(broker, "USDT"), { onFatal: (r) => (fatal = r), onLog: (l) => logs.push(l.msg) });
  engine.start(0, {}, {});
  const feed = (i, c) => {
    const ev = bar(i, c, c, c, c);
    const r = broker.onPrice(ev);
    if (r.fills.length || r.orders.length) engine.pushEvents(ev.end, r.fills, r.orders);
    engine.onBar({ t: i * H, o: c, h: c, l: c, c, v: 0, spread: null, instrument: "X", resolution: "1h" });
  };
  feed(0, 100);
  feed(1, 101);
  check(logs.includes("fill e 101") && engine.state.n === 2, "engine: order → fill → onFill, state kept", { logs, state: engine.state });
  for (let i = 2; i < 7; i++) feed(i, 110);
  check(fatal && /5 errors in a row/.test(fatal) && engine.isStopped, "engine stops after 5 consecutive errors", fatal);
  sb.dispose();
}

// --- backtest ------------------------------------------------------------------------
{
  const bars = [];
  let p = 100;
  for (let i = 0; i < 1500; i++) {
    const drift = Math.sin(i / 40) * 0.6;
    const o = p;
    p = Math.max(10, p + drift + Math.cos(i * 1.7) * 0.3);
    bars.push({ t: i * H, o, h: Math.max(o, p) + 0.2, l: Math.min(o, p) - 0.2, c: p, v: 1, spread: null });
  }
  const code = `const strategy = { params: { f: 10, s: 30 }, data: [{ instrument: "X", resolution: "1h", history: 60 }],
    onCandle(ctx, b) { const c = ta.closes(ctx.candles("X", "1h", 60)); const f = ta.ema(c, ctx.params.f), s = ta.ema(c, ctx.params.s);
      const pos = ctx.position("X"); const size = ctx.roundSize("X", ctx.account().equity * 0.5 / b.c);
      if (ta.crossOver(f, s)) { if (pos) ctx.close("X"); ctx.buy("X", size, { stopLoss: ctx.roundPrice("X", b.c * 0.95) }); }
      if (ta.crossUnder(f, s)) { if (pos) ctx.close("X"); ctx.sell("X", size, { stopLoss: ctx.roundPrice("X", b.c * 1.05) }); } } };`;
  const input = {
    code, params: {}, from: 100 * H, to: 1500 * H, splitAt: 1000 * H, initialEquity: 10_000, currency: "USDT",
    costs: { makerBps: 2, takerBps: 5.5, slippageBps: 1, useSpread: false }, rules: [...rules.values()], fx: { USDT: 1 },
    feeds: [{ instrument: "X", resolution: "1h", bars }], maxLeverage: 10,
  };
  const t0 = Date.now();
  const r1 = await runBacktest(input);
  const r2 = await runBacktest(input);
  check(r1.barsProcessed === 1400 && r1.total.closedTrades > 5 && !r1.stoppedEarly, "backtest runs", { ms: Date.now() - t0, total: r1.total });
  check(JSON.stringify(r1.total) === JSON.stringify(r2.total), "backtest is deterministic");
  const sum = Number((r1.tuning.netPnl + r1.check.netPnl).toFixed(2));
  check(Math.abs(sum - r1.total.netPnl) < 0.05, "tuning + check PnL = total PnL", { tuning: r1.tuning.netPnl, check: r1.check.netPnl, total: r1.total.netPnl });
  check(r1.total.fees > 0 && r1.trades.every((f) => f.time >= 100 * H), "fees charged; no trades during warmup");
}

// --- live venue against a mock platform client -----------------------------------------
{
  const { LiveVenue } = await imp("strategies/liveVenue.js");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let px = 100;
  const positions = [];
  const placed = [];
  let fillSeq = 0;
  let venue;
  const restFills = [];
  const client = {
    getAccount: async () => ({ currency: "USDT", equity: 10_000, balance: 10_000 }),
    getPositions: async () => positions.map((p) => ({ ...p })),
    getOpenOrders: async () => [],
    getFills: async () => restFills.slice(),
    getInstrument: async () => ({ contractSize: 1, contractKind: "linear", quoteCurrency: "USDT" }),
    getQuotes: async () => [{ bid: px, ask: px, last: px }],
    cancelOrder: async () => ({}),
    placeOrder: async (req) => {
      placed.push(req);
      const id = `P${placed.length}`;
      const signed = req.side === "buy" ? req.size : -req.size;
      const cur = positions[0];
      const qty = (cur ? (cur.side === "long" ? cur.size : -cur.size) : 0) + signed;
      positions.length = 0;
      if (Math.abs(qty) > 1e-12) positions.push({ id: "pos1", instrumentId: "X", side: qty > 0 ? "long" : "short", size: Math.abs(qty), entryPrice: cur?.entryPrice ?? px, markPrice: px, unrealizedPnl: 0, stopLoss: req.stopLoss ?? null, takeProfit: null, openedAt: 1 });
      const fill = { id: `E${++fillSeq}`, orderId: `ref-${id}`, instrumentId: "X", side: req.side, size: req.size, price: px, fee: 0.5, feeCurrency: "USDT", realizedPnl: null, time: Date.now() };
      // IG style: the stream fill references the deal reference, the REST fill has a different id.
      setTimeout(() => venue.onAccountEvent({ type: "fill", fill }), 5);
      restFills.unshift({ ...fill, id: `rest-${fill.id}` });
      return { orderId: id, status: "filled", message: null, extra: { dealReference: `ref-${id}` } };
    },
    closePosition: async () => {
      const p = positions[0];
      return client.placeOrder({ instrumentId: "X", side: p.side === "long" ? "sell" : "buy", type: "market", size: p.size, reduceOnly: true });
    },
  };
  let engine;
  const actions = [];
  const sb = await StrategySandbox.create(`const strategy = { ${FEED},
    onStart(ctx) { ctx.buy("X", 2, { tag: "entry", stopLoss: 90 }); },
    onCandle(ctx) { if (ctx.position("X")) ctx.close("X"); },
    onFill(ctx, f) { const p = ctx.position("X"); ctx.log("fill", f.tag, f.reason, f.pnl, p ? p.size : 0); } };`, (op, args) => engine.host(op, args));
  const logs = [];
  venue = new LiveVenue({
    client, runId: "run12345678", instruments: ["X"], risk: {}, maxLeverage: 3, rules, fx: () => 1,
    onAction: (a, args, ok) => actions.push(`${a}:${ok}`), onPlatformOrder: () => {},
    emit: (now, fills, orders) => engine.pushEvents(now, fills, orders),
  });
  await venue.init();
  engine = new StrategyEngine(sb, rules, venue, { onLog: (l) => logs.push(l.msg) });
  engine.start(Date.now(), {}, {});
  await sleep(100);
  check(placed.length === 1 && placed[0].stopLoss === 90 && placed[0].clientOrderId?.startsWith("fbrun12345"), "live: order placed with SL and client order id", placed[0]);
  check(logs.includes("fill entry order 0 2"), "live: stream fill matched via deal reference; ctx.position updated inside onFill", logs);
  // A large order beyond 3x leverage is refused before it reaches the platform.
  engine.pushEvents(Date.now(), [], []);
  px = 110;
  engine.onBar({ t: 0, o: 110, h: 110, l: 110, c: 110, v: 0, spread: null, instrument: "X", resolution: "1h" });
  await sleep(100);
  // The REST poll returns the same fills under different ids: they must not be booked twice.
  await venue["pollFills"]();
  await sleep(50);
  const pnl = venue.pnl(() => 110);
  check(Math.abs(pnl - (20 - 1)) < 1e-9 && venue.state.ledger.X.qty === 0, "live: ledger realized PnL minus fees, REST duplicates ignored", { pnl, ledger: venue.state.ledger, fees: venue.state.fees });
  check(logs.some((m) => m.startsWith("fill close order 20")), "live: closing fill carries realized PnL", logs);
  const bigSb = await StrategySandbox.create(`const strategy = { ${FEED}, onStart(ctx) { ctx.buy("X", 1000); }, onOrder(ctx, o) { ctx.log(o.status, o.reason); }, onCandle() {} };`, (op, args) => engine2.host(op, args));
  let engine2;
  const logs2 = [];
  const v2 = new LiveVenue({ client, runId: "r2", instruments: ["X"], risk: {}, maxLeverage: 3, rules, fx: () => 1, onAction: () => {}, onPlatformOrder: () => {}, emit: (n, f, o) => engine2.pushEvents(n, f, o) });
  await v2.init();
  engine2 = new StrategyEngine(bigSb, rules, v2, { onLog: (l) => logs2.push(l.msg) });
  const before = placed.length;
  engine2.start(Date.now(), {}, {});
  await sleep(100);
  check(placed.length === before && logs2.some((m) => /rejected run limit: position notional/.test(m)), "live: leverage limit blocks the order before the platform", logs2);
  venue.close();
  v2.close();
  sb.dispose();
  bigSb.dispose();
}

console.log(failures === 0 ? "\nALL STRATEGY CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

/** Returned by the get_strategy_guide tool. Keep it accurate when the API changes. */
export const STRATEGY_GUIDE = `# floorbroker strategies

A strategy is a small JavaScript program that floorbroker runs for you on the server, around the clock,
reacting to every new candle (and optionally to live prices) in milliseconds. You write it once, backtest
it, run it on paper with live data, and then live on the account. Floorbroker keeps it running across
restarts. Use strategies for rules you can state precisely; keep discretionary judgement for your own turns.

## Workflow
1. get_strategy_guide (this text) - once.
2. save_strategy - the code is loaded and checked immediately; each save creates a new version.
3. backtest_strategy - on cached/fetched history. The period is split: the first part ("tuning") is what you
   may optimise params on; judge the strategy on the second part ("check", out of sample). A strategy that
   only looks good in tuning is overfitted.
4. start_strategy mode="paper" - simulated fills on the live price stream, no real orders. Let it run a while
   and compare with the backtest (get_strategy_run).
5. start_strategy mode="live" - real orders on the account. Guard rails (limits) stop the run automatically.
6. stop_strategy when done or when it misbehaves. get_strategy_run shows equity, fills, positions and logs.

## Code shape
\`\`\`js
const strategy = {
  name: "EMA trend BTC",
  params: { fast: 20, slow: 50, riskPct: 1, atrMult: 2 },        // defaults; overridable per backtest/run
  data: [{ instrument: "linear:BTCUSDT", resolution: "15m", history: 300 }],  // candle feeds (required)
  ticks: [],                 // instruments whose live quotes should call onTick (optional, max 1 call/s each)

  onStart(ctx) {},           // also called again after a server restart (ctx.state is restored)
  onCandle(ctx, bar) {       // bar = { instrument, resolution, t, o, h, l, c, v } - a just-completed candle
    if (bar.instrument !== "linear:BTCUSDT" || bar.resolution !== "15m") return;
    const bars = ctx.candles(bar.instrument, "15m", 200);         // oldest first, last = this bar
    const c = ta.closes(bars);
    const fast = ta.ema(c, ctx.params.fast), slow = ta.ema(c, ctx.params.slow);
    const atr = ta.last(ta.atr(bars, 14));
    const pos = ctx.position(bar.instrument);
    if (!pos && ta.crossOver(fast, slow) && atr) {
      const eq = ctx.account().equity;
      const stop = bar.c - ctx.params.atrMult * atr;
      const size = ctx.roundSize(bar.instrument, (eq * ctx.params.riskPct / 100) / (bar.c - stop));
      if (size > 0) ctx.buy(bar.instrument, size, { stopLoss: ctx.roundPrice(bar.instrument, stop), tag: "entry" });
    } else if (pos && pos.side === "long" && ta.crossUnder(fast, slow)) {
      ctx.close(bar.instrument);
    }
  },
  onTick(ctx, q) {},         // q = { instrument, time, bid, ask, last }
  onFill(ctx, f) {},         // f = { instrument, side, size, price, fee, pnl, reason: order|stop_loss|take_profit|close, tag }
  onOrder(ctx, o) {},        // o = { id, tag, instrument, status: open|cancelled|rejected, reason }
  onStop(ctx, info) {},      // info.reason
};
\`\`\`

## ctx (the only bridge to floorbroker)
Reads (synchronous):
- ctx.now - current time in ms (Date.now() returns the same; in backtests it is simulated time).
- ctx.params, ctx.state - state is a plain object you may change; it is saved and restored after restarts.
- ctx.candles(instrument, resolution, count) - only declared feeds; at most history+200 candles kept.
- ctx.lastPrice(instrument) - { bid, ask, last, mid, time } or null.
- ctx.position(instrument) - { side: long|short, size, entryPrice, unrealizedPnl, stopLoss, takeProfit } or null.
- ctx.orders(instrument?) - the strategy's resting orders: { id, tag, side, type, size, price, triggerPrice }.
- ctx.account() - { equity, cash, currency }. Paper/backtest: the simulated account.
- ctx.instrument(id) - { minSize, sizeStep, priceTick, contractSize, quoteCurrency }.
- ctx.roundSize(id, size) (floors to the size step, 0 if below minimum), ctx.roundPrice(id, price).
Actions (recorded during the handler, executed right after it returns, in order; a handler that throws
executes nothing):
- ctx.order({ instrument, side: "buy"|"sell", type: "market"|"limit"|"stop", size, price, triggerPrice,
  stopLoss, takeProfit, reduceOnly, tag }) - returns a local order id.
- ctx.buy(instrument, size, opts), ctx.sell(instrument, size, opts) - market unless opts.type is set.
- ctx.cancel(idOrTag), ctx.cancelAll(instrument?), ctx.close(instrument, size?),
  ctx.protect(instrument, { stopLoss, takeProfit }) - set/move the position's SL/TP (null removes).
- ctx.log(...values) - visible in get_strategy_run and in backtest results.
Sizes are in the platform's units (see get_instrument). Only instruments declared in data/ticks can be traded.

## ta (indicators; arrays in, arrays of the same length out, null where not yet defined)
ta.closes/highs/lows(bars), ta.last(arr, back=0), ta.sma, ta.ema, ta.stdev, ta.rsi (values, n),
ta.atr(bars, n), ta.bollinger(values, n, k=2) -> { mid, upper, lower }, ta.highest/lowest(values, n),
ta.crossOver(a, b) / ta.crossUnder(a, b) (b may be a number) - true if it happened on the last element.

## Sandbox rules
Plain JavaScript (ES2023) without network, files, timers, imports or randomness from outside. Each handler
call may take at most 250 ms (onStart 1 s), memory is capped at 32 MB. Five errors in a row stop the run.
Keep handlers deterministic and cheap: compute from ctx.candles instead of keeping huge arrays in state.

## Simulation model (backtest and paper)
- Market orders fill at the next price (backtest: next candle's open) plus slippage; Bybit taker 0.055%,
  maker 0.02% fees; IG uses the bid/ask spread from the data instead of fees.
- Limit orders fill only when the price trades through them; stop orders at the worse of trigger and price.
- Stop loss / take profit are checked from the candle after entry; if both are hit in one candle the stop
  loss wins (conservative). Not simulated: funding/overnight financing, partial fills, liquidity.
- Netting: one position per instrument (buy and sell offset each other).

## Live mode
- Orders go to the account through the same checks as your own orders, including this connection's risk
  limits; they appear in the activity log as strategy:* actions.
- The strategy owns its instruments on that account: only one live run per instrument and account, and
  existing positions on those instruments count as the strategy's. Do not trade them by hand meanwhile.
- Prefer stopLoss/takeProfit on entry orders: they live on the exchange and protect the position even
  when floorbroker or the strategy is down.
- Run limits (defaults): max_drawdown_pct 10 (from the start equity; live: of the account equity at start,
  counting only this run's PnL), max_daily_loss_pct 5, max_leverage 3 (position notional / equity),
  max_orders_per_minute 20. Drawdown and daily loss stop the run and close its positions; the others block
  the order. Choose them deliberately in start_strategy.
- stop_strategy cancels the run's resting orders; close_positions=true also closes its positions.
`;

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { logger } from "../logger.js";
import { PlatformError } from "../platforms/errors.js";
import { RESOLUTIONS, type PlatformClient, type PlatformDefinition, type Resolution } from "../platforms/types.js";
import type { PlatformAccountRow } from "../repos/accounts.js";
import type { Connection } from "../repos/connections.js";
import { checkLeverage, checkOrder, hasLimits, instrumentAllowed } from "../services/risk.js";
import { iso, parseTime, present } from "./present.js";
import { registerStrategyTools } from "./strategyTools.js";

export interface McpCaller {
  userId: string;
  connection: Connection;
  ip: string | null;
}

export interface ToolEnv {
  ctx: AppContext;
  caller: McpCaller;
}

interface AccountHandle {
  row: PlatformAccountRow;
  platform: PlatformDefinition;
  client: PlatformClient;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const MAX_LOGGED_RESULT = 8000;

// --- shared schema pieces ----------------------------------------------------

const accountId = z.string().min(1).max(100).describe("Account id from list_accounts.");
const instrumentId = z.string().min(1).max(200).describe("Platform instrument id, as returned by search_instruments.");
const timeArg = (what: string) =>
  z.string().max(40).optional().describe(`${what} as ISO 8601 UTC, e.g. 2026-01-31T12:00:00Z.`);
const limitArg = (def: number, max: number) => z.number().int().min(1).max(max).default(def).describe(`Maximum items (default ${def}, max ${max}).`);
const price = z.number().positive().finite();

// --- helpers ----------------------------------------------------------------

export function resolveAccount(env: ToolEnv, id: string, opts: { trade?: boolean } = {}): AccountHandle {
  const { ctx, caller } = env;
  const row = ctx.accounts.findForUser(id, caller.userId);
  if (!row || !caller.connection.accountIds.includes(row.id)) {
    throw new PlatformError("not_found", `Unknown account_id "${id}". Call list_accounts to see the accounts available to you.`);
  }
  if (row.is_active !== 1) throw new PlatformError("permission_denied", "This account is disabled by its owner.");
  if (opts.trade) {
    if (caller.connection.can_trade !== 1) {
      throw new PlatformError("permission_denied", "This connection is read-only. The account owner can enable trading in floorbroker.");
    }
    if (row.can_trade !== 1) {
      throw new PlatformError("permission_denied", "The API credentials of this account are read-only, so orders cannot be placed.");
    }
  }
  const platform = ctx.accountService.platformOf(row);
  return { row, platform, client: ctx.accountService.client(row) };
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(present(data)) }] };
}

function errorResult(err: unknown): ToolResult {
  if (err instanceof PlatformError) {
    return { content: [{ type: "text", text: JSON.stringify({ error: err.code, message: err.message }) }], isError: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: JSON.stringify({ error: "error", message }) }], isError: true };
}

function requireCapability(h: AccountHandle, has: boolean, what: string): void {
  if (!has) throw new PlatformError("unsupported", `${what} is not supported on ${h.platform.name}.`);
}

/** Registers a tool with uniform logging, error mapping and result shaping. */
export function tool<S extends z.ZodRawShape>(
  server: McpServer,
  env: ToolEnv,
  name: string,
  def: { title: string; description: string; input: S; trade?: boolean },
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
): void {
  server.registerTool(
    name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.input,
      annotations: def.trade
        ? { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
        : { readOnlyHint: true, openWorldHint: true },
    },
    (async (args: z.infer<z.ZodObject<S>>) => {
      const started = Date.now();
      let result: ToolResult;
      let error: string | null = null;
      let data: unknown = null;
      try {
        data = await handler(args);
        result = ok(data);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        if (!(err instanceof PlatformError)) logger.warn("tool failed", { tool: name, err: error });
        result = errorResult(err);
      }
      try {
        const text = result.content[0]?.text ?? "";
        env.ctx.activity.recordToolCall({
          user_id: env.caller.userId,
          connection_id: env.caller.connection.id,
          account_id: typeof (args as { account_id?: unknown }).account_id === "string" ? (args as { account_id: string }).account_id : null,
          tool: name,
          is_trade: def.trade ? 1 : 0,
          args_json: JSON.stringify(args),
          result_json: text.length > MAX_LOGGED_RESULT ? text.slice(0, MAX_LOGGED_RESULT) + "…" : text,
          ok: error ? 0 : 1,
          error,
          duration_ms: Date.now() - started,
          created_at: started,
        });
        env.ctx.connections.markUsed(env.caller.connection.id);
      } catch (logErr) {
        logger.error("failed to record tool call", { err: String(logErr) });
      }
      return result;
    }) as never,
  );
}

function rememberOrder(env: ToolEnv, accountIdValue: string, orderId: string | null | undefined, instrument: string): void {
  if (!orderId) return;
  env.ctx.activity.recordAgentOrder({ accountId: accountIdValue, connectionId: env.caller.connection.id, orderId, instrumentId: instrument });
}

function accountView(env: ToolEnv, row: PlatformAccountRow) {
  const platform = env.ctx.accountService.platformOf(row);
  const conn = env.caller.connection;
  return {
    accountId: row.id,
    label: row.label,
    platform: platform.id,
    platformName: platform.name,
    environment: row.agent_environment,
    currency: row.currency,
    canTrade: conn.can_trade === 1 && row.can_trade === 1,
    capabilities: {
      instrumentTypes: platform.capabilities.instrumentTypes,
      orderTypes: platform.capabilities.orderTypes,
      timeInForce: platform.capabilities.timeInForce,
      resolutions: platform.capabilities.resolutions,
      orderBook: platform.capabilities.orderBook,
      setLeverage: platform.capabilities.setLeverage,
      amendOrder: platform.capabilities.amendOrder,
      stopLossTakeProfit: platform.capabilities.stopLossTakeProfit,
      trailingStop: platform.capabilities.trailingStop,
      guaranteedStop: platform.capabilities.guaranteedStop,
      hedgeMode: platform.capabilities.hedgeMode,
    },
    platformNotes: platform.capabilities.notes,
    riskLimits: hasLimits(conn.risk) ? conn.risk : undefined,
  };
}

// --- registration ------------------------------------------------------------

export function registerTools(server: McpServer, ctx: AppContext, caller: McpCaller): void {
  const env: ToolEnv = { ctx, caller };
  const canTrade = caller.connection.can_trade === 1;

  tool(
    server,
    env,
    "list_accounts",
    {
      title: "List accounts",
      description:
        "List the trading accounts you can use, with platform, environment (live/demo), currency, whether you may trade, " +
        "supported instrument types/order types/candle resolutions, platform notes, and any risk limits that apply to you. Call this first.",
      input: {},
    },
    async () => {
      const rows = ctx.accounts
        .listForUser(caller.userId)
        .filter((r) => caller.connection.accountIds.includes(r.id) && r.is_active === 1);
      return { serverTime: Date.now(), accounts: rows.map((r) => accountView(env, r)) };
    },
  );

  tool(
    server,
    env,
    "get_account",
    {
      title: "Get account balances",
      description: "Equity, cash balance, available funds, unrealized PnL, margin in use and per-asset balances of an account.",
      input: { account_id: accountId },
    },
    async ({ account_id }) => {
      const h = resolveAccount(env, account_id);
      const summary = await h.client.getAccount();
      return { accountId: h.row.id, environment: h.row.agent_environment, platform: h.platform.id, ...summary };
    },
  );

  tool(
    server,
    env,
    "search_instruments",
    {
      title: "Search instruments",
      description:
        "Find tradable instruments by name or symbol (e.g. 'BTC', 'EUR/USD', 'DAX', 'Apple'). Returns instrument ids to use with other tools.",
      input: {
        account_id: accountId,
        query: z.string().max(100).optional().describe("Search text: symbol, coin or market name."),
        type: z.enum(["spot", "perpetual", "future", "option", "cfd", "spreadbet", "other"]).optional().describe("Filter by instrument type."),
        limit: limitArg(20, 100),
      },
    },
    async ({ account_id, query, type, limit }) => {
      const h = resolveAccount(env, account_id);
      const items = await h.client.searchInstruments({ query, type, limit });
      return { instruments: items.slice(0, limit) };
    },
  );

  tool(
    server,
    env,
    "get_instrument",
    {
      title: "Get instrument details",
      description:
        "Trading rules of an instrument: what one unit of size means, minimum/maximum size, size step, price tick, contract size, " +
        "leverage/margin, expiry/strike for derivatives, minimum stop distance and market status. Check this before placing orders.",
      input: { account_id: accountId, instrument_id: instrumentId },
    },
    async ({ account_id, instrument_id }) => {
      const h = resolveAccount(env, account_id);
      return { instrument: await h.client.getInstrument(instrument_id) };
    },
  );

  tool(
    server,
    env,
    "get_quotes",
    {
      title: "Get current prices",
      description:
        "Current bid/ask/last prices and 24h statistics for up to 20 instruments. Includes funding rate for perpetuals and greeks/IV for options where available.",
      input: { account_id: accountId, instrument_ids: z.array(instrumentId).min(1).max(20) },
    },
    async ({ account_id, instrument_ids }) => {
      const h = resolveAccount(env, account_id);
      return { quotes: await h.client.getQuotes(instrument_ids) };
    },
  );

  tool(
    server,
    env,
    "get_order_book",
    {
      title: "Get order book",
      description: "Level-2 order book (price, size) for an instrument. Only on platforms with the orderBook capability.",
      input: { account_id: accountId, instrument_id: instrumentId, depth: z.number().int().min(1).max(200).default(25) },
    },
    async ({ account_id, instrument_id, depth }) => {
      const h = resolveAccount(env, account_id);
      requireCapability(h, h.platform.capabilities.orderBook && !!h.client.getOrderBook, "Order book data");
      return await h.client.getOrderBook!(instrument_id, depth);
    },
  );

  tool(
    server,
    env,
    "get_candles",
    {
      title: "Get historic candles",
      description:
        "Historic OHLC candles. Finished candles are cached on this server forever, so repeated requests are free; only missing ranges are fetched " +
        "from the platform. Some platforms limit historic data (e.g. IG has a weekly allowance); the response's `quota` shows the current state. " +
        "Check list_cached_candles first and request only what you need. Use cache_only=true to read stored data without touching the platform. " +
        "Rows are [time, open, high, low, close, volume] (plus spread when the platform provides bid/ask; prices are then mid prices).",
      input: {
        account_id: accountId,
        instrument_id: instrumentId,
        resolution: z.enum(RESOLUTIONS).describe("Candle size. Supported values per platform are listed in list_accounts capabilities."),
        from: timeArg("Start time (inclusive)"),
        to: timeArg("End time (exclusive), default now"),
        limit: limitArg(200, 5000),
        cache_only: z.boolean().default(false).describe("Only return cached candles; never call the platform."),
      },
    },
    async ({ account_id, instrument_id, resolution, from, to, limit, cache_only }) => {
      const h = resolveAccount(env, account_id);
      if (!h.platform.capabilities.resolutions.includes(resolution as Resolution)) {
        throw new PlatformError(
          "invalid_request",
          `Resolution ${resolution} is not supported on ${h.platform.name}. Supported: ${h.platform.capabilities.resolutions.join(", ")}.`,
        );
      }
      const res = await ctx.candles.get(h.client, {
        instrumentId: instrument_id,
        resolution: resolution as Resolution,
        from: parseTime(from, "from"),
        to: parseTime(to, "to"),
        limit,
        cacheOnly: cache_only,
      });
      const withSpread = res.candles.some((c) => c.spread !== null);
      const quota = res.quota ?? (cache_only ? null : await h.client.getQuota().catch(() => null));
      return {
        instrumentId: instrument_id,
        resolution,
        from: res.from,
        to: res.to,
        columns: withSpread ? ["time", "open", "high", "low", "close", "volume", "spread"] : ["time", "open", "high", "low", "close", "volume"],
        rows: res.candles.map((c) =>
          withSpread ? [iso(c.t), c.o, c.h, c.l, c.c, c.v, c.spread] : [iso(c.t), c.o, c.h, c.l, c.c, c.v],
        ),
        count: res.candles.length,
        fetchedFromPlatform: res.stats.fetched,
        truncated: res.stats.truncated || undefined,
        quota,
      };
    },
  );

  tool(
    server,
    env,
    "list_cached_candles",
    {
      title: "List cached candle data",
      description:
        "Show which historic candle ranges are already stored on this server for the account's platform (free to read via get_candles), " +
        "plus the platform's current historic data quota.",
      input: { account_id: accountId, instrument_id: instrumentId.optional() },
    },
    async ({ account_id, instrument_id }) => {
      const h = resolveAccount(env, account_id);
      const ranges = ctx.candles.coverage(h.client.marketDataKey(), instrument_id).map((r) => ({
        instrumentId: r.instrument_id,
        resolution: r.resolution,
        from: r.from_ts,
        to: r.to_ts,
        candles: r.candles,
      }));
      return { ranges, quota: await h.client.getQuota().catch(() => null) };
    },
  );

  tool(
    server,
    env,
    "get_positions",
    {
      title: "Get open positions",
      description: "Open positions with size, entry/mark price, unrealized PnL, leverage, liquidation price and attached stop loss/take profit.",
      input: { account_id: accountId, instrument_id: instrumentId.optional() },
    },
    async ({ account_id, instrument_id }) => {
      const h = resolveAccount(env, account_id);
      return { environment: h.row.agent_environment, positions: await h.client.getPositions({ instrumentId: instrument_id }) };
    },
  );

  tool(
    server,
    env,
    "get_orders",
    {
      title: "Get orders",
      description: "Open (working) orders, or order history with status open/filled/cancelled/rejected.",
      input: {
        account_id: accountId,
        status: z.enum(["open", "history"]).default("open"),
        instrument_id: instrumentId.optional(),
        from: timeArg("History start"),
        to: timeArg("History end"),
        limit: limitArg(50, 500),
      },
    },
    async ({ account_id, status, instrument_id, from, to, limit }) => {
      const h = resolveAccount(env, account_id);
      const orders =
        status === "open"
          ? await h.client.getOpenOrders({ instrumentId: instrument_id })
          : await h.client.getOrderHistory({ instrumentId: instrument_id, from: parseTime(from, "from"), to: parseTime(to, "to"), limit });
      return { orders: orders.slice(0, limit) };
    },
  );

  tool(
    server,
    env,
    "get_fills",
    {
      title: "Get trade executions",
      description: "Executed trades (fills) with price, size, fee and realized PnL where reported.",
      input: { account_id: accountId, instrument_id: instrumentId.optional(), from: timeArg("Start"), to: timeArg("End"), limit: limitArg(50, 500) },
    },
    async ({ account_id, instrument_id, from, to, limit }) => {
      const h = resolveAccount(env, account_id);
      const fills = await h.client.getFills({ instrumentId: instrument_id, from: parseTime(from, "from"), to: parseTime(to, "to"), limit });
      return { fills: fills.slice(0, limit) };
    },
  );

  tool(
    server,
    env,
    "get_closed_pnl",
    {
      title: "Get realized PnL",
      description: "Closed positions with entry/exit price and realized PnL.",
      input: { account_id: accountId, instrument_id: instrumentId.optional(), from: timeArg("Start"), to: timeArg("End"), limit: limitArg(50, 500) },
    },
    async ({ account_id, instrument_id, from, to, limit }) => {
      const h = resolveAccount(env, account_id);
      const rows = await h.client.getClosedPnl({ instrumentId: instrument_id, from: parseTime(from, "from"), to: parseTime(to, "to"), limit });
      const total = rows.reduce((s, r) => s + r.pnl, 0);
      return { closed: rows.slice(0, limit), totalPnl: Math.round(total * 1e8) / 1e8 };
    },
  );

  // Strategy tools are available to read-only connections too (backtests, paper runs); live runs check trading access.
  registerStrategyTools(server, env);

  if (!canTrade) return;

  // --- trading tools (only listed for connections that may trade) ------------

  tool(
    server,
    env,
    "place_order",
    {
      title: "Place order",
      description:
        "Place an order. Real orders with real risk, also on demo accounts — double-check instrument, side and size. " +
        "`size` is in the instrument's size unit (see get_instrument: sizeUnit, minSize, sizeStep). " +
        "market: executes now. limit: needs price. stop: market order triggered at trigger_price. stop_limit: limit order at price triggered at trigger_price. " +
        "Attach stop_loss/take_profit prices where supported. reduce_only only reduces an existing position.",
      trade: true,
      input: {
        account_id: accountId,
        instrument_id: instrumentId,
        side: z.enum(["buy", "sell"]),
        type: z.enum(["market", "limit", "stop", "stop_limit"]),
        size: z.number().positive().finite(),
        price: price.optional().describe("Limit price (limit, stop_limit)."),
        trigger_price: price.optional().describe("Trigger price (stop, stop_limit)."),
        time_in_force: z.enum(["gtc", "ioc", "fok", "post_only", "day"]).optional(),
        reduce_only: z.boolean().optional(),
        stop_loss: price.optional().describe("Stop-loss price for the resulting position."),
        take_profit: price.optional().describe("Take-profit price for the resulting position."),
        trailing_stop_distance: price.optional().describe("Trailing stop distance in price units (platforms with trailingStop)."),
        guaranteed_stop: z.boolean().optional().describe("Use a guaranteed stop (platforms with guaranteedStop; may cost a premium)."),
        position_side: z.enum(["long", "short"]).optional().describe("Optional, hedge-mode accounts only (see position_mode in get_account): which position the order belongs to. Usually unnecessary: the side is derived automatically and it is ignored on one-way accounts."),
        client_order_id: z.string().max(36).optional(),
      },
    },
    async (a) => {
      const h = resolveAccount(env, a.account_id, { trade: true });
      const caps = h.platform.capabilities;
      if (!caps.orderTypes.includes(a.type)) {
        throw new PlatformError("unsupported", `Order type ${a.type} is not supported on ${h.platform.name}. Supported: ${caps.orderTypes.join(", ")}.`);
      }
      if ((a.type === "limit" || a.type === "stop_limit") && a.price === undefined) throw new PlatformError("invalid_request", `${a.type} orders need price.`);
      if ((a.type === "stop" || a.type === "stop_limit") && a.trigger_price === undefined) {
        throw new PlatformError("invalid_request", `${a.type} orders need trigger_price.`);
      }
      if (a.guaranteed_stop && !caps.guaranteedStop) throw new PlatformError("unsupported", `Guaranteed stops are not available on ${h.platform.name}.`);
      if (a.trailing_stop_distance !== undefined && !caps.trailingStop) throw new PlatformError("unsupported", `Trailing stops are not available on ${h.platform.name}.`);
      const req = {
        instrumentId: a.instrument_id,
        side: a.side,
        type: a.type,
        size: a.size,
        price: a.price,
        triggerPrice: a.trigger_price,
        timeInForce: a.time_in_force,
        reduceOnly: a.reduce_only,
        stopLoss: a.stop_loss,
        takeProfit: a.take_profit,
        trailingStopDistance: a.trailing_stop_distance,
        guaranteedStop: a.guaranteed_stop,
        positionSide: a.position_side,
        clientOrderId: a.client_order_id,
      };
      await checkOrder(h.client, caller.connection.risk, req);
      const result = await h.client.placeOrder(req);
      rememberOrder(env, h.row.id, result.orderId, a.instrument_id);
      return { environment: h.row.agent_environment, result };
    },
  );

  tool(
    server,
    env,
    "amend_order",
    {
      title: "Amend order",
      description: "Change price, trigger price, size or attached stop loss/take profit of an open order (platforms with amendOrder).",
      trade: true,
      input: {
        account_id: accountId,
        order_id: z.string().min(1).max(100),
        instrument_id: instrumentId.optional().describe("Instrument of the order (speeds up lookup; required on some platforms)."),
        size: z.number().positive().finite().optional(),
        price: price.optional(),
        trigger_price: price.optional(),
        stop_loss: price.nullable().optional().describe("New stop loss, or null to remove."),
        take_profit: price.nullable().optional().describe("New take profit, or null to remove."),
      },
    },
    async (a) => {
      const h = resolveAccount(env, a.account_id, { trade: true });
      requireCapability(h, h.platform.capabilities.amendOrder && !!h.client.amendOrder, "Amending orders");
      if (a.instrument_id && !instrumentAllowed(caller.connection.risk, a.instrument_id)) {
        throw new PlatformError("permission_denied", `Blocked by this connection's risk limits: instrument ${a.instrument_id} is not allowed.`);
      }
      const result = await h.client.amendOrder!({
        orderId: a.order_id,
        instrumentId: a.instrument_id,
        size: a.size,
        price: a.price,
        triggerPrice: a.trigger_price,
        stopLoss: a.stop_loss,
        takeProfit: a.take_profit,
      });
      return { environment: h.row.agent_environment, result };
    },
  );

  tool(
    server,
    env,
    "cancel_order",
    {
      title: "Cancel order",
      description: "Cancel an open order.",
      trade: true,
      input: { account_id: accountId, order_id: z.string().min(1).max(100), instrument_id: instrumentId.optional() },
    },
    async ({ account_id, order_id, instrument_id }) => {
      const h = resolveAccount(env, account_id, { trade: true });
      return { environment: h.row.agent_environment, result: await h.client.cancelOrder({ orderId: order_id, instrumentId: instrument_id }) };
    },
  );

  tool(
    server,
    env,
    "cancel_all_orders",
    {
      title: "Cancel all orders",
      description: "Cancel all open orders of the account, optionally only for one instrument.",
      trade: true,
      input: { account_id: accountId, instrument_id: instrumentId.optional() },
    },
    async ({ account_id, instrument_id }) => {
      const h = resolveAccount(env, account_id, { trade: true });
      return { environment: h.row.agent_environment, ...(await h.client.cancelAllOrders({ instrumentId: instrument_id })) };
    },
  );

  tool(
    server,
    env,
    "close_position",
    {
      title: "Close position",
      description: "Close an open position fully or partially (size), at market by default or with a limit price.",
      trade: true,
      input: {
        account_id: accountId,
        position_id: z.string().min(1).max(200).describe("Position id from get_positions."),
        size: z.number().positive().finite().optional().describe("Partial close size; omit to close the whole position."),
        type: z.enum(["market", "limit"]).default("market"),
        price: price.optional().describe("Limit price when type is limit."),
      },
    },
    async ({ account_id, position_id, size, type, price: p }) => {
      const h = resolveAccount(env, account_id, { trade: true });
      if (type === "limit" && p === undefined) throw new PlatformError("invalid_request", "A limit close needs price.");
      const result = await h.client.closePosition({ positionId: position_id, size, type, price: p });
      rememberOrder(env, h.row.id, result.orderId, position_id);
      return { environment: h.row.agent_environment, result };
    },
  );

  tool(
    server,
    env,
    "set_position_protection",
    {
      title: "Set stop loss / take profit",
      description:
        "Set, change or remove the stop loss, take profit and trailing stop of an open position. Omit a field to keep it, pass null to remove it.",
      trade: true,
      input: {
        account_id: accountId,
        position_id: z.string().min(1).max(200),
        stop_loss: price.nullable().optional(),
        take_profit: price.nullable().optional(),
        trailing_stop_distance: price.nullable().optional(),
      },
    },
    async ({ account_id, position_id, stop_loss, take_profit, trailing_stop_distance }) => {
      const h = resolveAccount(env, account_id, { trade: true });
      requireCapability(h, h.platform.capabilities.stopLossTakeProfit && !!h.client.setPositionProtection, "Position stop loss / take profit");
      const position = await h.client.setPositionProtection!({
        positionId: position_id,
        stopLoss: stop_loss,
        takeProfit: take_profit,
        trailingStopDistance: trailing_stop_distance,
      });
      return { environment: h.row.agent_environment, position };
    },
  );

  tool(
    server,
    env,
    "set_leverage",
    {
      title: "Set leverage",
      description: "Set the leverage for an instrument (platforms with setLeverage, e.g. crypto derivatives).",
      trade: true,
      input: { account_id: accountId, instrument_id: instrumentId, leverage: z.number().positive().max(1000) },
    },
    async ({ account_id, instrument_id, leverage }) => {
      const h = resolveAccount(env, account_id, { trade: true });
      requireCapability(h, h.platform.capabilities.setLeverage && !!h.client.setLeverage, "Setting leverage");
      checkLeverage(caller.connection.risk, instrument_id, leverage);
      return { environment: h.row.agent_environment, ...(await h.client.setLeverage!({ instrumentId: instrument_id, leverage })) };
    },
  );
}

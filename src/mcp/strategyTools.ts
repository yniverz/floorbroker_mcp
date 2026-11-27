import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PlatformError } from "../platforms/errors.js";
import { runLimits, runParams, versionDeclaration, type StrategyRunRow } from "../repos/strategies.js";
import { compileStrategy, DEFAULT_RUN_LIMITS } from "../services/strategies.js";
import { STRATEGY_GUIDE } from "../strategies/guide.js";
import { StrategyError } from "../strategies/sandbox.js";
import { iso, parseTime } from "./present.js";
import { resolveAccount, tool, type ToolEnv } from "./tools.js";

const strategyId = z.string().min(1).max(100).describe("Strategy id from list_strategies / save_strategy.");
const runId = z.string().min(1).max(100).describe("Run id from start_strategy / list_strategies.");
const params = z.record(z.string(), z.unknown()).optional().describe("Overrides for strategy.params.");
const MAX_CODE = 100_000;

function findStrategy(env: ToolEnv, id: string) {
  const s = env.ctx.strategies.repo.find(id, env.caller.userId);
  if (!s) throw new PlatformError("not_found", `Unknown strategy_id "${id}". Call list_strategies.`);
  return s;
}

function findRun(env: ToolEnv, id: string): StrategyRunRow {
  const r = env.ctx.strategies.repo.runForUser(id, env.caller.userId);
  if (!r || !env.caller.connection.accountIds.includes(r.account_id)) throw new PlatformError("not_found", `Unknown run_id "${id}".`);
  return r;
}

function runSummary(env: ToolEnv, r: StrategyRunRow) {
  const repo = env.ctx.strategies.repo;
  const stats = repo.fillStats(r.id);
  const live = env.ctx.strategies.snapshot(r.id);
  const equity = live?.equity ?? r.last_equity;
  return {
    runId: r.id,
    strategyId: r.strategy_id,
    version: r.version,
    accountId: r.account_id,
    mode: r.mode,
    status: r.status,
    startedAt: iso(r.started_at),
    stoppedAt: iso(r.stopped_at),
    stopReason: r.stop_reason,
    currency: r.currency,
    startEquity: r.start_equity,
    equity,
    pnl: equity !== null && r.start_equity !== null ? Number((equity - r.start_equity).toFixed(4)) : null,
    closedTrades: stats.closes,
    winRatePct: stats.closes ? Number(((stats.wins / stats.closes) * 100).toFixed(1)) : null,
    fees: Number(stats.fees.toFixed(4)),
  };
}

export function registerStrategyTools(server: McpServer, env: ToolEnv): void {
  const { ctx, caller } = env;
  const svc = ctx.strategies;

  tool(
    server,
    env,
    "get_strategy_guide",
    {
      title: "Strategy guide",
      description:
        "How to write, backtest, paper-trade and run automated strategies (JavaScript run by floorbroker 24/7 on live data). " +
        "Read this once before using save_strategy.",
      input: {},
    },
    async () => ({ guide: STRATEGY_GUIDE }),
  );

  tool(
    server,
    env,
    "list_strategies",
    {
      title: "List strategies",
      description: "Your saved strategies with their latest version, plus active and recent runs (paper/live) with equity and PnL.",
      input: { include_archived: z.boolean().default(false) },
    },
    async ({ include_archived }) => {
      const strategies = svc.repo.list(caller.userId, include_archived).map((s) => ({
        strategyId: s.id,
        name: s.name,
        description: s.description,
        latestVersion: s.latest_version,
        archived: s.archived === 1 || undefined,
        updatedAt: iso(s.updated_at),
      }));
      const runs = svc.repo
        .runs({ userId: caller.userId, limit: 30 })
        .filter((r) => caller.connection.accountIds.includes(r.account_id))
        .filter((r) => r.status === "running" || Date.now() - (r.stopped_at ?? 0) < 7 * 86_400_000)
        .map((r) => runSummary(env, r));
      return { strategies, runs };
    },
  );

  tool(
    server,
    env,
    "get_strategy",
    {
      title: "Get strategy",
      description: "Code and declaration of a strategy version (default latest), its version history and recent backtest summaries.",
      input: { strategy_id: strategyId, version: z.number().int().positive().optional() },
    },
    async ({ strategy_id, version }) => {
      const s = findStrategy(env, strategy_id);
      const v = svc.repo.version(s.id, version ?? s.latest_version);
      if (!v) throw new PlatformError("not_found", `Version ${version} does not exist.`);
      return {
        strategyId: s.id,
        name: s.name,
        description: s.description,
        version: v.version,
        note: v.note,
        code: v.code,
        declaration: versionDeclaration(v),
        versions: svc.repo.versions(s.id).map((x) => ({ version: x.version, note: x.note, createdAt: iso(x.created_at) })),
        backtests: svc.repo.backtests(s.id, 10).map((b) => ({ backtestId: b.id, version: b.version, createdAt: iso(b.created_at), request: b.request, summary: b.summary })),
      };
    },
  );

  tool(
    server,
    env,
    "save_strategy",
    {
      title: "Save strategy",
      description:
        "Create a strategy or save a new version of it. The code is loaded in the sandbox right away; syntax errors and a missing " +
        "`strategy` object are reported. Running runs keep their version; start a new run to use the new one. See get_strategy_guide.",
      input: {
        strategy_id: strategyId.optional().describe("Omit to create a new strategy."),
        name: z.string().min(1).max(120).optional().describe("Required for a new strategy."),
        description: z.string().max(2000).optional(),
        code: z.string().min(1).max(MAX_CODE),
        note: z.string().max(2000).optional().describe("What changed in this version."),
      },
    },
    async ({ strategy_id, name, description, code, note }) => {
      let declaration;
      try {
        declaration = await compileStrategy(code);
      } catch (err) {
        if (err instanceof StrategyError) throw new PlatformError("invalid_request", `The strategy does not load: ${err.message}`);
        throw err;
      }
      let s;
      if (strategy_id) {
        s = findStrategy(env, strategy_id);
        if (name !== undefined || description !== undefined) svc.repo.update(s.id, caller.userId, { name, description });
      } else {
        if (!name) throw new PlatformError("invalid_request", "name is required for a new strategy.");
        s = svc.repo.create(caller.userId, name, description ?? null);
      }
      const version = svc.repo.addVersion(s.id, code, note ?? null, declaration, caller.connection.id);
      return { strategyId: s.id, version, declaration };
    },
  );

  tool(
    server,
    env,
    "backtest_strategy",
    {
      title: "Backtest strategy",
      description:
        "Run a strategy version on historic candles of an account's platform (data from the server's cache; missing candles are fetched). " +
        "Results are split into a tuning period and an out-of-sample check period. Costs: Bybit fees + slippage, IG spreads. " +
        "On IG, fetching uncached history spends the weekly data allowance and needs allow_fetch=true (the error tells you how much).",
      input: {
        strategy_id: strategyId,
        version: z.number().int().positive().optional().describe("Default: latest."),
        account_id: z.string().min(1).max(100).describe("Account whose platform provides data and instrument rules."),
        from: z.string().max(40).optional().describe("Start (ISO 8601 UTC). Default: 30 days before `to`."),
        to: z.string().max(40).optional().describe("End (ISO 8601 UTC). Default: now."),
        params,
        initial_equity: z.number().positive().default(10_000).describe("Simulated starting equity in the account currency."),
        tuning_share: z.number().min(0.1).max(1).default(0.7).describe("Share of the period for tuning; the rest is the check period."),
        max_leverage: z.number().positive().max(100).default(10).describe("Orders that would exceed this notional/equity are rejected."),
        allow_fetch: z.boolean().default(false).describe("Allow spending the platform's historic data allowance (IG)."),
        slippage_bps: z.number().min(0).max(500).optional().describe("Override slippage in basis points."),
      },
    },
    async (a) => {
      const h = resolveAccount(env, a.account_id);
      const s = findStrategy(env, a.strategy_id);
      const v = svc.repo.version(s.id, a.version ?? s.latest_version);
      if (!v) throw new PlatformError("not_found", `Version ${a.version} does not exist.`);
      const to = Math.min(parseTime(a.to, "to") ?? Date.now(), Date.now());
      const from = parseTime(a.from, "from") ?? to - 30 * 86_400_000;
      if (from >= to) throw new PlatformError("invalid_request", "`from` must be before `to`.");
      const result = await svc.backtest({
        account: h.row,
        code: v.code,
        declaration: versionDeclaration(v),
        params: a.params ?? {},
        from,
        to,
        tuningShare: a.tuning_share,
        initialEquity: a.initial_equity,
        currency: h.row.currency ?? "USD",
        maxLeverage: a.max_leverage,
        allowFetch: a.allow_fetch,
        costs: a.slippage_bps !== undefined ? { slippageBps: a.slippage_bps } : undefined,
      });
      const fmt = (m: typeof result.total) => ({ ...m, from: iso(m.from), to: iso(m.to) });
      const summary = {
        total: fmt(result.total),
        tuning: fmt(result.tuning),
        check: fmt(result.check),
        stoppedEarly: result.stoppedEarly,
        barsProcessed: result.barsProcessed,
        data: result.data,
      };
      const request = { from: iso(from), to: iso(to), params: a.params ?? {}, initialEquity: a.initial_equity, tuningShare: a.tuning_share, accountId: h.row.id };
      const backtestId = svc.repo.addBacktest(s.id, v.version, h.row.id, request, summary);
      return {
        backtestId,
        strategyId: s.id,
        version: v.version,
        currency: h.row.currency ?? "USD",
        ...summary,
        costs: result.costs,
        equityCurve: result.equity.filter((_, i, arr) => arr.length <= 60 || i % Math.ceil(arr.length / 60) === 0 || i === arr.length - 1).map(([t, e]) => [iso(t), e]),
        lastTrades: result.trades.slice(-25).map((f) => ({ time: iso(f.time), instrument: f.instrument, side: f.side, size: f.size, price: f.price, fee: f.fee, pnl: f.pnl, reason: f.reason, tag: f.tag })),
        logs: result.logs.slice(-40).map((l) => `${iso(l.t)} ${l.msg}`),
        notes: result.notes,
      };
    },
  );

  tool(
    server,
    env,
    "start_strategy",
    {
      title: "Start strategy",
      description:
        "Start a strategy version on an account. mode=paper simulates fills on the live price stream (no orders); mode=live places real orders " +
        "on the account (needs trading permission) and is protected by run limits: drawdown and daily loss stop the run and close its positions, " +
        "leverage and order rate block orders. Runs survive server restarts. Only one live run per instrument and account.",
      trade: true,
      input: {
        strategy_id: strategyId,
        version: z.number().int().positive().optional().describe("Default: latest."),
        account_id: z.string().min(1).max(100),
        mode: z.enum(["paper", "live"]),
        params,
        paper_equity: z.number().positive().optional().describe("Paper mode: simulated starting equity (default 10000, account currency)."),
        max_drawdown_pct: z.number().positive().max(100).optional().describe(`Default ${DEFAULT_RUN_LIMITS.maxDrawdownPct}.`),
        max_daily_loss_pct: z.number().positive().max(100).optional().describe(`Default ${DEFAULT_RUN_LIMITS.maxDailyLossPct}.`),
        max_leverage: z.number().positive().max(100).optional().describe(`Position notional / equity. Default ${DEFAULT_RUN_LIMITS.maxLeverage}.`),
        max_orders_per_minute: z.number().int().positive().max(600).optional().describe(`Default ${DEFAULT_RUN_LIMITS.maxOrdersPerMinute}.`),
      },
    },
    async (a) => {
      const h = resolveAccount(env, a.account_id, { trade: a.mode === "live" });
      if (!h.client.stream) throw new PlatformError("unsupported", `${h.platform.name} has no live data stream, so strategies cannot run there.`);
      const s = findStrategy(env, a.strategy_id);
      const version = a.version ?? s.latest_version;
      const row = await svc.start({
        userId: caller.userId,
        connection: caller.connection,
        account: h.row,
        strategyId: s.id,
        version,
        mode: a.mode,
        params: a.params ?? {},
        limits: {
          maxDrawdownPct: a.max_drawdown_pct,
          maxDailyLossPct: a.max_daily_loss_pct,
          maxLeverage: a.max_leverage,
          maxOrdersPerMinute: a.max_orders_per_minute,
        },
        paperEquity: a.paper_equity,
      });
      return { environment: h.row.agent_environment, ...runSummary(env, row), params: runParams(row), limits: runLimits(row) };
    },
  );

  tool(
    server,
    env,
    "stop_strategy",
    {
      title: "Stop strategy",
      description: "Stop a running strategy. Its resting orders are cancelled; close_positions=true also closes its positions at market.",
      trade: true,
      input: { run_id: runId, close_positions: z.boolean().default(false) },
    },
    async ({ run_id, close_positions }) => {
      const r = findRun(env, run_id);
      if (r.status !== "running") return { ...runSummary(env, r), note: "The run was not running." };
      if (r.mode === "live") resolveAccount(env, r.account_id, { trade: true });
      const notes = await svc.stop(r.id, "stopped by agent", { closePositions: close_positions });
      return { ...runSummary(env, svc.repo.run(r.id)!), actions: notes };
    },
  );

  tool(
    server,
    env,
    "get_strategy_run",
    {
      title: "Get strategy run",
      description: "Status of a strategy run: equity and PnL, positions and resting orders, recent fills, equity curve and the strategy's logs.",
      input: { run_id: runId, logs: z.number().int().min(0).max(300).default(50), fills: z.number().int().min(0).max(300).default(30) },
    },
    async ({ run_id, logs, fills }) => {
      const r = findRun(env, run_id);
      const live = svc.snapshot(r.id);
      return {
        ...runSummary(env, r),
        params: runParams(r),
        limits: runLimits(r),
        stream: live?.stream,
        positions: live?.positions,
        openOrders: live?.openOrders,
        fills: svc.repo.fills(r.id, fills).map((f) => ({ time: iso(f.t), instrument: f.instrument_id, side: f.side, size: f.size, price: f.price, fee: f.fee, pnl: f.pnl, reason: f.reason, tag: f.tag })),
        equityCurve: svc.repo.equity(r.id, 60).map((p) => [iso(p.t), p.v]),
        logs: svc.repo.logs(r.id, logs).map((l) => `${iso(l.t)} ${l.msg}`),
      };
    },
  );
}

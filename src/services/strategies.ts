import { Worker } from "node:worker_threads";
import { logger } from "../logger.js";
import { PlatformError } from "../platforms/errors.js";
import { RESOLUTION_MS, type Candle, type PlatformClient, type Resolution, type Tick, type Unsubscribe } from "../platforms/types.js";
import type { AccountRepo, PlatformAccountRow } from "../repos/accounts.js";
import type { ActivityRepo } from "../repos/activity.js";
import type { Connection, ConnectionRepo, RiskLimits } from "../repos/connections.js";
import { runLimits, runParams, runState, versionDeclaration, type RunLimits, type StrategyRepo, type StrategyRunRow } from "../repos/strategies.js";
import type { BacktestInput, BacktestResult } from "../strategies/backtestCore.js";
import { SimVenue } from "../strategies/backtestCore.js";
import { SimBroker, quoteEvent, type BrokerSnapshot } from "../strategies/broker.js";
import { StrategyEngine, type Venue } from "../strategies/engine.js";
import { LiveVenue, type LiveVenueState } from "../strategies/liveVenue.js";
import { StrategySandbox } from "../strategies/sandbox.js";
import type { Bar, CostModel, InstrumentRules, SimFill, StrategyDeclaration } from "../strategies/types.js";
import type { AccountService } from "./accountService.js";
import type { CandleCache } from "./candleCache.js";
import { convert, fxRates } from "./fx.js";
import type { StreamService } from "./streams.js";

export const DEFAULT_RUN_LIMITS: Required<RunLimits> = { maxDrawdownPct: 10, maxDailyLossPct: 5, maxLeverage: 3, maxOrdersPerMinute: 20 };
const MAX_RUNS_PER_USER = 10;
const MAX_BARS_PER_FEED = 200_000;
const BACKTEST_TIMEOUT_MS = 180_000;
const MAX_PARALLEL_BACKTESTS = 2;
/** onTick is called at most this often per instrument. */
const TICK_DISPATCH_MS = 1000;
const FLUSH_MS = 5000;
const EQUITY_POINT_MS = 60_000;

export function costsFor(platform: string): CostModel {
  // Bybit: default non-VIP derivatives fees. IG: costs are in the spread.
  if (platform === "ig") return { makerBps: 0, takerBps: 0, slippageBps: 1, useSpread: true };
  return { makerBps: 2, takerBps: 5.5, slippageBps: 1, useSpread: false };
}

export function effectiveLimits(l: RunLimits): Required<RunLimits> {
  return { ...DEFAULT_RUN_LIMITS, ...Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined && v !== null)) } as Required<RunLimits>;
}

/** Loads the code in a throwaway sandbox and returns what it declares; throws on errors. */
export async function compileStrategy(code: string): Promise<StrategyDeclaration> {
  const sb = await StrategySandbox.create(code, (op) => {
    throw new Error(`ctx.${op}() is not available while the strategy is loading; use it inside handlers`);
  });
  try {
    const d = sb.declaration;
    if (!d.handlers.includes("onCandle") && !d.handlers.includes("onTick")) {
      throw new PlatformError("invalid_request", "The strategy needs an onCandle or onTick handler.");
    }
    for (const feed of d.data) {
      if (!RESOLUTION_MS[feed.resolution]) throw new PlatformError("invalid_request", `strategy.data: unknown resolution "${feed.resolution}".`);
      if (feed.history !== undefined && (!(feed.history > 0) || feed.history > 5000)) {
        throw new PlatformError("invalid_request", "strategy.data: history must be between 1 and 5000 candles.");
      }
    }
    return d;
  } finally {
    sb.dispose();
  }
}

export async function loadRules(client: PlatformClient, instruments: string[]): Promise<InstrumentRules[]> {
  const out: InstrumentRules[] = [];
  for (const id of instruments) {
    const i = await client.getInstrument(id);
    out.push({
      instrumentId: id,
      minSize: i.minSize,
      sizeStep: i.sizeStep,
      priceTick: i.priceTick,
      contractSize: i.contractSize || 1,
      contractKind: i.contractKind,
      quoteCurrency: i.quoteCurrency,
    });
  }
  return out;
}

async function fxFactors(rules: InstrumentRules[], currency: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const needed = [...new Set(rules.map((r) => r.quoteCurrency).filter((c): c is string => !!c))];
  if (needed.length === 0) return out;
  const rates = await fxRates();
  for (const ccy of needed) {
    if (ccy.toUpperCase() === currency.toUpperCase()) out[ccy] = 1;
    else out[ccy] = (rates && convert(rates, 1, ccy, currency)) ?? 1;
  }
  return out;
}

function uniqueInstruments(d: StrategyDeclaration): string[] {
  return [...new Set([...d.data.map((f) => f.instrument), ...d.ticks])];
}

export interface BacktestRequest {
  account: PlatformAccountRow;
  code: string;
  declaration: StrategyDeclaration;
  params: Record<string, unknown>;
  from: number;
  to: number;
  /** Share of the period used for tuning; the rest is the out-of-sample check. */
  tuningShare: number;
  initialEquity: number;
  currency: string;
  maxLeverage: number;
  /** Allow fetching missing candles from the platform (spends IG's weekly allowance). */
  allowFetch: boolean;
  costs?: Partial<CostModel>;
}

export interface BacktestOutcome extends BacktestResult {
  data: { instrument: string; resolution: Resolution; candles: number; fetched: number }[];
  costs: CostModel;
}

export interface StartRunInput {
  userId: string;
  connection: Connection | null;
  account: PlatformAccountRow;
  strategyId: string;
  version: number;
  mode: "paper" | "live";
  params: Record<string, unknown>;
  limits: RunLimits;
  paperEquity?: number;
}

interface RunMeta {
  broker?: BrokerSnapshot;
  live?: LiveVenueState;
  day?: { day: string; equity: number };
}

/**
 * Strategy backtests (in worker threads) and running strategies (paper on live data,
 * or live on the account), with guard rails and resume after restarts.
 */
export class StrategyService {
  private readonly active = new Map<string, ActiveRun>();
  private backtestsRunning = 0;
  private readonly backtestQueue: (() => void)[] = [];

  constructor(
    readonly repo: StrategyRepo,
    private readonly accounts: AccountRepo,
    private readonly accountService: AccountService,
    private readonly candles: CandleCache,
    private readonly streams: StreamService,
    private readonly activity: ActivityRepo,
    private readonly connections: ConnectionRepo,
  ) {}

  // --- backtests -------------------------------------------------------------------------

  async backtest(req: BacktestRequest): Promise<BacktestOutcome> {
    const client = this.accountService.client(req.account);
    const platform = this.accountService.platformOf(req.account);
    const d = req.declaration;
    if (d.data.length === 0) throw new PlatformError("invalid_request", "strategy.data must declare at least one candle feed.");
    for (const f of d.data) {
      if (!platform.capabilities.resolutions.includes(f.resolution)) {
        throw new PlatformError("invalid_request", `${platform.name} has no ${f.resolution} candles. Supported: ${platform.capabilities.resolutions.join(", ")}.`);
      }
    }
    const instruments = uniqueInstruments(d);
    const rules = await loadRules(client, instruments);
    const inverse = rules.find((r) => r.contractKind === "inverse");
    if (inverse) throw new PlatformError("unsupported", `Inverse contracts (${inverse.instrumentId}) are not supported by the strategy engine yet; use linear (USDT/USDC) contracts.`);

    const key = client.marketDataKey();
    // Estimate what has to be fetched before touching the platform.
    let missing = 0;
    const plan = d.data.map((f) => {
      const step = RESOLUTION_MS[f.resolution];
      const warm = (f.history ?? 100) * step;
      const from = Math.floor((req.from - warm) / step) * step;
      const bars = Math.ceil((req.to - from) / step);
      if (bars > MAX_BARS_PER_FEED) {
        throw new PlatformError("invalid_request", `${f.instrument} ${f.resolution}: ${bars} candles requested; the maximum per feed is ${MAX_BARS_PER_FEED}. Shorten the period or use a larger resolution.`);
      }
      const gaps = this.candles.missingRanges(key, f.instrument, f.resolution, from, Math.min(req.to, Date.now()));
      const m = gaps.reduce((s, [a, b]) => s + Math.ceil((b - a) / step), 0);
      missing += m;
      return { feed: f, from, missing: m };
    });
    if (missing > 0) {
      const quota = await client.getQuota().catch(() => null);
      if (quota?.kind === "weekly_points") {
        if (!req.allowFetch) {
          throw new PlatformError(
            "rate_limited",
            `This backtest needs up to ${missing} candles that are not cached yet; on ${platform.name} that spends up to ${missing} points of the weekly historic data allowance ` +
              `(remaining: ${quota.remaining ?? "unknown"}${quota.total ? ` of ${quota.total}` : ""}; weekends and closed hours cost nothing, so the real cost is usually lower). ` +
              "Repeat with allow_fetch=true to spend it, or use a shorter period / larger resolution, or data already cached (list_cached_candles).",
          );
        }
        if (quota.remaining !== null && missing > quota.remaining * 1.5) {
          throw new PlatformError("rate_limited", `Up to ${missing} candles are missing but only ${quota.remaining} points of the weekly allowance remain.`);
        }
      }
    }

    const feeds: BacktestInput["feeds"] = [];
    const data: BacktestOutcome["data"] = [];
    for (const p of plan) {
      const { bars, fetched } = await this.loadCandles(client, p.feed.instrument, p.feed.resolution, p.from, req.to, p.missing === 0);
      if (bars.length === 0) throw new PlatformError("not_found", `No ${p.feed.resolution} candles for ${p.feed.instrument} in the requested period.`);
      feeds.push({ instrument: p.feed.instrument, resolution: p.feed.resolution, bars });
      data.push({ instrument: p.feed.instrument, resolution: p.feed.resolution, candles: bars.length, fetched });
    }

    const costs = { ...costsFor(req.account.platform), ...(req.costs ?? {}) };
    const input: BacktestInput = {
      code: req.code,
      params: req.params,
      from: req.from,
      to: req.to,
      splitAt: req.from + Math.round((req.to - req.from) * req.tuningShare),
      initialEquity: req.initialEquity,
      currency: req.currency,
      costs,
      rules,
      fx: await fxFactors(rules, req.currency),
      feeds,
      maxLeverage: req.maxLeverage,
    };
    const result = await this.inWorker(input);
    return { ...result, data, costs };
  }

  /** Reads candles in chunks through the cache. `cacheOnly` prevents platform calls. */
  private async loadCandles(client: PlatformClient, instrumentId: string, resolution: Resolution, from: number, to: number, cacheOnly: boolean): Promise<{ bars: Candle[]; fetched: number }> {
    const step = RESOLUTION_MS[resolution];
    const chunk = 5000;
    const out = new Map<number, Candle>();
    let fetched = 0;
    const end = Math.min(to, Date.now());
    for (let cursor = from; cursor < end; cursor += chunk * step) {
      const res = await this.candles.get(client, { instrumentId, resolution, from: cursor, to: Math.min(end, cursor + chunk * step), limit: chunk, cacheOnly });
      fetched += res.stats.fetched;
      for (const c of res.candles) if (c.t + step <= Date.now()) out.set(c.t, c);
    }
    return { bars: [...out.values()].sort((a, b) => a.t - b.t), fetched };
  }

  private async inWorker(input: BacktestInput): Promise<BacktestResult> {
    if (this.backtestsRunning >= MAX_PARALLEL_BACKTESTS) await new Promise<void>((r) => this.backtestQueue.push(r));
    this.backtestsRunning++;
    try {
      return await new Promise<BacktestResult>((resolve, reject) => {
        const worker = new Worker(new URL("../strategies/backtestWorker.js", import.meta.url), {
          workerData: input,
          resourceLimits: { maxOldGenerationSizeMb: 768 },
        });
        const timer = setTimeout(() => {
          void worker.terminate();
          reject(new PlatformError("invalid_request", `Backtest timed out after ${BACKTEST_TIMEOUT_MS / 1000} s. Use a shorter period or a larger resolution.`));
        }, BACKTEST_TIMEOUT_MS);
        worker.once("message", (m: { ok: boolean; result?: BacktestResult; error?: string }) => {
          clearTimeout(timer);
          void worker.terminate();
          if (m.ok) resolve(m.result!);
          else reject(new PlatformError("invalid_request", `Backtest failed: ${m.error}`));
        });
        worker.once("error", (err) => {
          clearTimeout(timer);
          reject(new PlatformError("invalid_request", `Backtest failed: ${err.message}`));
        });
      });
    } finally {
      this.backtestsRunning--;
      this.backtestQueue.shift()?.();
    }
  }

  // --- runs ------------------------------------------------------------------------------

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  /** Live numbers of an active run (equity, positions) for tools and UI. */
  snapshot(runId: string): { equity: number; positions: unknown[]; openOrders: unknown[]; stream: string | null } | null {
    const a = this.active.get(runId);
    return a ? a.view() : null;
  }

  async start(input: StartRunInput): Promise<StrategyRunRow> {
    const strategy = this.repo.find(input.strategyId, input.userId);
    if (!strategy) throw new PlatformError("not_found", "Unknown strategy.");
    const version = this.repo.version(input.strategyId, input.version);
    if (!version) throw new PlatformError("not_found", `Strategy version ${input.version} does not exist.`);
    const decl = versionDeclaration(version);
    const running = this.repo.runs({ userId: input.userId, status: "running" });
    if (running.length >= MAX_RUNS_PER_USER) throw new PlatformError("invalid_request", `At most ${MAX_RUNS_PER_USER} strategy runs can be active at once. Stop one first.`);
    if (input.mode === "live") {
      const mine = uniqueInstruments(decl);
      for (const r of running.filter((x) => x.mode === "live" && x.account_id === input.account.id)) {
        const other = versionDeclaration(this.repo.version(r.strategy_id, r.version) ?? { declaration_json: "{}" });
        const overlap = uniqueInstruments(other).filter((i) => mine.includes(i));
        if (overlap.length) {
          throw new PlatformError("invalid_request", `Live run ${r.id} already trades ${overlap.join(", ")} on this account. Only one live strategy per instrument and account.`);
        }
      }
    }
    const client = this.accountService.client(input.account);
    // Paper runs only need the account currency, so they also work with read-only or market-data-only keys.
    const summary = input.mode === "live" ? await client.getAccount() : await client.getAccount().catch(() => null);
    const currency = input.mode === "paper" ? summary?.currency || input.account.currency || "USD" : summary!.currency;
    const startEquity = input.mode === "paper" ? (input.paperEquity ?? 10_000) : summary!.equity;
    if (input.mode === "live" && !(startEquity > 0)) throw new PlatformError("invalid_request", "The account has no equity.");
    const limits = effectiveLimits(input.limits);
    const row = this.repo.createRun({
      strategyId: input.strategyId,
      version: input.version,
      userId: input.userId,
      accountId: input.account.id,
      connectionId: input.connection?.id ?? null,
      mode: input.mode,
      params: { ...decl.params, ...input.params },
      limits,
      currency,
      startEquity,
    });
    try {
      await this.launch(row, false);
    } catch (err) {
      this.repo.finishRun(row.id, "error", `failed to start: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    return this.repo.run(row.id)!;
  }

  async stop(runId: string, reason: string, opts: { closePositions?: boolean } = {}): Promise<string[]> {
    const a = this.active.get(runId);
    if (!a) {
      this.repo.finishRun(runId, "stopped", reason);
      return [];
    }
    return a.shutdown("stopped", reason, opts.closePositions ?? false);
  }

  /** Restarts runs that were active before the server stopped. */
  async resumeAll(): Promise<void> {
    for (const row of this.repo.runs({ status: "running", limit: 1000 })) {
      try {
        await this.launch(row, true);
        logger.info("strategy run resumed", { runId: row.id, mode: row.mode });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("strategy run could not be resumed", { runId: row.id, err: msg });
        this.repo.addLog(row.id, Date.now(), `ERROR could not resume after restart: ${msg}`);
        this.repo.finishRun(row.id, "error", `could not resume after restart: ${msg}`);
      }
    }
  }

  async closeAll(): Promise<void> {
    for (const a of this.active.values()) a.suspend();
    this.active.clear();
  }

  private async launch(row: StrategyRunRow, resumed: boolean): Promise<void> {
    const account = this.accounts.findById(row.account_id);
    if (!account || account.is_active !== 1) throw new Error("account not found or disabled");
    const version = this.repo.version(row.strategy_id, row.version);
    if (!version) throw new Error("strategy version missing");
    let risk: RiskLimits = {};
    if (row.mode === "live") {
      if (account.can_trade !== 1) throw new PlatformError("permission_denied", "The account's API credentials are read-only.");
      if (row.connection_id) {
        const conn = this.connections.findById(row.connection_id);
        if (!conn || conn.revoked_at || conn.can_trade !== 1 || !conn.accountIds.includes(account.id)) {
          throw new PlatformError("permission_denied", "The agent connection that started this run no longer has trading access to the account.");
        }
        risk = conn.risk;
      }
    }
    const run = new ActiveRun(this, row, account, version.code, risk, {
      accountService: this.accountService,
      candles: this.candles,
      streams: this.streams,
      activity: this.activity,
      repo: this.repo,
    });
    await run.init(resumed);
    this.active.set(row.id, run);
  }

  /** Called by a run when it ends by itself. */
  forget(runId: string): void {
    this.active.delete(runId);
  }
}

interface RunDeps {
  accountService: AccountService;
  candles: CandleCache;
  streams: StreamService;
  activity: ActivityRepo;
  repo: StrategyRepo;
}

class ActiveRun {
  private sandbox: StrategySandbox | null = null;
  private engine: StrategyEngine | null = null;
  private venue: Venue | null = null;
  private broker: SimBroker | null = null;
  private live: LiveVenue | null = null;
  private readonly unsubs: Unsubscribe[] = [];
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly lastTick = new Map<string, Tick>();
  private readonly lastTickDispatch = new Map<string, number>();
  private readonly orderTimes: number[] = [];
  private readonly limits: Required<RunLimits>;
  private meta: RunMeta;
  private state: Record<string, unknown>;
  private dirty = false;
  private ended = false;
  private lastEquityPoint = 0;
  private fx: Record<string, number> = {};
  private rules = new Map<string, InstrumentRules>();
  private decl: StrategyDeclaration;

  constructor(
    private readonly owner: StrategyService,
    private readonly row: StrategyRunRow,
    private readonly account: PlatformAccountRow,
    private readonly code: string,
    private readonly risk: RiskLimits,
    private readonly d: RunDeps,
  ) {
    this.limits = effectiveLimits(runLimits(row));
    this.meta = (row.broker_json ? JSON.parse(row.broker_json) : {}) as RunMeta;
    this.state = runState(row);
    this.decl = { name: null, params: {}, data: [], ticks: [], handlers: [] };
  }

  private get id(): string {
    return this.row.id;
  }

  async init(resumed: boolean): Promise<void> {
    const client = this.d.accountService.client(this.account);
    const sandbox = await StrategySandbox.create(this.code, (op, args) => this.engine!.host(op, args));
    this.sandbox = sandbox;
    try {
      this.decl = sandbox.declaration;
      const instruments = uniqueInstruments(this.decl);
      const rules = await loadRules(client, instruments);
      const inverse = rules.find((r) => r.contractKind === "inverse");
      if (inverse) throw new PlatformError("unsupported", `Inverse contracts (${inverse.instrumentId}) are not supported by the strategy engine yet.`);
      this.rules = new Map(rules.map((r) => [r.instrumentId, r]));
      const currency = this.row.currency ?? "USD";
      this.fx = await fxFactors(rules, currency);
      const fx = (ccy: string | null) => (ccy ? (this.fx[ccy] ?? 1) : 1);

      if (this.row.mode === "paper") {
        this.broker = new SimBroker({
          rules: this.rules,
          costs: costsFor(this.account.platform),
          initialCash: this.row.start_equity ?? 10_000,
          currency,
          fx,
          maxLeverage: this.limits.maxLeverage,
        });
        if (this.meta.broker) this.broker.restore(this.meta.broker);
        this.venue = new SimVenue(this.broker, currency);
      } else {
        this.live = new LiveVenue({
          client,
          runId: this.id,
          instruments,
          risk: this.risk,
          maxLeverage: this.limits.maxLeverage,
          rules: this.rules,
          fx,
          state: this.meta.live,
          onAction: (action, args, ok, result, error, ms) => this.recordAction(action, args, ok, result, error, ms),
          onPlatformOrder: (orderId, instrument) => {
            try {
              this.d.activity.recordAgentOrder({ accountId: this.account.id, connectionId: this.row.connection_id, orderId, instrumentId: instrument });
            } catch {
              /* attribution is best effort */
            }
          },
          emit: (now, fills, orders) => {
            if (this.ended) {
              // Fills from closing positions while stopping are still recorded.
              for (const f of fills) this.recordFill(f);
              return;
            }
            this.engine?.pushEvents(now, fills, orders);
            this.afterEvents();
          },
        });
        await this.live.init();
        this.meta.live = this.live.state;
        this.venue = this.live;
      }

      this.engine = new StrategyEngine(sandbox, this.rules, this.venue, {
        onLog: (l) => this.d.repo.addLog(this.id, l.t || Date.now(), l.msg),
        onFill: (f) => this.recordFill(f),
        onState: (s) => {
          this.state = s;
          this.dirty = true;
        },
        onFatal: (reason) => void this.shutdown("error", `strategy error: ${reason}`, false),
        guard: (intent, now) => this.guard(intent, now),
      });

      // History for the declared feeds, then live candles and quotes.
      for (const f of this.decl.data) {
        const history = Math.min(5000, (f.history ?? 100) + 5);
        const res = await this.d.candles.get(client, { instrumentId: f.instrument, resolution: f.resolution, limit: history });
        const step = RESOLUTION_MS[f.resolution];
        this.engine.preload(res.candles.filter((c) => c.t + step <= Date.now()).map((c) => ({ ...c, instrument: f.instrument, resolution: f.resolution })));
      }
      for (const f of this.decl.data) {
        this.unsubs.push(
          this.d.streams.candleStream(this.account.id, f.instrument, f.resolution, (u) => {
            if (!u.final || this.ended) return;
            const bar: Bar = { ...u.candle, instrument: f.instrument, resolution: f.resolution };
            this.engine?.onBar(bar);
            this.afterEvents();
          }),
        );
      }
      for (const inst of instruments) {
        this.unsubs.push(this.d.streams.ticks(this.account.id, inst, (t) => this.onTick(t)));
      }
      if (this.live) {
        try {
          const live = this.live;
          this.unsubs.push(this.d.streams.accountEvents(this.account.id, (e) => live.onAccountEvent(e)));
        } catch (err) {
          this.d.repo.addLog(this.id, Date.now(), `account event stream unavailable (${err instanceof Error ? err.message : String(err)}); fills are polled every 30 s`);
        }
      }

      this.d.repo.addLog(this.id, Date.now(), resumed ? "resumed after server restart" : `started (${this.row.mode})`);
      this.engine.start(Date.now(), runParams(this.row), this.state);
      if (this.engine.isStopped) throw new Error("the strategy failed in onStart");

      this.timers.push(setInterval(() => this.flush(), FLUSH_MS));
      this.timers.push(setInterval(() => this.checkLimits(), 10_000));
      this.timers.push(
        setInterval(() => {
          void fxFactors(rules, currency).then((f) => (this.fx = f)).catch(() => undefined);
          try {
            this.d.repo.prune(this.id);
          } catch {
            /* ignore */
          }
        }, 3_600_000),
      );
      this.flush(true);
    } catch (err) {
      this.teardown();
      throw err;
    }
  }

  private onTick(t: Tick): void {
    if (this.ended || !this.engine) return;
    this.lastTick.set(t.instrumentId, t);
    // Local receive time, not the platform timestamp: orders are stamped with local time too.
    const now = Date.now();
    if (this.broker) {
      const bid = t.bid ?? t.last;
      const ask = t.ask ?? t.last;
      if (bid !== null && ask !== null) {
        const { fills, orders } = this.broker.onPrice(quoteEvent(t.instrumentId, now, bid, ask));
        if (fills.length || orders.length) this.engine.pushEvents(now, fills, orders);
      }
    }
    const last = this.lastTickDispatch.get(t.instrumentId) ?? 0;
    const dispatch = this.decl.ticks.includes(t.instrumentId) && Date.now() - last >= TICK_DISPATCH_MS;
    if (dispatch) this.lastTickDispatch.set(t.instrumentId, Date.now());
    this.engine.onQuote({ instrument: t.instrumentId, time: now, bid: t.bid, ask: t.ask, last: t.last }, dispatch);
    this.afterEvents();
  }

  private afterEvents(): void {
    if (this.dirty && Date.now() - this.lastFlush > FLUSH_MS) this.flush();
  }
  private lastFlush = 0;

  equity(): number {
    if (this.broker) return this.broker.equity();
    const start = this.row.start_equity ?? 0;
    if (!this.live) return start;
    return start + this.live.pnl((inst) => {
      const t = this.lastTick.get(inst);
      if (!t) return null;
      return t.bid !== null && t.ask !== null ? (t.bid + t.ask) / 2 : t.last;
    });
  }

  view() {
    const instruments = uniqueInstruments(this.decl);
    return {
      equity: round(this.equity()),
      positions: instruments.map((i) => this.venue?.positionView(i)).filter(Boolean),
      openOrders: this.venue?.openOrders(null) ?? [],
      stream: (() => {
        const s = this.d.streams.status(this.account.id);
        return s ? (s.connected ? "connected" : `disconnected${s.error ? `: ${s.error}` : ""}`) : null;
      })(),
    };
  }

  private guard(intent: { instrument: string; side: "buy" | "sell"; size: number; price?: number; reduceOnly: boolean }, now: number): string | null {
    void now;
    const t = Date.now();
    while (this.orderTimes.length && this.orderTimes[0]! < t - 60_000) this.orderTimes.shift();
    if (this.orderTimes.length >= this.limits.maxOrdersPerMinute) return `run limit: more than ${this.limits.maxOrdersPerMinute} orders per minute`;
    this.orderTimes.push(t);
    if (!intent.reduceOnly) {
      const breach = this.limitBreach();
      if (breach) return breach;
    }
    return null;
  }

  private limitBreach(): string | null {
    const eq = this.equity();
    const start = this.row.start_equity ?? 0;
    if (start > 0 && ((start - eq) / start) * 100 >= this.limits.maxDrawdownPct) {
      return `run limit: drawdown ${(((start - eq) / start) * 100).toFixed(2)}% from the start equity reached the maximum of ${this.limits.maxDrawdownPct}%`;
    }
    const day = new Date().toISOString().slice(0, 10);
    if (!this.meta.day || this.meta.day.day !== day) {
      this.meta.day = { day, equity: eq };
      this.dirty = true;
    }
    const dayStart = this.meta.day.equity;
    if (dayStart > 0 && ((dayStart - eq) / dayStart) * 100 >= this.limits.maxDailyLossPct) {
      return `run limit: today's loss ${(((dayStart - eq) / dayStart) * 100).toFixed(2)}% reached the maximum of ${this.limits.maxDailyLossPct}%`;
    }
    return null;
  }

  private checkLimits(): void {
    if (this.ended) return;
    const breach = this.limitBreach();
    if (breach) void this.shutdown("stopped", breach, true);
  }

  private recordFill(f: SimFill): void {
    this.d.repo.addFill(this.id, {
      t: f.time,
      instrument_id: f.instrument,
      side: f.side,
      size: f.size,
      price: f.price,
      fee: f.fee,
      pnl: f.pnl,
      reason: f.reason,
      tag: f.tag,
      order_id: f.orderId,
    });
    this.dirty = true;
  }

  private recordAction(action: string, args: Record<string, unknown>, ok: boolean, result: unknown, error: string | null, ms: number): void {
    try {
      const text = JSON.stringify(result ?? null);
      this.d.activity.recordToolCall({
        user_id: this.row.user_id,
        connection_id: this.row.connection_id,
        account_id: this.account.id,
        tool: `strategy:${action}`,
        is_trade: 1,
        args_json: JSON.stringify({ run_id: this.id, ...args }),
        result_json: text.length > 4000 ? `${text.slice(0, 4000)}…` : text,
        ok: ok ? 1 : 0,
        error,
        duration_ms: ms,
        created_at: Date.now(),
      });
    } catch (err) {
      logger.warn("could not record strategy action", { err: String(err) });
    }
  }

  flush(force = false): void {
    if (!force && !this.dirty && Date.now() - this.lastEquityPoint < EQUITY_POINT_MS) return;
    this.lastFlush = Date.now();
    this.dirty = false;
    const eq = this.equity();
    if (this.broker) this.meta.broker = this.broker.snapshot();
    if (this.live) this.meta.live = this.live.state;
    try {
      this.d.repo.saveRunState(this.id, { state: this.state, broker: this.meta, lastEquity: round(eq) });
      if (force || Date.now() - this.lastEquityPoint >= EQUITY_POINT_MS) {
        this.lastEquityPoint = Date.now();
        this.d.repo.addEquity(this.id, Math.floor(Date.now() / EQUITY_POINT_MS) * EQUITY_POINT_MS, round(eq));
      }
    } catch (err) {
      logger.warn("could not persist strategy run", { runId: this.id, err: String(err) });
    }
  }

  /** Ends the run: calls onStop, cleans up resting orders (and positions if asked), persists. */
  async shutdown(status: "stopped" | "error", reason: string, closePositions: boolean): Promise<string[]> {
    if (this.ended) return [];
    this.ended = true;
    const notes: string[] = [];
    try {
      if (this.engine && !this.engine.isStopped) this.engine.stop(Date.now(), reason);
    } catch {
      /* onStop errors are logged by the engine */
    }
    if (this.live) {
      try {
        notes.push(...(await this.live.shutdown(closePositions)));
      } catch (err) {
        notes.push(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (this.broker) {
      // Paper: resting orders are dropped; positions are closed at the last price when asked.
      for (const o of this.broker.openOrders(null)) this.broker.submit({ kind: "cancel", localId: `stop-${o.id}`, target: o.id }, Date.now());
      if (closePositions) {
        for (const inst of [...this.broker.positions.keys()]) {
          this.broker.submit({ kind: "close", localId: `stop-close-${inst}`, instrument: inst, size: null }, Date.now());
          const t = this.lastTick.get(inst);
          const bid = t?.bid ?? t?.last ?? this.broker.mark(inst);
          const ask = t?.ask ?? t?.last ?? this.broker.mark(inst);
          if (bid !== null && ask !== null && bid !== undefined && ask !== undefined) {
            const { fills } = this.broker.onPrice(quoteEvent(inst, Date.now(), bid, ask));
            for (const f of fills) this.recordFill(f);
          }
        }
        notes.push("paper positions closed at the last price");
      }
    }
    this.d.repo.addLog(this.id, Date.now(), `${status === "error" ? "STOPPED WITH ERROR" : "STOPPED"}: ${reason}${notes.length ? ` (${notes.join("; ")})` : ""}`);
    this.flush(true);
    this.d.repo.finishRun(this.id, status, reason);
    this.teardown();
    this.owner.forget(this.id);
    return notes;
  }

  /** Server shutdown: keep the run marked as running so it resumes on the next start. */
  suspend(): void {
    if (this.ended) return;
    this.flush(true);
    this.ended = true;
    this.teardown();
  }

  private teardown(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    for (const u of this.unsubs) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    this.unsubs.length = 0;
    this.live?.close();
    this.sandbox?.dispose();
    this.sandbox = null;
  }
}

function round(v: number, d = 4): number {
  return Number(v.toFixed(d));
}

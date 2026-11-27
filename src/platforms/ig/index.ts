/**
 * IG.com adapter (CFD and spread bet accounts) over the IG REST trading API.
 * Instrument ids are IG epics, e.g. "CS.D.EURUSD.CFD.IP".
 */
import { randomBytes } from "node:crypto";
import { PlatformError, unsupported } from "../errors.js";
import { num } from "../http.js";
import type {
  AccountSummary,
  AmendOrderRequest,
  Candle,
  ClosedPnl,
  ClosePositionRequest,
  DataQuota,
  EnvironmentId,
  Fill,
  Instrument,
  InstrumentSummary,
  InstrumentType,
  Order,
  OrderResult,
  OrderType,
  PlaceOrderRequest,
  PlatformClient,
  PlatformClientContext,
  PlatformDefinition,
  PlatformStream,
  Position,
  PositionProtectionRequest,
  Quote,
  Resolution,
  TimeRange,
  ValidationResult,
} from "../types.js";
import { describeAccounts, IgHttp, sha16 } from "./client.js";
import { IgStream } from "./stream.js";
import {
  actionStatus,
  cleanSize,
  epicSymbol,
  formatIgDate,
  IG_RESOLUTIONS,
  instrumentFacts,
  mapMarketStatus,
  parseIgUtc,
  parseMoney,
  rejectCode,
  rejectMessage,
  roundTo,
  toCandle,
  toInstrument,
  toInstrumentSummary,
  toQuote,
  type IgCandle,
  type IgInstrumentFacts,
  type IgMarketData,
  type IgMarketDetails,
} from "./mappers.js";

const PLATFORM = "IG";
const DAY_MS = 86_400_000;
const FACTS_TTL_MS = 60 * 60 * 1000;
const QUOTA_NOTE =
  "IG historical price data allowance: each candle returned costs one point; the allowance resets weekly. Prefer cached data and request only what you need.";

// ---------------------------------------------------------------------------
// IG response shapes
// ---------------------------------------------------------------------------

interface IgAccount {
  accountId?: string;
  accountName?: string;
  accountAlias?: string | null;
  accountType?: string;
  status?: string;
  preferred?: boolean;
  currency?: string;
  balance?: { balance?: number; deposit?: number; profitLoss?: number; available?: number } | null;
}

interface IgPositionEntry {
  position?: {
    dealId?: string;
    dealReference?: string;
    direction?: string;
    size?: number | string;
    level?: number | string;
    contractSize?: number;
    currency?: string;
    createdDateUTC?: string;
    stopLevel?: number | null;
    limitLevel?: number | null;
    trailingStopDistance?: number | null;
    trailingStep?: number | null;
    controlledRisk?: boolean;
    limitedRiskPremium?: number | null;
  };
  market?: IgMarketData;
}

interface IgWorkingOrderEntry {
  workingOrderData?: {
    dealId?: string;
    direction?: string;
    epic?: string;
    orderSize?: number | string;
    orderLevel?: number | string;
    orderType?: string;
    timeInForce?: string;
    goodTillDate?: string | null;
    goodTillDateISO?: string | null;
    createdDateUTC?: string;
    guaranteedStop?: boolean;
    stopDistance?: number | null;
    limitDistance?: number | null;
    currencyCode?: string;
  };
  marketData?: IgMarketData;
}

interface IgActivity {
  date?: string;
  epic?: string;
  dealId?: string;
  type?: string;
  status?: string;
  description?: string;
  details?: {
    dealReference?: string;
    actions?: { actionType?: string; affectedDealId?: string }[];
    marketName?: string;
    currency?: string;
    size?: number | string;
    direction?: string;
    level?: number | string;
    stopLevel?: number | string | null;
    limitLevel?: number | string | null;
    guaranteedStop?: boolean;
  } | null;
}

interface IgTransaction {
  dateUtc?: string;
  openDateUtc?: string;
  instrumentName?: string;
  profitAndLoss?: string;
  transactionType?: string;
  reference?: string;
  openLevel?: string;
  closeLevel?: string;
  size?: string;
  currency?: string;
  cashTransaction?: boolean;
}

interface IgConfirm {
  dealReference?: string;
  dealId?: string;
  dealStatus?: string;
  reason?: string;
  status?: string;
  level?: number | null;
  size?: number | null;
  direction?: string;
  epic?: string;
  profit?: number | null;
  profitCurrency?: string | null;
  affectedDeals?: { dealId?: string; status?: string }[];
}

interface DealRefResponse {
  dealReference?: string;
}

type ConfirmKind = "open" | "working" | "close" | "cancel" | "amend";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function invalid(message: string): PlatformError {
  return new PlatformError("invalid_request", message);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

class IgClient implements PlatformClient {
  private readonly http: IgHttp;
  private readonly env: EnvironmentId;
  private readonly quotaKey: string;
  private readonly configuredAccountId: string | null;
  private readonly factsCache = new Map<string, { facts: IgInstrumentFacts; at: number }>();
  private liveStream: IgStream | null = null;

  constructor(private readonly ctx: PlatformClientContext) {
    const c = ctx.credentials;
    const apiKey = (c.apiKey ?? "").trim();
    this.env = ctx.environment;
    this.configuredAccountId = (c.accountId ?? "").trim() || null;
    const metaAccount = typeof ctx.meta.accountId === "string" && ctx.meta.accountId ? ctx.meta.accountId : null;
    this.http = new IgHttp(
      ctx.environment,
      { username: (c.username ?? "").trim(), password: c.password ?? "", apiKey },
      this.configuredAccountId ?? metaAccount,
    );
    this.quotaKey = `ig:${ctx.environment}:${sha16(apiKey)}`;
  }

  marketDataKey(): string {
    return `ig:${this.env}`;
  }

  stream(): PlatformStream {
    if (!this.liveStream) {
      this.liveStream = new IgStream(`ig-${this.ctx.accountId.slice(0, 8)}`, (fresh) => this.http.streamCredentials(fresh));
    }
    return this.liveStream;
  }

  private async accountType(): Promise<string | null> {
    const s = await this.http.getSession();
    return s.accountType ?? (typeof this.ctx.meta.accountType === "string" ? this.ctx.meta.accountType : null);
  }

  // ---- account --------------------------------------------------------------

  async validate(): Promise<ValidationResult> {
    const fail = (msg: string): ValidationResult => ({
      errors: [msg],
      warnings: [],
      canTrade: false,
      externalId: null,
      description: null,
      currency: null,
      meta: {},
    });
    let session;
    let accounts: IgAccount[];
    try {
      session = await this.http.getSession();
      const res = await this.http.request<{ accounts?: IgAccount[] }>({ path: "/accounts", version: 1 });
      accounts = res.accounts ?? [];
    } catch (err) {
      if (err instanceof PlatformError) return fail(err.message);
      throw err;
    }
    const list = accounts.map((a) => ({
      accountId: a.accountId ?? "",
      accountName: a.accountName ?? null,
      accountType: a.accountType ?? null,
      preferred: a.preferred === true,
    }));
    const active = accounts.find((a) => a.accountId === session.accountId);
    if (!active) {
      return fail(`IG did not return the active account ${session.accountId}. Available accounts: ${describeAccounts(list)}.`);
    }

    const warnings: string[] = [];
    if (!this.configuredAccountId && accounts.length > 1) {
      warnings.push(
        `This IG login has ${accounts.length} accounts: ${describeAccounts(list)}. Using ${active.accountId} (${active.accountType ?? "?"}). Set "Account ID" to use another one.`,
      );
    }
    const accountType = active.accountType ?? session.accountType ?? null;
    let canTrade = true;
    if (accountType === "PHYSICAL") {
      canTrade = false;
      warnings.push("This is a share dealing (PHYSICAL) account; the IG API can only trade CFD and spread bet accounts. Choose a CFD or spread bet account id.");
    }
    if (active.status && active.status !== "ENABLED") {
      warnings.push(`The IG account status is ${active.status}; trading may be restricted.`);
    }
    if (session.trailingStopsEnabled === false) {
      warnings.push("Trailing stops are disabled for this IG account (enable them in the IG platform settings to use trailingStopDistance).");
    }
    warnings.push("IG API keys cannot withdraw or transfer funds: the API can trade but cannot move money out of the account.");

    const currency = active.currency ?? null;
    return {
      errors: [],
      warnings,
      canTrade,
      externalId: active.accountId ?? null,
      description: `Account ${active.accountId} · ${accountType ?? "?"} · ${currency ?? "?"}${active.accountName ? ` · ${active.accountName}` : ""}`,
      currency,
      meta: { accountId: active.accountId, accountType, currency },
    };
  }

  async getAccount(): Promise<AccountSummary> {
    const session = await this.http.getSession();
    const res = await this.http.request<{ accounts?: IgAccount[] }>({ path: "/accounts", version: 1 });
    const a = (res.accounts ?? []).find((x) => x.accountId === session.accountId);
    if (!a) throw new PlatformError("not_found", `IG did not return the active account ${session.accountId}.`);
    const balance = num(a.balance?.balance);
    const pnl = num(a.balance?.profitLoss);
    const available = num(a.balance?.available);
    const currency = a.currency ?? "";
    const equity = (balance ?? 0) + (pnl ?? 0);
    return {
      externalId: a.accountId ?? null,
      accountType: a.accountType ?? null,
      currency,
      equity,
      balance,
      available,
      unrealizedPnl: pnl,
      marginUsed: num(a.balance?.deposit),
      balances: [{ asset: currency, total: balance ?? 0, available, value: equity }],
      extra: { accountName: a.accountName ?? null, status: a.status ?? null },
    };
  }

  // ---- market data ----------------------------------------------------------

  async searchInstruments(p: { query?: string; type?: InstrumentType; limit: number }): Promise<InstrumentSummary[]> {
    const q = (p.query ?? "").trim();
    if (!q) return [];
    const [res, accountType] = await Promise.all([
      this.http.request<{ markets?: IgMarketData[] }>({ path: "/markets", version: 1, query: { searchTerm: q } }),
      this.accountType(),
    ]);
    return (res.markets ?? [])
      .filter((m) => m.epic)
      .map((m) => toInstrumentSummary(m, accountType))
      .filter((s) => !p.type || s.type === p.type)
      .slice(0, Math.max(1, p.limit));
  }

  private async loadDetails(epic: string): Promise<IgMarketDetails> {
    if (!epic) throw invalid("instrumentId (IG epic) is required.");
    const d = await this.http.request<IgMarketDetails>({ path: `/markets/${encodeURIComponent(epic)}`, version: 3 });
    const accountType = await this.accountType();
    this.factsCache.set(epic, { facts: instrumentFacts(d, accountType), at: Date.now() });
    return d;
  }

  private async getFacts(epic: string): Promise<IgInstrumentFacts> {
    const hit = this.factsCache.get(epic);
    if (hit && Date.now() - hit.at < FACTS_TTL_MS) return hit.facts;
    await this.loadDetails(epic);
    return this.factsCache.get(epic)!.facts;
  }

  /** Best-effort facts for several epics (used to convert IG points to prices). */
  private async factsFor(epics: string[]): Promise<Map<string, IgInstrumentFacts>> {
    const out = new Map<string, IgInstrumentFacts>();
    for (const epic of new Set(epics.filter(Boolean))) {
      try {
        out.set(epic, await this.getFacts(epic));
      } catch {
        // leave unknown; point-based fields become null
      }
    }
    return out;
  }

  async getInstrument(instrumentId: string): Promise<Instrument> {
    const d = await this.loadDetails(instrumentId);
    return toInstrument(d, await this.accountType());
  }

  async getQuotes(instrumentIds: string[]): Promise<Quote[]> {
    const epics = [...new Set(instrumentIds.filter(Boolean))];
    const accountType = epics.length ? await this.accountType() : null;
    const out: Quote[] = [];
    for (let i = 0; i < epics.length; i += 50) {
      const chunk = epics.slice(i, i + 50);
      const res = await this.http.request<{ marketDetails?: IgMarketDetails[] }>({
        path: "/markets",
        version: 2,
        query: { epics: chunk.join(",") },
      });
      const now = Date.now();
      for (const d of res.marketDetails ?? []) {
        const epic = d.instrument?.epic;
        if (!epic) continue;
        this.factsCache.set(epic, { facts: instrumentFacts(d, accountType), at: now });
        const q = toQuote(d, now);
        // IG can return a market without prices (e.g. an epic not offered on this account type).
        if (q.bid === null && q.ask === null && q.last === null) q.status = "unknown";
        out.push(q);
      }
    }
    const missing = epics.filter((e) => !out.some((q) => q.instrumentId === e));
    const unpriced = out.filter((q) => q.status === "unknown").map((q) => q.instrumentId);
    if (out.length === 0 || unpriced.length === out.length) {
      throw new PlatformError(
        "not_found",
        `No prices for ${[...missing, ...unpriced].join(", ")} on this IG account. Check the epic with search_instruments: CFD and spread bet accounts use different epics.`,
      );
    }
    for (const e of missing) {
      out.push({
        instrumentId: e, time: Date.now(), bid: null, ask: null, last: null, mark: null, index: null, high24h: null, low24h: null,
        changePct24h: null, volume24h: null, openInterest: null, fundingRate: null, nextFundingTime: null, status: "unknown",
        greeks: null, underlyingPrice: null,
      });
    }
    return out;
  }

  async fetchCandles(p: { instrumentId: string; resolution: Resolution; from: number; to: number }): Promise<{
    candles: Candle[];
    quota: DataQuota | null;
  }> {
    const igRes = IG_RESOLUTIONS[p.resolution];
    if (!igRes) {
      throw new PlatformError(
        "unsupported",
        `Resolution ${p.resolution} is not available on IG. Use one of: ${Object.keys(IG_RESOLUTIONS).join(", ")}.`,
      );
    }
    if (!(p.to > p.from)) return { candles: [], quota: await this.getQuota() };

    const query: Record<string, string | number> = {
      resolution: igRes,
      from: formatIgDate(p.from),
      // IG treats "to" as inclusive; we want [from, to).
      to: formatIgDate(Math.max(p.from, p.to - 1000)),
      pageSize: 1000,
      pageNumber: 1,
    };
    const raw: IgCandle[] = [];
    let quota: DataQuota | null = null;
    for (let page = 1; page <= 100; page++) {
      query.pageNumber = page;
      const res = await this.http.request<{
        prices?: IgCandle[];
        metadata?: {
          allowance?: { remainingAllowance?: number; totalAllowance?: number; allowanceExpiry?: number };
          pageData?: { pageNumber?: number; totalPages?: number };
        };
      }>({ path: `/prices/${encodeURIComponent(p.instrumentId)}`, version: 3, query, timeoutMs: 30_000 });
      raw.push(...(res.prices ?? []));
      const allowance = res.metadata?.allowance;
      if (allowance) {
        const expiry = num(allowance.allowanceExpiry);
        quota = {
          kind: "weekly_points",
          remaining: num(allowance.remainingAllowance),
          total: num(allowance.totalAllowance),
          resetsAt: expiry !== null ? Date.now() + expiry * 1000 : null,
          note: QUOTA_NOTE,
          updatedAt: Date.now(),
        };
      }
      const totalPages = num(res.metadata?.pageData?.totalPages) ?? 1;
      if (page >= totalPages || (res.prices ?? []).length === 0) break;
    }
    if (quota) this.ctx.quotaStore.set(this.quotaKey, quota);

    const byTime = new Map<number, Candle>();
    for (const r of raw) {
      const c = toCandle(r);
      if (c && c.t >= p.from && c.t < p.to) byTime.set(c.t, c);
    }
    const candles = [...byTime.values()].sort((a, b) => a.t - b.t);
    return { candles, quota };
  }

  async getQuota(): Promise<DataQuota | null> {
    return (
      this.ctx.quotaStore.get(this.quotaKey) ?? {
        kind: "weekly_points",
        remaining: null,
        total: null,
        resetsAt: null,
        note: QUOTA_NOTE,
      }
    );
  }

  // ---- positions & orders -----------------------------------------------------

  private async rawPositions(): Promise<IgPositionEntry[]> {
    const res = await this.http.request<{ positions?: IgPositionEntry[] }>({ path: "/positions", version: 2 });
    return res.positions ?? [];
  }

  private async rawPosition(dealId: string): Promise<IgPositionEntry> {
    if (!dealId) throw invalid("positionId (IG dealId) is required.");
    let p: IgPositionEntry;
    try {
      p = await this.http.request<IgPositionEntry>({ path: `/positions/${encodeURIComponent(dealId)}`, version: 2 });
    } catch (err) {
      if (err instanceof PlatformError && err.code === "not_found") {
        throw new PlatformError("not_found", `No open IG position with dealId ${dealId}. Use getPositions to list open positions. (${err.message})`);
      }
      throw err;
    }
    if (!p.position) throw new PlatformError("not_found", `No open IG position with dealId ${dealId}. Use getPositions to list open positions.`);
    return p;
  }

  private mapPosition(e: IgPositionEntry, facts: IgInstrumentFacts | undefined): Position {
    const pos = e.position ?? {};
    const m = e.market ?? {};
    const epic = m.epic ?? "";
    const side = pos.direction === "SELL" ? "short" : "long";
    const size = num(pos.size) ?? 0;
    const level = num(pos.level);
    const markPrice = side === "long" ? num(m.bid) : num(m.offer);

    let unrealizedPnl: number | null = null;
    const sameCcy = !pos.currency || !facts?.currency || pos.currency === facts.currency;
    if (facts && facts.valuePerPoint !== null && level !== null && markPrice !== null && (facts.isSpreadbet || sameCcy)) {
      const points = ((markPrice - level) * (side === "long" ? 1 : -1)) / facts.pointSize;
      unrealizedPnl = Math.round(points * size * facts.valuePerPoint * 100) / 100;
    }
    const trailPts = num(pos.trailingStopDistance);
    return {
      id: pos.dealId ?? "",
      instrumentId: epic,
      symbol: epicSymbol(epic),
      side,
      size,
      entryPrice: level,
      markPrice,
      unrealizedPnl,
      realizedPnl: null,
      currency: pos.currency ?? null,
      leverage: null,
      margin: null,
      liquidationPrice: null,
      stopLoss: num(pos.stopLevel),
      takeProfit: num(pos.limitLevel),
      trailingStop: trailPts && facts ? trailPts * facts.pointSize : null,
      openedAt: parseIgUtc(pos.createdDateUTC),
      extra: {
        name: m.instrumentName ?? null,
        expiry: m.expiry ?? null,
        guaranteedStop: pos.controlledRisk === true,
        ...(trailPts ? { trailingStopDistancePoints: trailPts, trailingStepPoints: num(pos.trailingStep) } : {}),
        marketStatus: mapMarketStatus(m.marketStatus),
      },
    };
  }

  async getPositions(p: { instrumentId?: string }): Promise<Position[]> {
    const entries = (await this.rawPositions()).filter((e) => !p.instrumentId || e.market?.epic === p.instrumentId);
    const facts = await this.factsFor(entries.map((e) => e.market?.epic ?? ""));
    return entries.map((e) => this.mapPosition(e, facts.get(e.market?.epic ?? "")));
  }

  private async rawWorkingOrders(): Promise<IgWorkingOrderEntry[]> {
    const res = await this.http.request<{ workingOrders?: IgWorkingOrderEntry[] }>({ path: "/workingorders", version: 2 });
    return res.workingOrders ?? [];
  }

  private mapWorkingOrder(e: IgWorkingOrderEntry, facts: IgInstrumentFacts | undefined): Order {
    const w = e.workingOrderData ?? {};
    const m = e.marketData ?? {};
    const epic = w.epic ?? m.epic ?? "";
    const type: OrderType = w.orderType === "STOP" ? "stop" : "limit";
    const level = num(w.orderLevel);
    const buy = w.direction !== "SELL";
    const toLevel = (distPts: number | null, towardsProfit: boolean): number | null => {
      if (distPts === null || distPts <= 0 || level === null || !facts) return null;
      const d = distPts * facts.pointSize;
      const up = towardsProfit === buy;
      return roundTo(up ? level + d : level - d, facts.priceTick);
    };
    return {
      id: w.dealId ?? "",
      clientOrderId: null,
      instrumentId: epic,
      symbol: epicSymbol(epic),
      side: buy ? "buy" : "sell",
      type,
      status: "open",
      size: num(w.orderSize) ?? 0,
      filledSize: 0,
      price: type === "limit" ? level : null,
      triggerPrice: type === "stop" ? level : null,
      avgFillPrice: null,
      timeInForce: w.timeInForce === "GOOD_TILL_CANCELLED" ? "gtc" : null,
      reduceOnly: null,
      stopLoss: toLevel(num(w.stopDistance), false),
      takeProfit: toLevel(num(w.limitDistance), true),
      createdAt: parseIgUtc(w.createdDateUTC),
      updatedAt: null,
      rejectReason: null,
      extra: {
        name: m.instrumentName ?? null,
        expiry: m.expiry ?? null,
        guaranteedStop: w.guaranteedStop === true,
        ...(w.timeInForce === "GOOD_TILL_DATE" ? { goodTillDate: w.goodTillDateISO ?? w.goodTillDate ?? null } : {}),
        ...(num(w.stopDistance) ? { stopDistancePoints: num(w.stopDistance) } : {}),
        ...(num(w.limitDistance) ? { limitDistancePoints: num(w.limitDistance) } : {}),
      },
    };
  }

  async getOpenOrders(p: { instrumentId?: string }): Promise<Order[]> {
    const entries = (await this.rawWorkingOrders()).filter(
      (e) => !p.instrumentId || (e.workingOrderData?.epic ?? e.marketData?.epic) === p.instrumentId,
    );
    const facts = await this.factsFor(entries.map((e) => e.workingOrderData?.epic ?? e.marketData?.epic ?? ""));
    return entries.map((e) => this.mapWorkingOrder(e, facts.get(e.workingOrderData?.epic ?? e.marketData?.epic ?? "")));
  }

  // ---- history ----------------------------------------------------------------

  private range(p: TimeRange): { from: number; to: number } {
    const to = p.to ?? Date.now();
    const from = p.from ?? to - 30 * DAY_MS;
    return { from, to };
  }

  private async fetchActivities(from: number, to: number, max: number): Promise<IgActivity[]> {
    const out: IgActivity[] = [];
    let query: Record<string, string | number | boolean> = {
      from: formatIgDate(from),
      to: formatIgDate(to),
      detailed: true,
      pageSize: Math.min(500, Math.max(50, max)),
    };
    for (let page = 0; page < 10 && out.length < max; page++) {
      const res = await this.http.request<{ activities?: IgActivity[]; metadata?: { paging?: { next?: string | null } } }>({
        path: "/history/activity",
        version: 3,
        query,
      });
      out.push(...(res.activities ?? []));
      const next = res.metadata?.paging?.next;
      if (!next || (res.activities ?? []).length === 0) break;
      const u = new URL(next, "https://placeholder.invalid");
      const nextQuery: Record<string, string> = {};
      u.searchParams.forEach((v, k) => {
        if (k !== "version") nextQuery[k] = v;
      });
      query = nextQuery;
    }
    return out;
  }

  async getOrderHistory(p: TimeRange): Promise<Order[]> {
    const { from, to } = this.range(p);
    const acts = await this.fetchActivities(from, to, Math.max(p.limit, 50));
    const orders: Order[] = [];
    for (const a of acts) {
      if (a.type !== "POSITION" && a.type !== "WORKING_ORDER") continue;
      if (p.instrumentId && a.epic !== p.instrumentId) continue;
      const d = a.details ?? {};
      const actions = (d.actions ?? []).map((x) => x.actionType ?? "").filter(Boolean);
      let type: OrderType = "market";
      if (a.type === "WORKING_ORDER") type = actions.some((x) => x.startsWith("STOP_ORDER")) ? "stop" : "limit";
      const status = actionStatus(actions, a.status);
      const level = num(d.level);
      const size = num(d.size) ?? 0;
      const t = parseIgUtc(a.date);
      orders.push({
        id: a.dealId ?? "",
        clientOrderId: d.dealReference ?? null,
        instrumentId: a.epic ?? "",
        symbol: a.epic ? epicSymbol(a.epic) : (d.marketName ?? ""),
        side: d.direction === "SELL" ? "sell" : "buy",
        type,
        status,
        size,
        filledSize: status === "filled" ? size : null,
        price: type === "limit" ? level : null,
        triggerPrice: type === "stop" ? level : null,
        avgFillPrice: type === "market" && status === "filled" ? level : null,
        timeInForce: null,
        reduceOnly: null,
        stopLoss: num(d.stopLevel),
        takeProfit: num(d.limitLevel),
        createdAt: t,
        updatedAt: t,
        rejectReason: status === "rejected" ? (a.description ?? null) : null,
        extra: { description: a.description ?? null, actions },
      });
    }
    return orders.sort((x, y) => (y.createdAt ?? 0) - (x.createdAt ?? 0)).slice(0, p.limit);
  }

  async getFills(p: TimeRange): Promise<Fill[]> {
    const { from, to } = this.range(p);
    const acts = await this.fetchActivities(from, to, Math.max(p.limit, 50));
    const fills: Fill[] = [];
    const seen = new Set<string>();
    for (const a of acts) {
      if (a.type !== "POSITION" || a.status !== "ACCEPTED") continue;
      if (p.instrumentId && a.epic !== p.instrumentId) continue;
      const d = a.details ?? {};
      const actions = (d.actions ?? []).map((x) => x.actionType ?? "");
      if (!actions.some((x) => x === "POSITION_OPENED" || x === "POSITION_CLOSED" || x === "POSITION_PARTIALLY_CLOSED")) continue;
      const price = num(d.level);
      const size = num(d.size);
      const time = parseIgUtc(a.date);
      if (price === null || size === null || time === null || !a.dealId) continue;
      let id = a.dealId;
      for (let i = 2; seen.has(id); i++) id = `${a.dealId}#${i}`;
      seen.add(id);
      fills.push({
        id,
        orderId: a.dealId,
        instrumentId: a.epic ?? "",
        symbol: a.epic ? epicSymbol(a.epic) : (d.marketName ?? ""),
        side: d.direction === "SELL" ? "sell" : "buy",
        size,
        price,
        fee: null,
        feeCurrency: null,
        realizedPnl: null,
        isMaker: null,
        time,
      });
    }
    return fills.sort((x, y) => y.time - x.time).slice(0, p.limit);
  }

  async getClosedPnl(p: TimeRange): Promise<ClosedPnl[]> {
    const { from, to } = this.range(p);
    const txs: IgTransaction[] = [];
    const pageSize = Math.min(500, Math.max(50, p.limit));
    for (let page = 1; page <= 20 && txs.length < p.limit; page++) {
      const res = await this.http.request<{
        transactions?: IgTransaction[];
        metadata?: { pageData?: { totalPages?: number } };
      }>({
        path: "/history/transactions",
        version: 2,
        query: { type: "ALL_DEAL", from: formatIgDate(from), to: formatIgDate(to), pageSize, pageNumber: page },
      });
      const batch = (res.transactions ?? []).filter((t) => !t.cashTransaction);
      txs.push(...batch);
      const totalPages = num(res.metadata?.pageData?.totalPages) ?? 1;
      if (page >= totalPages || (res.transactions ?? []).length === 0) break;
    }
    if (txs.length === 0) return [];

    // Transactions only carry the instrument name; recover epics from the activity history.
    const nameToEpic = new Map<string, string>();
    try {
      for (const a of await this.fetchActivities(from, to, 500)) {
        const name = a.details?.marketName;
        if (name && a.epic && !nameToEpic.has(name)) nameToEpic.set(name, a.epic);
      }
    } catch {
      // epics stay unknown
    }
    const fallbackCcy = typeof this.ctx.meta.currency === "string" ? this.ctx.meta.currency : null;

    const out: ClosedPnl[] = [];
    for (const t of txs) {
      const pnl = parseMoney(t.profitAndLoss);
      const closedAt = parseIgUtc(t.dateUtc);
      if (pnl === null || closedAt === null) continue;
      const name = t.instrumentName ?? "";
      const epic = nameToEpic.get(name) ?? null;
      if (p.instrumentId && epic !== p.instrumentId) continue;
      const signedSize = num(t.size);
      out.push({
        id: t.reference ?? `${name}@${closedAt}`,
        instrumentId: epic ?? name,
        symbol: epic ? epicSymbol(epic) : name,
        side: signedSize === null || signedSize === 0 ? null : signedSize > 0 ? "long" : "short",
        size: signedSize === null ? null : Math.abs(signedSize),
        entryPrice: num(t.openLevel),
        exitPrice: num(t.closeLevel),
        pnl,
        currency: t.currency && /^[A-Z]{3}$/.test(t.currency) ? t.currency : fallbackCcy,
        orderId: t.reference ?? null,
        openedAt: parseIgUtc(t.openDateUtc),
        closedAt,
      });
    }
    return out.sort((a, b) => b.closedAt - a.closedAt).slice(0, p.limit);
  }

  // ---- trading ------------------------------------------------------------------

  private dealReference(clientOrderId?: string): string {
    if (clientOrderId !== undefined && clientOrderId !== "") {
      if (!/^[A-Za-z0-9_-]{1,30}$/.test(clientOrderId)) {
        throw invalid("clientOrderId must be 1-30 characters of A-Z, a-z, 0-9, '_' or '-' (IG deal reference rules).");
      }
      return clientOrderId;
    }
    return `FB${randomBytes(10).toString("hex").toUpperCase()}`;
  }

  /** Poll /confirms/{dealReference}; returns null if IG has no confirmation after a few tries. */
  private async confirm(dealReference: string): Promise<IgConfirm | null> {
    const delays = [200, 400, 700, 1000, 1500];
    for (let i = 0; ; i++) {
      try {
        return await this.http.request<IgConfirm>({ path: `/confirms/${encodeURIComponent(dealReference)}`, version: 1 });
      } catch (err) {
        if (err instanceof PlatformError && err.code === "not_found") {
          const d = delays[i];
          if (d === undefined) return null;
          await sleep(d);
          continue;
        }
        throw err;
      }
    }
  }

  private result(conf: IgConfirm | null, dealReference: string, kind: ConfirmKind, positionId: string | null = null): OrderResult {
    if (!conf) {
      return {
        orderId: null,
        status: "unknown",
        message: `IG accepted the request (deal reference ${dealReference}) but no confirmation arrived yet. Check getPositions / getOpenOrders before retrying.`,
        filledSize: null,
        avgFillPrice: null,
        positionId,
        extra: { dealReference },
      };
    }
    const extra: Record<string, unknown> = { dealReference, igStatus: conf.status ?? null };
    if (conf.dealStatus !== "ACCEPTED") {
      return {
        orderId: conf.dealId ?? null,
        status: "rejected",
        message: rejectMessage(conf.reason),
        filledSize: null,
        avgFillPrice: null,
        positionId,
        extra: { ...extra, reason: conf.reason ?? null },
      };
    }
    const affected = (conf.affectedDeals ?? []).map((d) => ({ dealId: d.dealId ?? null, status: d.status ?? null }));
    if (affected.length) extra.affectedDeals = affected;
    switch (kind) {
      case "open": {
        let pos = conf.dealId ?? null;
        let message: string | null = null;
        if (conf.status && conf.status !== "OPEN") {
          // forceOpen=false netted the deal against an existing opposite position.
          pos = affected[0]?.dealId ?? pos;
          message = `Netted against an existing opposite position (IG status ${conf.status}).`;
        }
        return { orderId: conf.dealId ?? null, status: "filled", message, filledSize: num(conf.size), avgFillPrice: num(conf.level), positionId: pos, extra };
      }
      case "close": {
        const profit = num(conf.profit);
        if (profit !== null) extra.profit = profit;
        if (conf.profitCurrency) extra.profitCurrency = conf.profitCurrency;
        return { orderId: conf.dealId ?? null, status: "filled", message: null, filledSize: num(conf.size), avgFillPrice: num(conf.level), positionId, extra };
      }
      case "working":
      case "amend":
        return { orderId: conf.dealId ?? null, status: "open", message: null, filledSize: 0, avgFillPrice: null, positionId: null, extra };
      case "cancel":
        return { orderId: conf.dealId ?? null, status: "cancelled", message: null, filledSize: null, avgFillPrice: null, positionId: null, extra };
    }
  }

  private async submit(path: string, version: number, body: Record<string, unknown>, method: "POST" | "PUT" | "DELETE" = "POST"): Promise<string> {
    const res = await this.http.request<DealRefResponse>({
      path,
      version,
      method: method === "DELETE" ? "POST" : method,
      deleteViaPost: method === "DELETE",
      body,
      trading: true,
    });
    if (!res.dealReference) throw new PlatformError("platform_error", `IG did not return a deal reference for ${path}.`);
    return res.dealReference;
  }

  async placeOrder(req: PlaceOrderRequest): Promise<OrderResult> {
    const epic = req.instrumentId;
    if (!epic) throw invalid("instrumentId (IG epic) is required.");
    if (!(req.size > 0)) throw invalid("size must be greater than 0.");
    if (req.type === "stop_limit") throw unsupported("stop_limit orders", PLATFORM);
    if (req.positionSide) throw invalid("positionSide is not used on IG (no hedge mode).");

    const hasTrailing = req.trailingStopDistance !== undefined && req.trailingStopDistance !== null;
    const hasStop = req.stopLoss !== undefined && req.stopLoss !== null;
    const hasLimit = req.takeProfit !== undefined && req.takeProfit !== null;
    const hasProtection = hasStop || hasLimit || hasTrailing;
    if (req.reduceOnly && hasProtection) {
      throw invalid("IG cannot attach stops/limits to a reducing deal. Reduce without them, or use setPositionProtection on the position.");
    }
    if (hasTrailing && hasStop) throw invalid("On IG a trailing stop replaces the stop loss: pass either stopLoss or trailingStopDistance, not both.");
    if (hasTrailing && req.guaranteedStop) throw invalid("IG does not allow a guaranteed stop together with a trailing stop.");
    if (req.guaranteedStop && !hasStop) throw invalid("guaranteedStop requires stopLoss.");
    if (hasTrailing && !(req.trailingStopDistance! > 0)) throw invalid("trailingStopDistance must be greater than 0 (price units).");

    const facts = await this.getFacts(epic);
    const direction = req.side === "buy" ? "BUY" : "SELL";
    const dealReference = this.dealReference(req.clientOrderId);

    if (req.reduceOnly) {
      const opposite = req.side === "buy" ? "SELL" : "BUY";
      const open = (await this.rawPositions()).filter((e) => e.market?.epic === epic && e.position?.direction === opposite);
      const total = open.reduce((s, e) => s + (num(e.position?.size) ?? 0), 0);
      if (total <= 0) throw invalid(`reduceOnly: there is no open ${opposite === "BUY" ? "long" : "short"} position in ${epic} to reduce.`);
      if (req.size > total + 1e-9) throw invalid(`reduceOnly: size ${req.size} exceeds the open opposite position size ${total}.`);
    }
    // IG requires forceOpen=true when stops/limits are attached. Without them we keep IG's
    // default netting behaviour (forceOpen=false), so an opposite deal reduces open positions.
    const forceOpen = hasProtection;

    const body: Record<string, unknown> = {
      epic,
      expiry: facts.expiry,
      direction,
      size: cleanSize(req.size),
      forceOpen,
      guaranteedStop: req.guaranteedStop === true,
      dealReference,
    };
    if (facts.currency) body.currencyCode = facts.currency;
    if (hasStop) body.stopLevel = roundTo(req.stopLoss!, facts.priceTick);
    if (hasLimit) body.limitLevel = roundTo(req.takeProfit!, facts.priceTick);

    if (req.type === "market") {
      const tif = req.timeInForce;
      if (tif && tif !== "ioc" && tif !== "fok" && tif !== "gtc") {
        throw invalid(`timeInForce ${tif} is not supported for IG market orders (use ioc or fok).`);
      }
      body.orderType = "MARKET";
      body.timeInForce = tif === "fok" ? "FILL_OR_KILL" : "EXECUTE_AND_ELIMINATE";
      if (hasTrailing) {
        const ptsStep = facts.priceTick ? facts.priceTick / facts.pointSize : null;
        body.trailingStop = true;
        body.stopDistance = roundTo(req.trailingStopDistance! / facts.pointSize, ptsStep);
        body.trailingStopIncrement = facts.minStepPoints ?? 1;
      }
      const ref = await this.submit("/positions/otc", 2, body);
      return this.result(await this.confirm(ref), ref, "open");
    }

    // limit / stop → working order
    if (hasTrailing) {
      throw new PlatformError(
        "unsupported",
        "IG working orders cannot carry a trailing stop. Place the order with stopLoss and add a trailing stop with setPositionProtection once it has filled.",
      );
    }
    if (req.timeInForce && req.timeInForce !== "gtc") {
      throw invalid(`timeInForce ${req.timeInForce} is not supported for IG limit/stop orders; they are good-till-cancelled (gtc).`);
    }
    const level = req.type === "limit" ? req.price : (req.triggerPrice ?? req.price);
    if (level === undefined || !(level > 0)) {
      throw invalid(req.type === "limit" ? "price is required for limit orders." : "triggerPrice is required for stop orders.");
    }
    body.type = req.type === "limit" ? "LIMIT" : "STOP";
    body.level = roundTo(level, facts.priceTick);
    body.timeInForce = "GOOD_TILL_CANCELLED";
    const ref = await this.submit("/workingorders/otc", 2, body);
    return this.result(await this.confirm(ref), ref, "working");
  }

  async amendOrder(req: AmendOrderRequest): Promise<OrderResult> {
    if (req.size !== undefined) {
      throw invalid("IG cannot change the size of a working order. Cancel it and place a new one.");
    }
    const entry = (await this.rawWorkingOrders()).find((e) => e.workingOrderData?.dealId === req.orderId);
    if (!entry?.workingOrderData) {
      throw new PlatformError("not_found", `No open IG working order with dealId ${req.orderId}. Use getOpenOrders to list them.`);
    }
    const w = entry.workingOrderData;
    const epic = w.epic ?? entry.marketData?.epic ?? "";
    const facts = (await this.factsFor([epic])).get(epic);
    const isStop = w.orderType === "STOP";
    const oldLevel = num(w.orderLevel);
    const newLevelRaw = isStop ? (req.triggerPrice ?? req.price) : (req.price ?? req.triggerPrice);
    const level = newLevelRaw !== undefined ? roundTo(newLevelRaw, facts?.priceTick ?? null) : oldLevel;
    if (level === null) throw new PlatformError("platform_error", "IG returned the working order without a level.");

    const body: Record<string, unknown> = {
      level,
      type: w.orderType ?? "LIMIT",
      timeInForce: w.timeInForce ?? "GOOD_TILL_CANCELLED",
    };
    if (w.timeInForce === "GOOD_TILL_DATE" && w.goodTillDate) body.goodTillDate = w.goodTillDate;

    const buy = w.direction !== "SELL";
    // Keep existing stop/limit at their absolute levels when the order level moves.
    const keep = (distPts: number | null, towardsProfit: boolean, key: "stop" | "limit") => {
      if (distPts === null || distPts <= 0) return;
      if (facts && oldLevel !== null) {
        const d = distPts * facts.pointSize;
        body[`${key}Level`] = roundTo(towardsProfit === buy ? oldLevel + d : oldLevel - d, facts.priceTick);
      } else {
        body[`${key}Distance`] = distPts;
      }
    };
    if (req.stopLoss === undefined) keep(num(w.stopDistance), false, "stop");
    else if (req.stopLoss !== null) body.stopLevel = roundTo(req.stopLoss, facts?.priceTick ?? null);
    if (req.takeProfit === undefined) keep(num(w.limitDistance), true, "limit");
    else if (req.takeProfit !== null) body.limitLevel = roundTo(req.takeProfit, facts?.priceTick ?? null);
    const hasStop = body.stopLevel !== undefined || body.stopDistance !== undefined;
    body.guaranteedStop = w.guaranteedStop === true && hasStop;

    const ref = await this.submit(`/workingorders/otc/${encodeURIComponent(req.orderId)}`, 2, body, "PUT");
    return this.result(await this.confirm(ref), ref, "amend");
  }

  async cancelOrder(req: { orderId: string; instrumentId?: string }): Promise<OrderResult> {
    if (!req.orderId) throw invalid("orderId (IG dealId) is required.");
    const ref = await this.submit(`/workingorders/otc/${encodeURIComponent(req.orderId)}`, 2, {}, "DELETE");
    return this.result(await this.confirm(ref), ref, "cancel");
  }

  async cancelAllOrders(p: { instrumentId?: string }): Promise<{ cancelled: string[] }> {
    const entries = (await this.rawWorkingOrders()).filter(
      (e) => !p.instrumentId || (e.workingOrderData?.epic ?? e.marketData?.epic) === p.instrumentId,
    );
    const cancelled: string[] = [];
    let firstError: unknown = null;
    for (const e of entries) {
      const id = e.workingOrderData?.dealId;
      if (!id) continue;
      try {
        const r = await this.cancelOrder({ orderId: id });
        if (r.status === "cancelled" || r.status === "unknown") cancelled.push(id);
      } catch (err) {
        firstError ??= err;
      }
    }
    if (firstError && cancelled.length === 0) throw firstError;
    return { cancelled };
  }

  async closePosition(req: ClosePositionRequest): Promise<OrderResult> {
    const entry = await this.rawPosition(req.positionId);
    const pos = entry.position!;
    const openSize = num(pos.size) ?? 0;
    const size = req.size ?? openSize;
    if (!(size > 0)) throw invalid("size must be greater than 0.");
    if (size > openSize + 1e-9) throw invalid(`size ${size} exceeds the open position size ${openSize}.`);
    const body: Record<string, unknown> = {
      dealId: req.positionId,
      direction: pos.direction === "SELL" ? "BUY" : "SELL",
      size: cleanSize(size),
      orderType: req.type === "limit" ? "LIMIT" : "MARKET",
      timeInForce: "EXECUTE_AND_ELIMINATE",
    };
    if (req.type === "limit") {
      if (req.price === undefined || !(req.price > 0)) throw invalid("price is required to close with a limit.");
      body.level = req.price;
    }
    const ref = await this.submit("/positions/otc", 1, body, "DELETE");
    return this.result(await this.confirm(ref), ref, "close", req.positionId);
  }

  async setPositionProtection(req: PositionProtectionRequest): Promise<Position | null> {
    const entry = await this.rawPosition(req.positionId);
    const pos = entry.position!;
    const epic = entry.market?.epic ?? "";
    const facts = (await this.factsFor([epic])).get(epic);
    const long = pos.direction !== "SELL";
    const tick = facts?.priceTick ?? null;

    let stopLevel: number | null = req.stopLoss === undefined ? num(pos.stopLevel) : req.stopLoss;
    const limitLevel: number | null = req.takeProfit === undefined ? num(pos.limitLevel) : req.takeProfit;

    const curTrail = num(pos.trailingStopDistance);
    let trailing: { distPts: number; stepPts: number } | null = null;
    if (req.trailingStopDistance === undefined) {
      if (curTrail && curTrail > 0) trailing = { distPts: curTrail, stepPts: num(pos.trailingStep) ?? facts?.minStepPoints ?? 1 };
    } else if (req.trailingStopDistance !== null) {
      if (!(req.trailingStopDistance > 0)) throw invalid("trailingStopDistance must be greater than 0 (price units).");
      if (!facts) throw new PlatformError("platform_error", `Could not load instrument details for ${epic} to convert the trailing distance.`);
      const ptsStep = facts.priceTick ? facts.priceTick / facts.pointSize : null;
      trailing = {
        distPts: roundTo(req.trailingStopDistance / facts.pointSize, ptsStep),
        stepPts: num(pos.trailingStep) ?? facts.minStepPoints ?? 1,
      };
    }

    const body: Record<string, unknown> = { limitLevel: limitLevel === null ? null : roundTo(limitLevel, tick) };
    if (trailing) {
      if (req.stopLoss === null) {
        throw invalid("An IG trailing stop needs a stop level. To remove the stop, also pass trailingStopDistance: null.");
      }
      if (pos.controlledRisk === true) throw invalid("IG does not allow a trailing stop on a position with a guaranteed stop.");
      if (stopLevel === null) {
        const mark = long ? num(entry.market?.bid) : num(entry.market?.offer);
        if (mark === null || !facts) throw invalid("No current price to place the initial trailing stop; pass stopLoss as well.");
        const d = trailing.distPts * facts.pointSize;
        stopLevel = long ? mark - d : mark + d;
      }
      body.trailingStop = true;
      body.trailingStopDistance = trailing.distPts;
      body.trailingStopIncrement = trailing.stepPts;
      body.guaranteedStop = false;
    } else {
      body.trailingStop = false;
      body.guaranteedStop = pos.controlledRisk === true && stopLevel !== null;
    }
    body.stopLevel = stopLevel === null ? null : roundTo(stopLevel, tick);

    const ref = await this.submit(`/positions/otc/${encodeURIComponent(req.positionId)}`, 2, body, "PUT");
    const conf = await this.confirm(ref);
    if (conf && conf.dealStatus !== "ACCEPTED") {
      throw new PlatformError(rejectCode(conf.reason), rejectMessage(conf.reason), { dealReference: ref, reason: conf.reason });
    }
    const refreshed = await this.getPositions({ instrumentId: epic });
    return refreshed.find((p) => p.id === req.positionId) ?? null;
  }

  async close(): Promise<void> {
    await this.liveStream?.close();
    this.liveStream = null;
    this.http.logout();
  }
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export const igPlatform: PlatformDefinition = {
  id: "ig",
  name: "IG",
  description:
    "IG.com CFD and spread bet accounts via the IG REST trading API (forex, indices, shares, commodities, rates). API keys can trade but cannot withdraw or transfer funds.",
  website: "https://www.ig.com",
  setupHelp: [
    "Log in to My IG, open Settings → API keys and create an API key.",
    "Enter your IG username and password (the same login you use for the IG platform) plus the API key.",
    "Demo accounts have their own login: log in to the demo platform, create a separate demo API key there and use the Demo environment.",
    "One IG login can hold several accounts (e.g. CFD and spread bet). Leave Account ID empty to use the preferred account, or enter the id (e.g. Z1234) shown in My IG.",
    "Spread bet accounts trade a stake per point; CFD accounts trade contracts. The two use different epics.",
  ],
  credentialFields: [
    { key: "username", label: "Username", type: "text", required: true, secret: false, help: "Your IG login username." },
    { key: "password", label: "Password", type: "password", required: true, secret: true },
    {
      key: "apiKey",
      label: "API key",
      type: "password",
      required: true,
      secret: true,
      help: "API key from My IG → Settings → API keys (demo accounts need a demo API key).",
    },
    {
      key: "accountId",
      label: "Account ID",
      type: "text",
      required: false,
      secret: false,
      help: "Optional. Leave empty to use the preferred account; IG logins can hold several accounts, e.g. CFD and spread bet.",
    },
  ],
  environments: [
    { id: "live", label: "Live", isDemo: false, description: "Real-money IG account (api.ig.com)." },
    { id: "demo", label: "Demo", isDemo: true, description: "IG demo account (demo-api.ig.com); needs a demo login and demo API key." },
  ],
  capabilities: {
    instrumentTypes: ["cfd", "spreadbet", "option"],
    resolutions: ["1m", "2m", "3m", "5m", "10m", "15m", "30m", "1h", "2h", "3h", "4h", "1d", "1w", "1M"],
    orderTypes: ["market", "limit", "stop"],
    timeInForce: ["gtc", "ioc", "fok"],
    orderBook: false,
    setLeverage: false,
    amendOrder: true,
    stopLossTakeProfit: true,
    trailingStop: true,
    guaranteedStop: true,
    hedgeMode: false,
    notes: [
      "Instrument ids are IG epics (e.g. CS.D.EURUSD.CFD.IP). CFD and spread bet accounts use different epics; find them with searchInstruments.",
      "size = stake per point (account currency) on spread bet accounts, number of contracts on CFD accounts. Check minSize and sizeUnit via getInstrument.",
      "Historical candles cost IG's weekly price-data allowance (one point per candle); check getQuota and rely on cached data.",
      "Markets have trading hours; orders are rejected while a market is closed.",
      "Stops and limits must respect the instrument's minStopDistance. Distances (trailing stop) are in price units.",
      "Deals without stops/limits net against open opposite positions; deals with stops/limits always open a separate position (IG forceOpen rule).",
      "Limit/stop orders are good-till-cancelled; IG cannot change a working order's size (cancel and re-place). Margins are fixed per instrument (no setLeverage).",
    ],
  },
  createClient(ctx: PlatformClientContext): PlatformClient {
    return new IgClient(ctx);
  },
};

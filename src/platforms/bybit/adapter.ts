import { randomBytes } from "node:crypto";
import { PlatformError } from "../errors.js";
import { formatToStep, num } from "../http.js";
import type {
  AccountSummary,
  AmendOrderRequest,
  Balance,
  Candle,
  ClosedPnl,
  ClosePositionRequest,
  DataQuota,
  Fill,
  Instrument,
  InstrumentSummary,
  InstrumentType,
  Order,
  OrderBook,
  OrderResult,
  PlaceOrderRequest,
  PlatformClient,
  PlatformClientContext,
  Position,
  PositionProtectionRequest,
  Quote,
  Resolution,
  TimeRange,
  ValidationResult,
} from "../types.js";
import { BybitHttp, type BybitHttpOptions, type Params } from "./client.js";
import {
  type Category,
  type RawClosedPnl,
  type RawExecution,
  type RawInstrument,
  type RawList,
  type RawOrder,
  type RawPosition,
  type RawTicker,
  LINEAR_SETTLE_COINS,
  OPTION_BASE_COINS,
  instrumentId,
  mapClosedPnl,
  mapFill,
  mapInstrument,
  mapOrder,
  mapPosition,
  mapTicker,
  parseInstrumentId,
  parseOptionSymbol,
  parsePositionId,
  positionId,
  settleCoinOf,
  toBybitTif,
} from "./mappers.js";

const CACHE_TTL_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
const WINDOW_MS = 7 * DAY_MS;
const MAX_LOOKBACK_MS = 730 * DAY_MS;

const KLINE_INTERVALS: Partial<Record<Resolution, string>> = {
  "1m": "1",
  "3m": "3",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "1h": "60",
  "2h": "120",
  "4h": "240",
  "6h": "360",
  "12h": "720",
  "1d": "D",
  "1w": "W",
  "1M": "M",
};

const ORDERBOOK_MAX: Record<Category, number> = { spot: 200, linear: 500, inverse: 500, option: 25 };

const RATE_LIMIT_QUOTA_NOTE =
  "Bybit market data has no data allowance; public endpoints are only rate-limited per IP (about 600 requests per 5 s), private endpoints per API key. This server additionally throttles to 10 private requests/s per account.";

// Shared (process-wide) caches keyed by host: instrument lists and 24h turnover for ranking.
const instrumentCache = new Map<string, { at: number; list: RawInstrument[] }>();
const instrumentInflight = new Map<string, Promise<RawInstrument[]>>();
const turnoverCache = new Map<string, { at: number; map: Map<string, number> }>();

/** Errors that mean "this category/settle coin is not available for this account" rather than a real failure. */
const TOLERATED = new Set(["permission_denied", "invalid_request", "rejected", "unsupported", "not_found"]);

interface QueryApiResult {
  id?: string;
  note?: string;
  readOnly?: number;
  permissions?: Record<string, string[] | undefined>;
  ips?: string[];
  type?: number;
  deadlineDay?: number;
  expiredAt?: string;
  uta?: number;
  userID?: number | string;
  isMaster?: boolean;
  parentUid?: string;
  kycLevel?: string;
}

interface AccountInfoResult {
  unifiedMarginStatus?: number;
  marginMode?: string;
  isMasterTrader?: boolean;
  spotHedgingStatus?: string;
}

interface RawWalletCoin {
  coin: string;
  equity?: string;
  usdValue?: string;
  walletBalance?: string;
  free?: string;
  locked?: string;
  availableToWithdraw?: string;
  totalOrderIM?: string;
  totalPositionIM?: string;
  unrealisedPnl?: string;
  borrowAmount?: string;
}

interface RawWallet {
  accountType?: string;
  totalEquity?: string;
  totalWalletBalance?: string;
  totalAvailableBalance?: string;
  totalPerpUPL?: string;
  totalInitialMargin?: string;
  totalMaintenanceMargin?: string;
  accountIMRate?: string;
  accountMMRate?: string;
  coin?: RawWalletCoin[];
}

interface Spec {
  category: Category;
  params: Params;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function newOrderLinkId(): string {
  return `fb-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
}

function pick(i: Instrument): InstrumentSummary {
  return {
    id: i.id,
    symbol: i.symbol,
    name: i.name,
    type: i.type,
    assetClass: i.assetClass,
    quoteCurrency: i.quoteCurrency,
    status: i.status,
    expiry: i.expiry,
  };
}

export class BybitClient implements PlatformClient {
  private readonly http: BybitHttp;

  constructor(
    private readonly ctx: PlatformClientContext,
    opts: BybitHttpOptions,
  ) {
    this.http = new BybitHttp(opts);
  }

  marketDataKey(): string {
    return this.ctx.environment === "testnet" ? "bybit:testnet" : "bybit:mainnet";
  }

  // -------------------------------------------------------------------------
  // Validation & account
  // -------------------------------------------------------------------------

  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    let key: QueryApiResult;
    try {
      key = (await this.http.privateGet<QueryApiResult>("/v5/user/query-api")).result;
    } catch (err) {
      if (!(err instanceof PlatformError)) throw err;
      let msg = err.message;
      if (err.code === "auth_failed") {
        msg += ` (environment: ${this.ctx.environment}, host: ${this.http.host})`;
      }
      return { errors: [msg], warnings, canTrade: false, externalId: null, description: null, currency: "USD", meta: {} };
    }

    const perms = key.permissions ?? {};
    const allPerms = Object.entries(perms).flatMap(([group, vals]) => (vals ?? []).map((v) => `${group}:${v}`));
    const canWithdraw =
      (perms.Wallet ?? []).some((v) => /withdraw/i.test(v)) ||
      (perms.Withdraw ?? []).length > 0 ||
      allPerms.some((p) => /withdraw/i.test(p));
    if (canWithdraw) {
      errors.push(
        "This API key has a withdrawal permission. For safety, floorbroker refuses keys that can withdraw funds: delete the key on Bybit and create a new one without any Withdrawal permission.",
      );
    }

    const readOnly = key.readOnly === 1;
    const contract = (perms.ContractTrade ?? []).length > 0 || (perms.Derivatives ?? []).length > 0;
    const spot = (perms.Spot ?? []).length > 0;
    const options = (perms.Options ?? []).length > 0;
    const canTrade = !readOnly && (contract || spot || options);
    if (readOnly) {
      warnings.push("The API key is read-only: the agent can view the account and market data but cannot place orders. Create a Read-Write key to allow trading.");
    } else if (!canTrade) {
      warnings.push("The API key has no trading permission (Orders/Positions, Spot or Options); the agent will not be able to place orders.");
    } else {
      const missing: string[] = [];
      if (!(perms.ContractTrade ?? []).includes("Order") && !(perms.Derivatives ?? []).length) missing.push("derivatives orders");
      if (!(perms.ContractTrade ?? []).includes("Position") && !(perms.Derivatives ?? []).length) missing.push("positions (leverage, TP/SL)");
      if (!spot) missing.push("spot trading");
      if (!options) missing.push("options trading");
      if (missing.length) warnings.push(`The key lacks permissions for: ${missing.join(", ")}. Those actions will fail.`);
    }

    let info: AccountInfoResult | null = null;
    try {
      info = (await this.http.privateGet<AccountInfoResult>("/v5/account/info")).result;
    } catch {
      info = null;
    }
    const ums = info?.unifiedMarginStatus ?? null;
    const uta = key.uta === 1 || (ums !== null && ums >= 3);
    if (!uta) {
      warnings.push("This is a classic (non-unified) Bybit account. Upgrade to a Unified Trading Account for full support; some features (options, account totals) may be limited.");
    }

    // Expiry: only meaningful for keys without IP binding (Bybit returns deadlineDay -2 / epoch otherwise).
    let expiresAt: number | null = null;
    if (key.expiredAt) {
      const t = Date.parse(key.expiredAt);
      if (Number.isFinite(t) && t > Date.UTC(2000, 0, 1)) expiresAt = t;
    }
    const daysLeft =
      typeof key.deadlineDay === "number" && key.deadlineDay >= 0
        ? key.deadlineDay
        : expiresAt
          ? Math.floor((expiresAt - Date.now()) / DAY_MS)
          : null;
    if (daysLeft !== null && daysLeft <= 14) {
      warnings.push(
        `The API key expires in ${daysLeft} day(s). Bind it to this server's IP on Bybit (IP-bound keys do not expire) or create a new key before then.`,
      );
    }
    const ips = key.ips ?? [];
    const ipBound = ips.length > 0 && !ips.includes("*");

    const uid = key.userID !== undefined ? String(key.userID) : null;
    const isMaster = key.isMaster !== false;
    const accountKind =
      ums === null ? (uta ? "Unified Trading Account" : "Classic account") : ums === 1 ? "Classic account" : ums >= 5 ? "Unified Trading Account" : "Unified Trading Account (1.0)";
    const parts = [uid ? `UID ${uid}` : null, accountKind, isMaster ? null : "sub-account", readOnly ? "read-only key" : null];
    if (this.ctx.environment !== "live") parts.push(this.ctx.environment === "demo" ? "demo trading" : "testnet");
    const description = parts.filter(Boolean).join(" · ");

    return {
      errors,
      warnings,
      canTrade: canTrade && !canWithdraw,
      externalId: uid,
      description,
      currency: "USD",
      meta: {
        uid,
        uta,
        unifiedMarginStatus: ums,
        marginMode: info?.marginMode ?? null,
        isMaster,
        parentUid: key.parentUid && key.parentUid !== "0" ? key.parentUid : null,
        readOnly,
        ipBound,
        keyExpiresAt: expiresAt,
        permissions: allPerms,
        host: this.http.host,
      },
    };
  }

  async getAccount(): Promise<AccountSummary> {
    const isClassic = this.ctx.meta.uta === false;
    if (!isClassic) {
      try {
        const r = await this.http.privateGet<{ list: RawWallet[] }>("/v5/account/wallet-balance", { accountType: "UNIFIED" });
        const w = r.result.list?.[0];
        if (w) return this.mapUnifiedWallet(w);
      } catch (err) {
        if (!(err instanceof PlatformError) || !TOLERATED.has(err.code) || this.ctx.meta.uta === true) throw err;
      }
    }
    return this.classicAccount();
  }

  private mapUnifiedWallet(w: RawWallet): AccountSummary {
    const balances: Balance[] = [];
    for (const c of w.coin ?? []) {
      const total = num(c.walletBalance) ?? num(c.equity) ?? 0;
      const equity = num(c.equity) ?? total;
      if (total === 0 && equity === 0) continue;
      let available = num(c.availableToWithdraw) ?? num(c.free);
      if (available === null) {
        const used = (num(c.locked) ?? 0) + (num(c.totalOrderIM) ?? 0) + (num(c.totalPositionIM) ?? 0);
        available = Math.max(0, total - used);
      }
      balances.push({ asset: c.coin, total, available, value: num(c.usdValue) });
    }
    balances.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const extra: Record<string, unknown> = {};
    const im = num(w.accountIMRate);
    const mm = num(w.accountMMRate);
    if (im !== null) extra.initialMarginRate = im;
    if (mm !== null) extra.maintenanceMarginRate = mm;
    const tmm = num(w.totalMaintenanceMargin);
    if (tmm !== null) extra.maintenanceMargin = tmm;
    return {
      externalId: (this.ctx.meta.uid as string | undefined) ?? null,
      accountType: "UNIFIED",
      currency: "USD",
      equity: num(w.totalEquity) ?? 0,
      balance: num(w.totalWalletBalance),
      available: num(w.totalAvailableBalance),
      unrealizedPnl: num(w.totalPerpUPL),
      marginUsed: num(w.totalInitialMargin),
      balances,
      extra,
    };
  }

  private async classicAccount(): Promise<AccountSummary> {
    const balances: Balance[] = [];
    let equity = 0;
    let anyOk = false;
    let lastErr: unknown = null;
    for (const accountType of ["CONTRACT", "SPOT"]) {
      try {
        const r = await this.http.privateGet<{ list: RawWallet[] }>("/v5/account/wallet-balance", { accountType });
        anyOk = true;
        for (const c of r.result.list?.[0]?.coin ?? []) {
          const total = num(c.walletBalance) ?? num(c.equity) ?? 0;
          if (total === 0) continue;
          const value = num(c.usdValue);
          if (value !== null) equity += value;
          balances.push({
            asset: accountType === "SPOT" ? c.coin : `${c.coin} (contract)`,
            total,
            available: num(c.free) ?? num(c.availableToWithdraw),
            value,
          });
        }
      } catch (err) {
        lastErr = err;
      }
    }
    if (!anyOk) throw lastErr ?? new PlatformError("platform_error", "Could not read the Bybit wallet balance.");
    return {
      externalId: (this.ctx.meta.uid as string | undefined) ?? null,
      accountType: "CLASSIC",
      currency: "USD",
      equity,
      balance: null,
      available: null,
      unrealizedPnl: null,
      marginUsed: null,
      balances,
      extra: { note: "Classic account: totals are the sum of reported USD values; upgrade to a Unified Trading Account for exact figures." },
    };
  }

  // -------------------------------------------------------------------------
  // Instruments
  // -------------------------------------------------------------------------

  private async loadInstruments(category: Category): Promise<RawInstrument[]> {
    const key = `${this.http.publicHost}|${category}`;
    const cached = instrumentCache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.list;
    const inflight = instrumentInflight.get(key);
    if (inflight) return inflight;
    const p = (async () => {
      let list: RawInstrument[];
      if (category === "option") {
        const results = await Promise.allSettled(
          OPTION_BASE_COINS.map((baseCoin) => this.publicPaged<RawInstrument>("/v5/market/instruments-info", { category, baseCoin, limit: 1000 })),
        );
        const ok = results.filter((r): r is PromiseFulfilledResult<RawInstrument[]> => r.status === "fulfilled");
        if (!ok.length) throw (results[0] as PromiseRejectedResult).reason;
        list = ok.flatMap((r) => r.value);
      } else {
        list = await this.publicPaged<RawInstrument>("/v5/market/instruments-info", { category, limit: 1000 });
      }
      instrumentCache.set(key, { at: Date.now(), list });
      return list;
    })();
    instrumentInflight.set(key, p);
    try {
      return await p;
    } finally {
      instrumentInflight.delete(key);
    }
  }

  private peekInstruments(category: Category): RawInstrument[] | null {
    const cached = instrumentCache.get(`${this.http.publicHost}|${category}`);
    return cached && Date.now() - cached.at < CACHE_TTL_MS ? cached.list : null;
  }

  private async publicPaged<T>(path: string, params: Params, maxPages = 20): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const r = await this.http.publicGet<RawList<T>>(path, { ...params, cursor });
      out.push(...(r.result.list ?? []));
      cursor = r.result.nextPageCursor || undefined;
      if (!cursor) break;
    }
    return out;
  }

  private async loadTurnover(category: Category): Promise<Map<string, number>> {
    if (category === "option") return new Map();
    const key = `${this.http.publicHost}|${category}`;
    const cached = turnoverCache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.map;
    try {
      const r = await this.http.publicGet<RawList<RawTicker>>("/v5/market/tickers", { category });
      const map = new Map<string, number>();
      for (const t of r.result.list ?? []) {
        // Inverse turnover is in coins; volume (USD contracts) is comparable across symbols there.
        const v = category === "inverse" ? num(t.volume24h) : num(t.turnover24h);
        if (v !== null) map.set(t.symbol, v);
      }
      turnoverCache.set(key, { at: Date.now(), map });
      return map;
    } catch {
      return new Map();
    }
  }

  private async rawInstrument(category: Category, symbol: string): Promise<RawInstrument> {
    let list = this.peekInstruments(category);
    if (!list && category !== "option") list = await this.loadInstruments(category);
    let raw = list?.find((i) => i.symbol === symbol);
    if (!raw) {
      try {
        const r = await this.http.publicGet<RawList<RawInstrument>>("/v5/market/instruments-info", { category, symbol });
        raw = r.result.list?.find((i) => i.symbol === symbol);
      } catch (err) {
        if (!(err instanceof PlatformError) || err.code !== "invalid_request") throw err;
      }
    }
    if (!raw) {
      throw new PlatformError(
        "not_found",
        `Bybit has no ${category} instrument "${symbol}"${this.ctx.environment === "live" ? ` on ${this.http.publicHost}` : ""}. Use search_instruments to find valid ids.`,
      );
    }
    return raw;
  }

  async getInstrument(id: string): Promise<Instrument> {
    const { category, symbol } = parseInstrumentId(id);
    return mapInstrument(category, await this.rawInstrument(category, symbol));
  }

  async searchInstruments(p: { query?: string; type?: InstrumentType; limit: number }): Promise<InstrumentSummary[]> {
    const q = (p.query ?? "").trim().toUpperCase();
    const qn = q.replace(/[\s/_]/g, "");
    let categories: Category[];
    switch (p.type) {
      case undefined:
        categories = qn.includes("-") ? ["linear", "spot", "inverse", "option"] : ["linear", "spot", "inverse"];
        break;
      case "spot":
        categories = ["spot"];
        break;
      case "perpetual":
      case "future":
        categories = ["linear", "inverse"];
        break;
      case "option":
        categories = ["option"];
        break;
      default:
        return [];
    }
    const catOrder: Record<Category, number> = { linear: 0, spot: 1, inverse: 2, option: 3 };
    const scored: { inst: Instrument; score: number; turnover: number; cat: number }[] = [];
    const lists = await Promise.all(
      categories.map(async (category) => {
        const [list, turnover] = await Promise.all([this.loadInstruments(category), this.loadTurnover(category)]);
        return { category, list, turnover };
      }),
    );
    for (const { category, list, turnover } of lists) {
      for (const raw of list) {
        let score = 0;
        if (qn) {
          const sym = raw.symbol.toUpperCase();
          const base = (raw.baseCoin ?? "").toUpperCase();
          if (sym === qn) score = 0;
          else if (base === qn) score = 1;
          else if (sym.startsWith(qn)) score = 2;
          else if (base.startsWith(qn)) score = 3;
          else if (sym.includes(qn) || (raw.fullName ?? "").toUpperCase().includes(q)) score = 4;
          else continue;
        }
        const inst = mapInstrument(category, raw);
        if (p.type && inst.type !== p.type) continue;
        scored.push({ inst, score, turnover: turnover.get(raw.symbol) ?? 0, cat: catOrder[category] });
      }
    }
    scored.sort(
      (a, b) =>
        a.score - b.score ||
        // Options: nearest expiry first; others: most traded first.
        (a.inst.type === "option" && b.inst.type === "option" ? (a.inst.expiry ?? 0) - (b.inst.expiry ?? 0) : 0) ||
        b.turnover - a.turnover ||
        a.cat - b.cat ||
        a.inst.symbol.localeCompare(b.inst.symbol),
    );
    return scored.slice(0, Math.max(1, p.limit)).map((s) => pick(s.inst));
  }

  // -------------------------------------------------------------------------
  // Market data
  // -------------------------------------------------------------------------

  async getQuotes(ids: string[]): Promise<Quote[]> {
    const groups = new Map<Category, Set<string>>();
    for (const id of ids) {
      const { category, symbol } = parseInstrumentId(id);
      if (!groups.has(category)) groups.set(category, new Set());
      groups.get(category)!.add(symbol);
    }
    const out: Quote[] = [];
    await Promise.all(
      [...groups.entries()].map(async ([category, symbols]) => {
        const tickers: { t: RawTicker; time: number }[] = [];
        const add = (list: RawTicker[], time: number) => {
          for (const t of list) if (symbols.has(t.symbol)) tickers.push({ t, time });
        };
        if (symbols.size <= 3) {
          await Promise.all(
            [...symbols].map(async (symbol) => {
              try {
                const r = await this.http.publicGet<RawList<RawTicker>>("/v5/market/tickers", { category, symbol });
                add(r.result.list ?? [], r.time);
              } catch (err) {
                if (!(err instanceof PlatformError) || err.code !== "invalid_request") throw err;
              }
            }),
          );
        } else if (category === "option") {
          const bases = new Set([...symbols].map((s) => parseOptionSymbol(s)?.base ?? s.split("-")[0]!));
          await Promise.all(
            [...bases].map(async (baseCoin) => {
              const r = await this.http.publicGet<RawList<RawTicker>>("/v5/market/tickers", { category, baseCoin });
              add(r.result.list ?? [], r.time);
            }),
          );
        } else {
          const r = await this.http.publicGet<RawList<RawTicker>>("/v5/market/tickers", { category });
          add(r.result.list ?? [], r.time);
        }
        let instruments = this.peekInstruments(category);
        if (!instruments && category !== "option") instruments = await this.loadInstruments(category).catch(() => null);
        for (const { t, time } of tickers) {
          const raw = instruments?.find((i) => i.symbol === t.symbol);
          const status = raw ? mapInstrument(category, raw).status : "unknown";
          out.push(mapTicker(category, t, time, status));
        }
      }),
    );
    if (!out.length && ids.length) {
      throw new PlatformError("not_found", `No Bybit quotes found for ${ids.join(", ")}. Check the ids with search_instruments.`);
    }
    // Keep the caller's order.
    const order = new Map(ids.map((id, i) => [parseInstrumentIdSafe(id), i]));
    out.sort((a, b) => (order.get(a.instrumentId) ?? 0) - (order.get(b.instrumentId) ?? 0));
    return out;
  }

  async getOrderBook(id: string, depth: number): Promise<OrderBook> {
    const { category, symbol } = parseInstrumentId(id);
    const limit = Math.max(1, Math.min(ORDERBOOK_MAX[category], Math.floor(depth) || 25));
    const r = await this.http.publicGet<{ s: string; a: [string, string][]; b: [string, string][]; ts?: number }>(
      "/v5/market/orderbook",
      { category, symbol, limit },
    );
    const lvl = (rows: [string, string][]): [number, number][] =>
      (rows ?? []).map(([p, s]) => [Number(p), Number(s)] as [number, number]);
    return { instrumentId: instrumentId(category, symbol), time: r.result.ts ?? r.time, bids: lvl(r.result.b), asks: lvl(r.result.a) };
  }

  async fetchCandles(p: { instrumentId: string; resolution: Resolution; from: number; to: number }): Promise<{
    candles: Candle[];
    quota: DataQuota | null;
  }> {
    const { category, symbol } = parseInstrumentId(p.instrumentId);
    if (category === "option") {
      throw new PlatformError("unsupported", "Bybit provides no candles for options. Use get_quotes for current option prices, IV and greeks.");
    }
    const interval = KLINE_INTERVALS[p.resolution];
    if (!interval) {
      throw new PlatformError(
        "invalid_request",
        `Bybit does not support the ${p.resolution} resolution. Supported: ${Object.keys(KLINE_INTERVALS).join(", ")}.`,
      );
    }
    const byTime = new Map<number, Candle>();
    let end = p.to - 1;
    for (let i = 0; i < 2000 && end >= p.from; i++) {
      const r = await this.http.publicGet<{ list: string[][] }>("/v5/market/kline", {
        category,
        symbol,
        interval,
        start: p.from,
        end,
        limit: 1000,
      });
      const rows = r.result.list ?? [];
      let oldest = Infinity;
      for (const row of rows) {
        const t = Number(row[0]);
        if (!Number.isFinite(t)) continue;
        oldest = Math.min(oldest, t);
        if (t < p.from || t >= p.to) continue;
        byTime.set(t, {
          t,
          o: Number(row[1]),
          h: Number(row[2]),
          l: Number(row[3]),
          c: Number(row[4]),
          v: num(row[5]),
          spread: null,
        });
      }
      if (rows.length < 1000 || !Number.isFinite(oldest) || oldest <= p.from) break;
      end = oldest - 1;
    }
    const candles = [...byTime.values()].sort((a, b) => a.t - b.t);
    return { candles, quota: this.rateLimitQuota() };
  }

  private rateLimitQuota(): DataQuota {
    return { kind: "rate_limit", remaining: null, total: null, resetsAt: null, note: RATE_LIMIT_QUOTA_NOTE, updatedAt: Date.now() };
  }

  async getQuota(): Promise<DataQuota | null> {
    return this.rateLimitQuota();
  }

  // -------------------------------------------------------------------------
  // Private reads
  // -------------------------------------------------------------------------

  private async privatePaged<T>(path: string, params: Params, maxItems = Infinity, maxPages = 20): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const r = await this.http.privateGet<RawList<T>>(path, { ...params, cursor });
      out.push(...(r.result.list ?? []));
      cursor = r.result.nextPageCursor || undefined;
      if (!cursor || out.length >= maxItems) break;
    }
    return out;
  }

  /**
   * Run several per-category queries. Failures that only mean "not available for this account"
   * (permission, category not enabled) are skipped, unless every query failed.
   */
  private async tolerant<T>(specs: Spec[], run: (s: Spec) => Promise<T[]>): Promise<T[]> {
    const results = await Promise.allSettled(specs.map(run));
    const out: T[] = [];
    let firstErr: unknown = null;
    let okCount = 0;
    for (const r of results) {
      if (r.status === "fulfilled") {
        okCount++;
        out.push(...r.value);
      } else {
        const e = r.reason;
        if (!(e instanceof PlatformError) || !TOLERATED.has(e.code)) throw e;
        firstErr ??= e;
      }
    }
    if (!okCount && firstErr) throw firstErr;
    return out;
  }

  private derivSpecs(withOptionSettle = false): Spec[] {
    return [
      ...LINEAR_SETTLE_COINS.map((settleCoin) => ({ category: "linear" as Category, params: { settleCoin } })),
      { category: "inverse", params: {} },
      ...(withOptionSettle
        ? LINEAR_SETTLE_COINS.map((settleCoin) => ({ category: "option" as Category, params: { settleCoin } }))
        : [{ category: "option" as Category, params: {} }]),
    ];
  }

  async getPositions(p: { instrumentId?: string }): Promise<Position[]> {
    let specs: Spec[];
    if (p.instrumentId) {
      const { category, symbol } = parseInstrumentId(p.instrumentId);
      if (category === "spot") return [];
      specs = [{ category, params: { symbol } }];
    } else {
      specs = this.derivSpecs();
    }
    const rows = await this.tolerant(specs, async (s) => {
      const list = await this.privatePaged<RawPosition>("/v5/position/list", { category: s.category, ...s.params, limit: 200 });
      return list.map((raw) => ({ s, raw }));
    });
    const seen = new Set<string>();
    const out: Position[] = [];
    for (const { s, raw } of rows) {
      if (!((num(raw.size) ?? 0) > 0)) continue;
      const pos = mapPosition(s.category, raw);
      if (seen.has(pos.id)) continue;
      seen.add(pos.id);
      out.push(pos);
    }
    return out;
  }

  async getOpenOrders(p: { instrumentId?: string }): Promise<Order[]> {
    let specs: Spec[];
    if (p.instrumentId) {
      const { category, symbol } = parseInstrumentId(p.instrumentId);
      specs = [{ category, params: { symbol } }];
    } else {
      specs = [{ category: "spot", params: {} }, ...this.derivSpecs()];
    }
    const orders = await this.tolerant(specs, async (s) => {
      const list = await this.privatePaged<RawOrder>("/v5/order/realtime", { category: s.category, ...s.params, limit: 50 });
      return list.map((o) => mapOrder(s.category, o));
    });
    const byId = new Map(orders.map((o) => [o.id, o]));
    return [...byId.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  /**
   * Bybit history endpoints accept at most 7-day windows. Walk windows backwards from `to`,
   * querying every spec per window, until `limit` items are collected or `from` is passed.
   */
  private async windowed<T>(
    path: string,
    specs: Spec[],
    range: TimeRange,
    pageLimit: number,
    map: (category: Category, raw: unknown) => T,
    idOf: (t: T) => string,
    timeOf: (t: T) => number,
  ): Promise<T[]> {
    const limit = Math.max(1, range.limit);
    const to = range.to ?? Date.now();
    const from = Math.max(range.from ?? to - 30 * DAY_MS, to - MAX_LOOKBACK_MS);
    const found = new Map<string, T>();
    let active = specs;
    let firstWindow = true;
    for (let wEnd = to; wEnd > from && active.length; ) {
      const wStart = Math.max(from, wEnd - WINDOW_MS);
      const failed = new Set<Spec>();
      let firstErr: unknown = null;
      await Promise.all(
        active.map(async (s) => {
          try {
            const rows = await this.privatePaged<unknown>(
              path,
              { category: s.category, ...s.params, startTime: wStart, endTime: wEnd, limit: pageLimit },
              limit,
            );
            for (const raw of rows) {
              const item = map(s.category, raw);
              found.set(idOf(item), item);
            }
          } catch (err) {
            if (!(err instanceof PlatformError) || !TOLERATED.has(err.code)) throw err;
            failed.add(s);
            firstErr ??= err;
          }
        }),
      );
      if (firstWindow && failed.size === active.length && firstErr) throw firstErr;
      firstWindow = false;
      active = active.filter((s) => !failed.has(s));
      if (found.size >= limit) break;
      wEnd = wStart - 1;
    }
    return [...found.values()]
      .filter((x) => timeOf(x) >= from && timeOf(x) <= to)
      .sort((a, b) => timeOf(b) - timeOf(a))
      .slice(0, limit);
  }

  private historySpecs(instrumentIdArg: string | undefined, kind: "orders" | "fills"): Spec[] {
    if (instrumentIdArg) {
      const { category, symbol } = parseInstrumentId(instrumentIdArg);
      return [{ category, params: { symbol } }];
    }
    return [{ category: "spot", params: {} }, ...this.derivSpecs(kind === "fills")];
  }

  async getOrderHistory(p: TimeRange): Promise<Order[]> {
    return this.windowed(
      "/v5/order/history",
      this.historySpecs(p.instrumentId, "orders"),
      p,
      50,
      (c, raw) => mapOrder(c, raw as RawOrder),
      (o) => o.id,
      (o) => o.createdAt ?? o.updatedAt ?? 0,
    );
  }

  async getFills(p: TimeRange): Promise<Fill[]> {
    return this.windowed(
      "/v5/execution/list",
      this.historySpecs(p.instrumentId, "fills"),
      p,
      100,
      (c, raw) => mapFill(c, raw as RawExecution),
      (f) => `${f.instrumentId}:${f.id}`,
      (f) => f.time,
    );
  }

  async getClosedPnl(p: TimeRange): Promise<ClosedPnl[]> {
    let specs: Spec[];
    if (p.instrumentId) {
      const { category, symbol } = parseInstrumentId(p.instrumentId);
      if (category !== "linear" && category !== "inverse") return [];
      specs = [{ category, params: { symbol } }];
    } else {
      specs = [
        { category: "linear", params: {} },
        { category: "inverse", params: {} },
      ];
    }
    return this.windowed(
      "/v5/position/closed-pnl",
      specs,
      p,
      100,
      (c, raw) => mapClosedPnl(c, raw as RawClosedPnl),
      (x) => `${x.instrumentId}:${x.id}`,
      (x) => x.closedAt,
    );
  }

  // -------------------------------------------------------------------------
  // Trading
  // -------------------------------------------------------------------------

  private async lastPrice(category: Category, symbol: string): Promise<number> {
    const r = await this.http.publicGet<RawList<RawTicker>>("/v5/market/tickers", { category, symbol });
    const t = r.result.list?.[0];
    const last = num(t?.lastPrice) || num(t?.markPrice);
    if (!last) throw new PlatformError("platform_error", `Could not read the current price of ${symbol} to set the stop trigger direction.`);
    return last;
  }

  private formatSize(inst: Instrument, size: number): string {
    if (!(size > 0)) throw new PlatformError("invalid_request", "size must be greater than 0.");
    const s = formatToStep(size, inst.sizeStep);
    if (!(Number(s) > 0)) {
      throw new PlatformError(
        "invalid_request",
        `size ${size} rounds to 0 with the step ${inst.sizeStep} of ${inst.symbol} (minimum ${inst.minSize} ${inst.sizeUnit}).`,
      );
    }
    return s;
  }

  private fmtPrice(inst: Instrument, price: number | undefined | null, field: string): string | undefined {
    if (price === undefined || price === null) return undefined;
    if (!(price > 0)) throw new PlatformError("invalid_request", `${field} must be a positive price.`);
    return formatToStep(price, inst.priceTick);
  }

  /** Look up one order (open or recently closed) for an accurate OrderResult. */
  private async fetchOrder(category: Category, symbol: string, orderId: string): Promise<Order | null> {
    try {
      const r = await this.http.privateGet<RawList<RawOrder>>("/v5/order/realtime", { category, symbol, orderId });
      const o = r.result.list?.[0];
      if (o) return mapOrder(category, o);
      const h = await this.http.privateGet<RawList<RawOrder>>("/v5/order/history", { category, orderId });
      const ho = h.result.list?.[0];
      return ho ? mapOrder(category, ho) : null;
    } catch {
      return null;
    }
  }

  private async resultFor(category: Category, symbol: string, orderId: string, posIdx: number | null, message: string | null): Promise<OrderResult> {
    await sleep(300);
    const o = await this.fetchOrder(category, symbol, orderId);
    const pid = category === "spot" || posIdx === null ? null : positionId(category, symbol, posIdx);
    if (!o) {
      return {
        orderId,
        status: "open",
        message: [message, "Order accepted by Bybit; its final status is not known yet (check get_open_orders)."].filter(Boolean).join(" "),
        filledSize: null,
        avgFillPrice: null,
        positionId: pid,
      };
    }
    return {
      orderId,
      status: o.status,
      message: [message, o.rejectReason ? `Bybit: ${o.rejectReason}` : null].filter(Boolean).join(" ") || null,
      filledSize: o.filledSize,
      avgFillPrice: o.avgFillPrice,
      positionId: pid,
      extra: o.clientOrderId ? { clientOrderId: o.clientOrderId } : undefined,
    };
  }

  async placeOrder(req: PlaceOrderRequest): Promise<OrderResult> {
    const { category, symbol } = parseInstrumentId(req.instrumentId);
    if (req.guaranteedStop) {
      throw new PlatformError("unsupported", "Bybit has no guaranteed stops. Omit guaranteedStop.");
    }
    if (req.trailingStopDistance !== undefined && req.trailingStopDistance !== null) {
      throw new PlatformError(
        "unsupported",
        "Bybit cannot attach a trailing stop to a new order. Place the order without trailingStopDistance, then set it on the open position with set_position_protection.",
      );
    }
    const isStop = req.type === "stop" || req.type === "stop_limit";
    const isLimit = req.type === "limit" || req.type === "stop_limit";
    if (isLimit && req.price === undefined) throw new PlatformError("invalid_request", `A ${req.type} order needs a price.`);
    if (isStop && req.triggerPrice === undefined) throw new PlatformError("invalid_request", `A ${req.type} order needs a triggerPrice.`);
    if (isStop && category === "option") {
      throw new PlatformError("unsupported", "Bybit options do not support stop orders. Use a market or limit order.");
    }
    if (req.timeInForce === "post_only" && !isLimit) {
      throw new PlatformError("invalid_request", "post_only requires a limit or stop_limit order.");
    }
    if (req.positionSide && (category === "spot" || category === "option")) {
      throw new PlatformError("invalid_request", "positionSide only applies to linear and inverse contracts in hedge mode.");
    }

    const inst = await this.getInstrument(req.instrumentId);
    const body: Record<string, unknown> = {
      category,
      symbol,
      side: req.side === "buy" ? "Buy" : "Sell",
      orderType: isLimit ? "Limit" : "Market",
      qty: this.formatSize(inst, req.size),
      price: isLimit ? this.fmtPrice(inst, req.price, "price") : undefined,
      timeInForce: toBybitTif(req.timeInForce),
      takeProfit: this.fmtPrice(inst, req.takeProfit, "takeProfit"),
      stopLoss: this.fmtPrice(inst, req.stopLoss, "stopLoss"),
      orderLinkId: req.clientOrderId ?? (category === "option" ? newOrderLinkId() : undefined),
    };
    const notes: string[] = [];
    let posIdx: number | null = null;

    if (category === "spot") {
      if (!isLimit) body.marketUnit = "baseCoin";
      if (isStop) {
        body.orderFilter = "StopOrder";
        body.triggerPrice = this.fmtPrice(inst, req.triggerPrice, "triggerPrice");
      }
      if (req.reduceOnly) notes.push("reduceOnly is ignored for spot orders.");
    } else {
      if (req.reduceOnly) body.reduceOnly = true;
      if (category === "linear" || category === "inverse") {
        posIdx = req.positionSide === "long" ? 1 : req.positionSide === "short" ? 2 : 0;
        body.positionIdx = posIdx;
        if (req.takeProfit !== undefined || req.stopLoss !== undefined) body.tpslMode = "Full";
        if (isStop) {
          const trigger = req.triggerPrice!;
          const last = await this.lastPrice(category, symbol);
          body.triggerPrice = this.fmtPrice(inst, trigger, "triggerPrice");
          body.triggerDirection = trigger > last ? 1 : 2;
          body.triggerBy = "LastPrice";
        }
      }
    }
    if (req.reduceOnly && (req.takeProfit !== undefined || req.stopLoss !== undefined) && category !== "spot") {
      throw new PlatformError("invalid_request", "Bybit does not allow stopLoss/takeProfit on reduceOnly orders. Remove them or drop reduceOnly.");
    }

    const r = await this.http.privatePost<{ orderId: string; orderLinkId?: string }>("/v5/order/create", body);
    return this.resultFor(category, symbol, r.result.orderId, posIdx, notes.join(" ") || null);
  }

  /** Find an open order by id (or client id) across all categories. */
  private async findOpenOrder(orderId: string): Promise<Order> {
    const open = await this.getOpenOrders({});
    const o = open.find((x) => x.id === orderId || x.clientOrderId === orderId);
    if (!o) {
      throw new PlatformError(
        "not_found",
        `No open Bybit order with id "${orderId}". It may already be filled or cancelled (see get_order_history), or pass instrumentId.`,
      );
    }
    return o;
  }

  async amendOrder(req: AmendOrderRequest): Promise<OrderResult> {
    let instId = req.instrumentId;
    let orderId = req.orderId;
    if (!instId) {
      const o = await this.findOpenOrder(req.orderId);
      instId = o.instrumentId;
      orderId = o.id;
    }
    const { category, symbol } = parseInstrumentId(instId);
    const inst = await this.getInstrument(instId);
    const tpsl = (v: number | null | undefined, f: string) => (v === null ? "0" : this.fmtPrice(inst, v, f));
    const body: Record<string, unknown> = {
      category,
      symbol,
      orderId,
      qty: req.size !== undefined ? this.formatSize(inst, req.size) : undefined,
      price: this.fmtPrice(inst, req.price, "price"),
      triggerPrice: this.fmtPrice(inst, req.triggerPrice, "triggerPrice"),
      takeProfit: tpsl(req.takeProfit, "takeProfit"),
      stopLoss: tpsl(req.stopLoss, "stopLoss"),
    };
    if (Object.keys(body).filter((k) => body[k] !== undefined).length <= 3) {
      throw new PlatformError("invalid_request", "Nothing to amend: pass size, price, triggerPrice, stopLoss or takeProfit.");
    }
    if ((category === "linear" || category === "inverse") && (body.takeProfit !== undefined || body.stopLoss !== undefined)) {
      body.tpslMode = "Full";
    }
    const r = await this.http.privatePost<{ orderId: string }>("/v5/order/amend", body);
    return this.resultFor(category, symbol, r.result.orderId || orderId, null, null);
  }

  async cancelOrder(req: { orderId: string; instrumentId?: string }): Promise<OrderResult> {
    let instId = req.instrumentId;
    let orderId = req.orderId;
    if (!instId) {
      const o = await this.findOpenOrder(req.orderId);
      instId = o.instrumentId;
      orderId = o.id;
    }
    const { category, symbol } = parseInstrumentId(instId);
    // Spot conditional / TP-SL orders must be cancelled with the matching orderFilter.
    const filters: (string | undefined)[] = category === "spot" ? [undefined, "StopOrder", "tpslOrder"] : [undefined];
    let lastErr: unknown = null;
    for (const orderFilter of filters) {
      try {
        const r = await this.http.privatePost<{ orderId: string }>("/v5/order/cancel", { category, symbol, orderId, orderFilter });
        return {
          orderId: r.result.orderId || orderId,
          status: "cancelled",
          message: null,
          filledSize: null,
          avgFillPrice: null,
          positionId: null,
        };
      } catch (err) {
        lastErr = err;
        if (!(err instanceof PlatformError) || err.code !== "not_found") throw err;
      }
    }
    throw lastErr;
  }

  async cancelAllOrders(p: { instrumentId?: string }): Promise<{ cancelled: string[] }> {
    const calls: Record<string, unknown>[] = [];
    const spotFilters = ["Order", "StopOrder", "tpslOrder"];
    if (p.instrumentId) {
      const { category, symbol } = parseInstrumentId(p.instrumentId);
      if (category === "spot") for (const orderFilter of spotFilters) calls.push({ category, symbol, orderFilter });
      else calls.push({ category, symbol });
    } else {
      const open = await this.getOpenOrders({});
      const byCat = new Map<Category, Order[]>();
      for (const o of open) {
        const c = parseInstrumentId(o.instrumentId).category;
        if (!byCat.has(c)) byCat.set(c, []);
        byCat.get(c)!.push(o);
      }
      for (const [category, orders] of byCat) {
        if (category === "spot") {
          for (const orderFilter of spotFilters) calls.push({ category, orderFilter });
        } else if (category === "option") {
          calls.push({ category });
        } else if (category === "linear") {
          const settles = new Set(orders.map((o) => settleCoinOf("linear", o.symbol) ?? "USDT"));
          for (const settleCoin of settles) calls.push({ category, settleCoin });
        } else {
          for (const symbol of new Set(orders.map((o) => o.symbol))) calls.push({ category, symbol });
        }
      }
    }
    const cancelled = new Set<string>();
    for (const body of calls) {
      const r = await this.http.privatePost<{ list?: { orderId: string }[] }>("/v5/order/cancel-all", body);
      for (const o of r.result.list ?? []) if (o.orderId) cancelled.add(o.orderId);
    }
    return { cancelled: [...cancelled] };
  }

  private async rawPosition(category: Category, symbol: string, positionIdx: number): Promise<RawPosition | null> {
    const list = await this.privatePaged<RawPosition>("/v5/position/list", { category, symbol, limit: 200 });
    return list.find((p) => p.positionIdx === positionIdx && (num(p.size) ?? 0) > 0) ?? null;
  }

  async closePosition(req: ClosePositionRequest): Promise<OrderResult> {
    const { category, symbol, positionIdx } = parsePositionId(req.positionId);
    const pos = await this.rawPosition(category, symbol, positionIdx);
    if (!pos) throw new PlatformError("not_found", `No open Bybit position ${req.positionId}. Use get_positions for current position ids.`);
    const full = num(pos.size) ?? 0;
    const size = req.size !== undefined ? Math.min(req.size, full) : full;
    const type = req.type ?? "market";
    if (type === "limit" && req.price === undefined) throw new PlatformError("invalid_request", "A limit close needs a price.");
    const inst = await this.getInstrument(instrumentId(category, symbol));
    const body: Record<string, unknown> = {
      category,
      symbol,
      side: pos.side === "Buy" ? "Sell" : "Buy",
      orderType: type === "limit" ? "Limit" : "Market",
      qty: this.formatSize(inst, size),
      price: type === "limit" ? this.fmtPrice(inst, req.price, "price") : undefined,
      reduceOnly: true,
      positionIdx: category === "option" ? undefined : positionIdx,
      orderLinkId: category === "option" ? newOrderLinkId() : undefined,
    };
    const r = await this.http.privatePost<{ orderId: string }>("/v5/order/create", body);
    return this.resultFor(category, symbol, r.result.orderId, positionIdx, null);
  }

  async setPositionProtection(req: PositionProtectionRequest): Promise<Position | null> {
    const { category, symbol, positionIdx } = parsePositionId(req.positionId);
    if (category !== "linear" && category !== "inverse") {
      throw new PlatformError("unsupported", "Bybit supports position stop loss / take profit / trailing stop only for linear and inverse contracts.");
    }
    if (req.stopLoss === undefined && req.takeProfit === undefined && req.trailingStopDistance === undefined) {
      throw new PlatformError("invalid_request", "Pass stopLoss, takeProfit and/or trailingStopDistance (null removes one).");
    }
    const inst = await this.getInstrument(instrumentId(category, symbol));
    const v = (x: number | null | undefined, f: string) => (x === null ? "0" : this.fmtPrice(inst, x, f));
    await this.http.privatePostAllow("/v5/position/trading-stop", {
      category,
      symbol,
      tpslMode: "Full",
      positionIdx,
      stopLoss: v(req.stopLoss, "stopLoss"),
      takeProfit: v(req.takeProfit, "takeProfit"),
      trailingStop: v(req.trailingStopDistance, "trailingStopDistance"),
    }, [34040]);
    const pos = await this.rawPosition(category, symbol, positionIdx);
    return pos ? mapPosition(category, pos) : null;
  }

  async setLeverage(p: { instrumentId: string; leverage: number }): Promise<{ leverage: number }> {
    const { category, symbol } = parseInstrumentId(p.instrumentId);
    if (category !== "linear" && category !== "inverse") {
      throw new PlatformError("unsupported", "Leverage can only be set for linear and inverse contracts on Bybit.");
    }
    if (!(p.leverage > 0)) throw new PlatformError("invalid_request", "leverage must be greater than 0.");
    const lev = formatToStep(p.leverage, 0.01);
    await this.http.privatePostAllow("/v5/position/set-leverage", { category, symbol, buyLeverage: lev, sellLeverage: lev }, [110043]);
    return { leverage: Number(lev) };
  }
}

function parseInstrumentIdSafe(id: string): string {
  try {
    const { category, symbol } = parseInstrumentId(id);
    return instrumentId(category, symbol);
  } catch {
    return id;
  }
}

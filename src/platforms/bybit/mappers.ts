import { PlatformError } from "../errors.js";
import { num } from "../http.js";
import type {
  AssetClass,
  ClosedPnl,
  Fill,
  Instrument,
  InstrumentType,
  MarketStatus,
  Order,
  OrderStatus,
  OrderType,
  Position,
  Quote,
  Resolution,
  TimeInForce,
} from "../types.js";

export type Category = "spot" | "linear" | "inverse" | "option";
export const CATEGORIES: Category[] = ["spot", "linear", "inverse", "option"];
export const DERIVATIVES: Category[] = ["linear", "inverse", "option"];

/** Option base coins probed on Bybit (instruments-info for options requires a baseCoin). */
export const OPTION_BASE_COINS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "MNT", "HYPE", "XAUT", "BNB"];
/** Settle coins of linear contracts (position/order lists need one when no symbol is given). */
export const LINEAR_SETTLE_COINS = ["USDT", "USDC"];

// ---------------------------------------------------------------------------
// Raw Bybit shapes (only the fields we use; everything arrives as strings)
// ---------------------------------------------------------------------------

export interface RawInstrument {
  symbol: string;
  contractType?: string;
  status?: string;
  baseCoin?: string;
  quoteCoin?: string;
  settleCoin?: string;
  launchTime?: string;
  deliveryTime?: string;
  optionsType?: string;
  symbolType?: string;
  fullName?: string;
  displayName?: string;
  fundingInterval?: number;
  leverageFilter?: { minLeverage?: string; maxLeverage?: string; leverageStep?: string };
  priceFilter?: { minPrice?: string; maxPrice?: string; tickSize?: string };
  lotSizeFilter?: {
    maxOrderQty?: string;
    minOrderQty?: string;
    qtyStep?: string;
    maxMktOrderQty?: string;
    minNotionalValue?: string;
    basePrecision?: string;
    quotePrecision?: string;
    minOrderAmt?: string;
    maxOrderAmt?: string;
    maxLimitOrderQty?: string;
    maxMarketOrderQty?: string;
  };
  marginTrading?: string;
}

export interface RawTicker {
  symbol: string;
  bid1Price?: string;
  ask1Price?: string;
  lastPrice?: string;
  markPrice?: string;
  indexPrice?: string;
  usdIndexPrice?: string;
  highPrice24h?: string;
  lowPrice24h?: string;
  price24hPcnt?: string;
  change24h?: string;
  volume24h?: string;
  turnover24h?: string;
  openInterest?: string;
  fundingRate?: string;
  nextFundingTime?: string;
  markIv?: string;
  delta?: string;
  gamma?: string;
  vega?: string;
  theta?: string;
  underlyingPrice?: string;
}

export interface RawPosition {
  positionIdx: number;
  symbol: string;
  side: string;
  size: string;
  avgPrice?: string;
  markPrice?: string;
  positionValue?: string;
  leverage?: string;
  liqPrice?: string;
  positionIM?: string;
  positionMM?: string;
  takeProfit?: string;
  stopLoss?: string;
  trailingStop?: string;
  unrealisedPnl?: string;
  curRealisedPnl?: string;
  cumRealisedPnl?: string;
  createdTime?: string;
  updatedTime?: string;
  positionStatus?: string;
  delta?: string;
  gamma?: string;
  vega?: string;
  theta?: string;
}

export interface RawOrder {
  orderId: string;
  orderLinkId?: string;
  symbol: string;
  price?: string;
  qty?: string;
  side: string;
  positionIdx?: number;
  orderStatus: string;
  cancelType?: string;
  rejectReason?: string;
  avgPrice?: string;
  leavesQty?: string;
  cumExecQty?: string;
  cumExecValue?: string;
  cumExecFee?: string;
  timeInForce?: string;
  orderType?: string;
  stopOrderType?: string;
  orderIv?: string;
  marketUnit?: string;
  triggerPrice?: string;
  takeProfit?: string;
  stopLoss?: string;
  triggerDirection?: number;
  reduceOnly?: boolean;
  closeOnTrigger?: boolean;
  createdTime?: string;
  updatedTime?: string;
}

export interface RawExecution {
  symbol: string;
  orderId?: string;
  orderLinkId?: string;
  side: string;
  execFee?: string;
  execId: string;
  execPrice: string;
  execQty: string;
  execType?: string;
  execValue?: string;
  execTime: string;
  feeCurrency?: string;
  isMaker?: boolean;
  closedSize?: string;
  execPnl?: string;
}

export interface RawClosedPnl {
  symbol: string;
  orderId?: string;
  side: string;
  qty?: string;
  closedSize?: string;
  avgEntryPrice?: string;
  avgExitPrice?: string;
  closedPnl: string;
  createdTime?: string;
  updatedTime: string;
}

export interface RawList<T> {
  category?: string;
  list: T[];
  nextPageCursor?: string;
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export function instrumentId(category: Category, symbol: string): string {
  return `${category}:${symbol}`;
}

export function parseInstrumentId(id: string): { category: Category; symbol: string } {
  const idx = id.indexOf(":");
  const cat = (idx > 0 ? id.slice(0, idx) : "").toLowerCase();
  const symbol = (idx > 0 ? id.slice(idx + 1) : "").trim().toUpperCase();
  if (!CATEGORIES.includes(cat as Category) || !symbol) {
    throw new PlatformError(
      "invalid_request",
      `"${id}" is not a Bybit instrument id. Ids look like "linear:BTCUSDT", "spot:BTCUSDT", "inverse:BTCUSD" or "option:BTC-27DEC26-100000-C-USDT" (category:symbol); use search_instruments to find them.`,
    );
  }
  return { category: cat as Category, symbol };
}

export function positionId(category: Category, symbol: string, positionIdx: number): string {
  return `${category}:${symbol}:${positionIdx}`;
}

export function parsePositionId(id: string): { category: Category; symbol: string; positionIdx: number } {
  const parts = id.split(":");
  const idx = parts.length === 3 ? Number(parts[2]) : 0;
  const parsed = parseInstrumentId(parts.length === 3 ? `${parts[0]}:${parts[1]}` : id);
  if (parsed.category === "spot" || ![0, 1, 2].includes(idx)) {
    throw new PlatformError(
      "invalid_request",
      `"${id}" is not a Bybit position id. Position ids look like "linear:BTCUSDT:0" (category:symbol:positionIdx); get them from get_positions. Spot holdings are balances, not positions: sell them with a spot order.`,
    );
  }
  return { ...parsed, positionIdx: idx };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Number, treating "" and "0" as unknown (Bybit uses "0" for "not set"). */
export function nz(v: unknown): number | null {
  const n = num(v);
  return n === null || n === 0 ? null : n;
}

export function ts(v: unknown): number | null {
  const n = num(v);
  return n === null || n <= 0 ? null : n;
}

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/** Parse an option symbol like BTC-27DEC26-100000-C-USDT (the settle suffix is absent on older USDC options). */
export function parseOptionSymbol(symbol: string): {
  base: string;
  expiry: number | null;
  strike: number | null;
  optionType: "call" | "put" | null;
  settle: string;
} | null {
  const p = symbol.split("-");
  if (p.length < 4) return null;
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(p[1] ?? "");
  let expiry: number | null = null;
  if (m) {
    const month = MONTHS[m[2]!];
    if (month !== undefined) expiry = Date.UTC(2000 + Number(m[3]), month, Number(m[1]), 8, 0, 0);
  }
  const t = p[3]?.toUpperCase();
  return {
    base: p[0]!,
    expiry,
    strike: num(p[2]),
    optionType: t === "C" ? "call" : t === "P" ? "put" : null,
    settle: p[4] ?? "USDC",
  };
}

/** Best-effort settle coin from category + symbol (used where the API does not return it). */
export function settleCoinOf(category: Category, symbol: string): string | null {
  switch (category) {
    case "spot":
      return null;
    case "linear":
      return symbol.includes("USDT") ? "USDT" : "USDC";
    case "inverse": {
      const m = /^([A-Z0-9]+?)USD/.exec(symbol);
      return m ? m[1]! : null;
    }
    case "option":
      return parseOptionSymbol(symbol)?.settle ?? null;
  }
}

function mapStatus(s: string | undefined): MarketStatus {
  switch (s) {
    case "Trading":
      return "open";
    case "PreLaunch":
      return "pre_launch";
    case "Settling":
    case "Delivering":
    case "Closed":
      return "closed";
    default:
      return "unknown";
  }
}

function assetClassOf(raw: RawInstrument): AssetClass {
  switch ((raw.symbolType ?? "").toLowerCase()) {
    case "stock":
    case "xstocks":
    case "etf":
      return "stock";
    case "commodity":
      return "commodity";
    case "forex":
      return "fx";
    default:
      return "crypto";
  }
}

function instrumentTypeOf(category: Category, raw: RawInstrument): InstrumentType {
  if (category === "spot") return "spot";
  if (category === "option") return "option";
  return /Futures/i.test(raw.contractType ?? "") ? "future" : "perpetual";
}

function fmtDate(ms: number | null): string {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

export function mapInstrument(category: Category, raw: RawInstrument): Instrument {
  const type = instrumentTypeOf(category, raw);
  const base = raw.baseCoin ?? null;
  const quote = raw.quoteCoin ?? null;
  const lot = raw.lotSizeFilter ?? {};
  const opt = category === "option" ? parseOptionSymbol(raw.symbol) : null;
  const expiry = ts(raw.deliveryTime) ?? (opt?.expiry ?? null);
  const settle = raw.settleCoin ?? settleCoinOf(category, raw.symbol);
  const assetClass = assetClassOf(raw);

  let name: string;
  switch (type) {
    case "spot":
      name = `${base}/${quote} spot`;
      break;
    case "perpetual":
      name =
        category === "inverse"
          ? `${base}/USD inverse perpetual (${settle}-margined)`
          : `${base}/${quote} perpetual (${settle}-margined)`;
      break;
    case "future":
      name = `${base}/${quote} ${category === "inverse" ? "inverse " : ""}future, expires ${fmtDate(expiry)}`;
      break;
    default: {
      const optionType = raw.optionsType ?? (opt?.optionType === "call" ? "Call" : opt?.optionType === "put" ? "Put" : "");
      name = `${base} ${optionType} ${opt?.strike ?? ""} option, expires ${fmtDate(expiry)} (${settle})`;
    }
  }
  if (raw.fullName && raw.fullName !== base) name += ` · ${raw.fullName}`;

  const isInverse = category === "inverse";
  let sizeUnit: string;
  if (isInverse) sizeUnit = "contracts (1 contract = 1 USD)";
  else if (category === "option") sizeUnit = `contracts (1 contract = 1 ${base})`;
  else sizeUnit = base ?? "units";

  const sizeStep = category === "spot" ? num(lot.basePrecision) : num(lot.qtyStep);
  const maxSize = category === "spot" ? num(lot.maxLimitOrderQty) ?? num(lot.maxOrderQty) : num(lot.maxOrderQty);
  const maxMarket = category === "spot" ? num(lot.maxMarketOrderQty) : num(lot.maxMktOrderQty);
  const minNotional = category === "spot" ? num(lot.minOrderAmt) : num(lot.minNotionalValue);
  const fundingMinutes = num(raw.fundingInterval);

  let optionType: "call" | "put" | null = null;
  if (category === "option") {
    const t = (raw.optionsType ?? "").toLowerCase();
    optionType = t === "call" ? "call" : t === "put" ? "put" : (opt?.optionType ?? null);
  }

  const extra: Record<string, unknown> = { category };
  if (maxMarket !== null && maxMarket !== maxSize) extra.maxMarketOrderSize = maxMarket;
  if (category === "spot" && raw.marginTrading && raw.marginTrading !== "none") extra.marginTrading = raw.marginTrading;
  if (raw.symbolType) extra.symbolType = raw.symbolType;

  return {
    id: instrumentId(category, raw.symbol),
    symbol: raw.symbol,
    name,
    type,
    assetClass,
    quoteCurrency: isInverse ? "USD" : quote,
    status: mapStatus(raw.status),
    expiry,
    baseCurrency: base,
    settleCurrency: settle,
    contractKind: isInverse ? "inverse" : "linear",
    contractSize: 1,
    sizeUnit,
    minSize: num(lot.minOrderQty),
    maxSize,
    sizeStep,
    priceTick: num(raw.priceFilter?.tickSize),
    minNotional,
    maxLeverage: category === "spot" || category === "option" ? null : num(raw.leverageFilter?.maxLeverage),
    marginRate: null,
    strike: category === "option" ? opt?.strike ?? null : null,
    optionType,
    underlying: category === "spot" ? null : base,
    minStopDistance: null,
    fundingIntervalHours: type === "perpetual" && fundingMinutes ? fundingMinutes / 60 : null,
    tradingHours: assetClass === "crypto" ? "24/7" : null,
    extra,
  };
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export function mapTicker(category: Category, t: RawTicker, time: number, status: MarketStatus): Quote {
  const pct = category === "option" ? num(t.change24h) : num(t.price24hPcnt);
  return {
    instrumentId: instrumentId(category, t.symbol),
    time,
    bid: nz(t.bid1Price),
    ask: nz(t.ask1Price),
    last: nz(t.lastPrice),
    mark: nz(t.markPrice),
    index: nz(t.indexPrice) ?? nz(t.usdIndexPrice),
    high24h: nz(t.highPrice24h),
    low24h: nz(t.lowPrice24h),
    changePct24h: pct === null ? null : Math.round(pct * 1e6) / 1e4,
    volume24h: num(t.volume24h),
    openInterest: category === "spot" ? null : num(t.openInterest),
    fundingRate: category === "linear" || category === "inverse" ? num(t.fundingRate) : null,
    nextFundingTime: category === "linear" || category === "inverse" ? ts(t.nextFundingTime) : null,
    status,
    greeks:
      category === "option"
        ? { iv: num(t.markIv), delta: num(t.delta), gamma: num(t.gamma), vega: num(t.vega), theta: num(t.theta) }
        : null,
    underlyingPrice: category === "option" ? num(t.underlyingPrice) : null,
  };
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export function mapPosition(category: Category, p: RawPosition): Position {
  const extra: Record<string, unknown> = { positionIdx: p.positionIdx };
  if (p.positionStatus && p.positionStatus !== "Normal") extra.positionStatus = p.positionStatus;
  const mm = num(p.positionMM);
  if (mm !== null) extra.maintenanceMargin = mm;
  const value = num(p.positionValue);
  if (value !== null) extra.positionValue = value;
  if (category === "option") {
    extra.greeks = { delta: num(p.delta), gamma: num(p.gamma), vega: num(p.vega), theta: num(p.theta) };
  }
  return {
    id: positionId(category, p.symbol, p.positionIdx),
    instrumentId: instrumentId(category, p.symbol),
    symbol: p.symbol,
    side: p.side === "Sell" ? "short" : "long",
    size: num(p.size) ?? 0,
    entryPrice: nz(p.avgPrice),
    markPrice: nz(p.markPrice),
    unrealizedPnl: num(p.unrealisedPnl),
    realizedPnl: num(p.cumRealisedPnl) ?? num(p.curRealisedPnl),
    currency: settleCoinOf(category, p.symbol),
    leverage: nz(p.leverage),
    margin: num(p.positionIM),
    liquidationPrice: nz(p.liqPrice),
    stopLoss: nz(p.stopLoss),
    takeProfit: nz(p.takeProfit),
    trailingStop: nz(p.trailingStop),
    openedAt: ts(p.createdTime),
    extra,
  };
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export function mapOrderStatus(s: string | undefined): OrderStatus {
  switch (s) {
    case "New":
    case "Triggered":
    case "Active":
      return "open";
    case "PartiallyFilled":
      return "partially_filled";
    case "Filled":
      return "filled";
    case "Cancelled":
    case "PartiallyFilledCanceled":
    case "Deactivated":
      return "cancelled";
    case "Rejected":
      return "rejected";
    case "Untriggered":
      return "untriggered";
    default:
      return "unknown";
  }
}

export function mapTif(s: string | undefined): TimeInForce | null {
  switch (s) {
    case "GTC":
      return "gtc";
    case "IOC":
      return "ioc";
    case "FOK":
      return "fok";
    case "PostOnly":
      return "post_only";
    default:
      return null;
  }
}

export function toBybitTif(t: TimeInForce | undefined): string | undefined {
  switch (t) {
    case undefined:
      return undefined;
    case "gtc":
      return "GTC";
    case "ioc":
      return "IOC";
    case "fok":
      return "FOK";
    case "post_only":
      return "PostOnly";
    case "day":
      throw new PlatformError("invalid_request", 'Bybit does not support timeInForce "day". Use gtc, ioc, fok or post_only.');
  }
}

export function mapOrder(category: Category, o: RawOrder): Order {
  const trigger = nz(o.triggerPrice);
  const isMarket = o.orderType === "Market";
  let type: OrderType = isMarket ? "market" : "limit";
  if (trigger !== null) type = isMarket ? "stop" : "stop_limit";
  const extra: Record<string, unknown> = {};
  if (o.stopOrderType && o.stopOrderType !== "UNKNOWN") extra.stopOrderType = o.stopOrderType;
  if (o.positionIdx) extra.positionIdx = o.positionIdx;
  if (o.cancelType && o.cancelType !== "UNKNOWN") extra.cancelType = o.cancelType;
  if (category === "option" && nz(o.orderIv) !== null) extra.orderIv = num(o.orderIv);
  const fee = num(o.cumExecFee);
  if (fee) extra.fee = fee;
  const reject = o.rejectReason && o.rejectReason !== "EC_NoError" ? o.rejectReason : null;
  return {
    id: o.orderId,
    clientOrderId: o.orderLinkId || null,
    instrumentId: instrumentId(category, o.symbol),
    symbol: o.symbol,
    side: o.side === "Sell" ? "sell" : "buy",
    type,
    status: mapOrderStatus(o.orderStatus),
    size: num(o.qty) ?? 0,
    filledSize: num(o.cumExecQty),
    price: isMarket ? null : nz(o.price),
    triggerPrice: trigger,
    avgFillPrice: nz(o.avgPrice),
    timeInForce: mapTif(o.timeInForce),
    reduceOnly: category === "spot" ? null : (o.reduceOnly ?? null),
    stopLoss: nz(o.stopLoss),
    takeProfit: nz(o.takeProfit),
    createdAt: ts(o.createdTime),
    updatedAt: ts(o.updatedTime),
    rejectReason: reject,
    extra: Object.keys(extra).length ? extra : undefined,
  };
}

export function mapFill(category: Category, e: RawExecution): Fill {
  return {
    id: e.execId,
    orderId: e.orderId || null,
    instrumentId: instrumentId(category, e.symbol),
    symbol: e.symbol,
    side: e.side === "Sell" ? "sell" : "buy",
    size: num(e.execQty) ?? 0,
    price: num(e.execPrice) ?? 0,
    fee: num(e.execFee),
    feeCurrency: e.feeCurrency || (category === "spot" ? null : settleCoinOf(category, e.symbol)),
    realizedPnl: num(e.execPnl),
    isMaker: typeof e.isMaker === "boolean" ? e.isMaker : null,
    time: num(e.execTime) ?? 0,
  };
}

export function mapClosedPnl(category: Category, c: RawClosedPnl): ClosedPnl {
  const closedAt = num(c.updatedTime) ?? num(c.createdTime) ?? 0;
  return {
    id: `${c.orderId ?? c.symbol}:${closedAt}`,
    instrumentId: instrumentId(category, c.symbol),
    symbol: c.symbol,
    // Bybit reports the side of the closing order; the closed position was the opposite.
    side: c.side === "Sell" ? "long" : c.side === "Buy" ? "short" : null,
    size: num(c.closedSize) ?? num(c.qty),
    entryPrice: nz(c.avgEntryPrice),
    exitPrice: nz(c.avgExitPrice),
    pnl: num(c.closedPnl) ?? 0,
    currency: settleCoinOf(category, c.symbol),
    orderId: c.orderId || null,
    openedAt: null,
    closedAt,
  };
}

/** Bybit kline interval codes per generic resolution. */
export const KLINE_INTERVALS: Partial<Record<Resolution, string>> = {
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

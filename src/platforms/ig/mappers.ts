/**
 * Pure conversions between IG REST payloads and the generic model.
 */
import { num } from "../http.js";
import type {
  AssetClass,
  Candle,
  Instrument,
  InstrumentSummary,
  InstrumentType,
  MarketStatus,
  OrderStatus,
  Quote,
  Resolution,
} from "../types.js";

// ---------------------------------------------------------------------------
// IG payload shapes (only the fields we read; everything optional)
// ---------------------------------------------------------------------------

export interface IgRuleValue {
  unit?: string | null;
  value?: number | string | null;
}

export interface IgCurrency {
  code?: string;
  symbol?: string;
  isDefault?: boolean;
}

export interface IgInstrumentPayload {
  epic?: string;
  name?: string;
  expiry?: string;
  type?: string;
  unit?: string;
  lotSize?: number | string | null;
  contractSize?: number | string | null;
  valueOfOnePip?: number | string | null;
  onePipMeans?: string | null;
  currencies?: IgCurrency[] | null;
  marginFactor?: number | string | null;
  marginFactorUnit?: string | null;
  forceOpenAllowed?: boolean;
  stopsLimitsAllowed?: boolean;
  controlledRiskAllowed?: boolean;
  limitedRiskPremium?: IgRuleValue | null;
  openingHours?: { marketTimes?: { openTime?: string; closeTime?: string }[] | null } | null;
  expiryDetails?: { lastDealingDate?: string | null; settlementInfo?: string | null } | null;
}

export interface IgDealingRules {
  minDealSize?: IgRuleValue | null;
  minNormalStopOrLimitDistance?: IgRuleValue | null;
  minControlledRiskStopDistance?: IgRuleValue | null;
  maxStopOrLimitDistance?: IgRuleValue | null;
  minStepDistance?: IgRuleValue | null;
  marketOrderPreference?: string | null;
  trailingStopsPreference?: string | null;
}

export interface IgSnapshot {
  marketStatus?: string;
  bid?: number | null;
  offer?: number | null;
  high?: number | null;
  low?: number | null;
  percentageChange?: number | null;
  netChange?: number | null;
  updateTime?: string | null;
  decimalPlacesFactor?: number | null;
  scalingFactor?: number | null;
}

export interface IgMarketDetails {
  instrument?: IgInstrumentPayload;
  dealingRules?: IgDealingRules;
  snapshot?: IgSnapshot;
}

/** Market block as embedded in search results, positions and working orders. */
export interface IgMarketData {
  epic?: string;
  instrumentName?: string;
  instrumentType?: string;
  expiry?: string;
  marketStatus?: string;
  bid?: number | null;
  offer?: number | null;
  high?: number | null;
  low?: number | null;
  percentageChange?: number | null;
  scalingFactor?: number | null;
}

export interface IgPricePoint {
  bid?: number | null;
  ask?: number | null;
  lastTraded?: number | null;
}

export interface IgCandle {
  snapshotTimeUTC?: string;
  openPrice?: IgPricePoint;
  highPrice?: IgPricePoint;
  lowPrice?: IgPricePoint;
  closePrice?: IgPricePoint;
  lastTradedVolume?: number | null;
}

/** Facts derived from market details that trading code needs. */
export interface IgInstrumentFacts {
  epic: string;
  expiry: string;
  currency: string | null;
  /** Size of one IG "point" in the epic's price units (see pointSize()). */
  pointSize: number;
  priceTick: number | null;
  /** Value of a 1-point move for size 1, in `currency`. */
  valuePerPoint: number | null;
  minStepPoints: number | null;
  forceOpenAllowed: boolean;
  isSpreadbet: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const IG_RESOLUTIONS: Partial<Record<Resolution, string>> = {
  "1m": "MINUTE",
  "2m": "MINUTE_2",
  "3m": "MINUTE_3",
  "5m": "MINUTE_5",
  "10m": "MINUTE_10",
  "15m": "MINUTE_15",
  "30m": "MINUTE_30",
  "1h": "HOUR",
  "2h": "HOUR_2",
  "3h": "HOUR_3",
  "4h": "HOUR_4",
  "1d": "DAY",
  "1w": "WEEK",
  "1M": "MONTH",
};

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Epoch ms → "YYYY-MM-DDTHH:mm:ss" in UTC (IG's date parameter format). */
export function formatIgDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * Parse IG timestamps as UTC. Accepts "2026-11-23T10:00:00(.123)", "2026/11/23 10:00:00(:123)"
 * and "2026/11/23 10:00". Returns null when unparseable.
 */
export function parseIgUtc(s: unknown): number | null {
  if (typeof s !== "string" || !s) return null;
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:[.:](\d{1,3}))?/.exec(s.trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), Number((m[7] ?? "0").padEnd(3, "0")));
  return Number.isFinite(t) ? t : null;
}

export function mapMarketStatus(s: unknown): MarketStatus {
  switch (s) {
    case "TRADEABLE":
      return "open";
    case "CLOSED":
    case "OFFLINE":
      return "closed";
    case "EDITS_ONLY":
    case "ON_AUCTION":
    case "ON_AUCTION_NO_EDITS":
      return "auction";
    case "SUSPENDED":
      return "suspended";
    default:
      return "unknown";
  }
}

export function mapAssetClass(t: unknown): AssetClass {
  const s = typeof t === "string" ? t : "";
  if (s.includes("CURRENCIES")) return "fx";
  if (s.includes("INDICES") || s === "SECTORS") return "index";
  if (s.includes("SHARES")) return "stock";
  if (s.includes("COMMODITIES")) return "commodity";
  if (s.includes("RATES") || s.includes("BOND")) return "rates";
  return "other";
}

export function isSpreadbetAccount(accountType: string | null | undefined): boolean {
  return accountType === "SPREADBET";
}

export function mapInstrumentType(igType: unknown, accountType: string | null | undefined): InstrumentType {
  const s = typeof igType === "string" ? igType : "";
  if (s.startsWith("OPT_") || s === "BINARY") return "option";
  return isSpreadbetAccount(accountType) ? "spreadbet" : "cfd";
}

/** Short ticker-like symbol from an epic: "CS.D.EURUSD.CFD.IP" → "EURUSD". */
export function epicSymbol(epic: string): string {
  const parts = epic.split(".");
  return parts.length >= 3 && parts[2] ? parts[2] : epic;
}

/**
 * Size of one IG "point" (the unit of stop/limit distances, trailing stops and min stop
 * distances) in the epic's price units. Some epics quote levels in points already
 * (e.g. FX "…CFD.IP" at 10812.3: decimalPlacesFactor 1, scalingFactor 10000 → point = 1),
 * others quote real prices (e.g. FX "…MINI.IP" at 1.08123: decimalPlacesFactor 5,
 * scalingFactor 10000 → point = 0.0001). Indices have scalingFactor 1 → point = 1.
 */
export function pointSize(scalingFactor: unknown, decimalPlacesFactor: unknown): number {
  const sf = num(scalingFactor);
  const dpf = num(decimalPlacesFactor);
  if (!sf || sf <= 0) return 1;
  if (dpf === null) return 1 / sf;
  return sf <= Math.pow(10, dpf) + 1e-9 ? 1 / sf : 1;
}

/** Convert a dealing-rule distance to price units. */
export function ruleDistanceToPrice(rule: IgRuleValue | null | undefined, ptSize: number, refPrice: number | null): number | null {
  const v = num(rule?.value);
  if (v === null) return null;
  if (rule?.unit === "PERCENTAGE") return refPrice !== null ? (v / 100) * refPrice : null;
  return v * ptSize;
}

/** Parse IG money strings like "£-12.34", "E12.34", "-€1,234.50", "A$1.00". */
export function parseMoney(s: unknown): number | null {
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  if (typeof s !== "string") return null;
  const negative = s.includes("-");
  const cleaned = s.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export function mid(bid: number | null, ask: number | null): number | null {
  if (bid !== null && ask !== null) return (bid + ask) / 2;
  return bid ?? ask;
}

export function roundTo(value: number, step: number | null): number {
  if (!step || step <= 0) return value;
  const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  return Number((Math.round(value / step) * step).toFixed(Math.min(decimals, 12)));
}

/** Round a size to IG's 12-decimal precision limit and drop float artefacts. */
export function cleanSize(size: number): number {
  return Number(size.toFixed(12).replace(/\.?0+$/, ""));
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

function defaultCurrency(inst: IgInstrumentPayload | undefined): string | null {
  const list = inst?.currencies ?? [];
  return (list.find((c) => c.isDefault) ?? list[0])?.code ?? null;
}

export function instrumentFacts(d: IgMarketDetails, accountType: string | null): IgInstrumentFacts {
  const inst = d.instrument ?? {};
  const snap = d.snapshot ?? {};
  const pt = pointSize(snap.scalingFactor, snap.decimalPlacesFactor);
  const dpf = num(snap.decimalPlacesFactor);
  const spreadbet = isSpreadbetAccount(accountType);
  const vop = num(inst.valueOfOnePip);
  return {
    epic: inst.epic ?? "",
    expiry: inst.expiry ?? "-",
    currency: defaultCurrency(inst),
    pointSize: pt,
    priceTick: dpf !== null && dpf >= 0 ? Math.pow(10, -dpf) : null,
    valuePerPoint: spreadbet ? 1 : vop,
    minStepPoints: num(d.dealingRules?.minStepDistance?.value),
    forceOpenAllowed: inst.forceOpenAllowed !== false,
    isSpreadbet: spreadbet,
  };
}

function lastDealingDate(s: string | null | undefined): number | null {
  if (!s) return null;
  const iso = parseIgUtc(s);
  if (iso !== null) return iso;
  // e.g. "18/12/26 16:30" (dd/MM/yy HH:mm)
  const m = /^(\d{2})\/(\d{2})\/(\d{2,4})(?:\s+(\d{2}):(\d{2}))?/.exec(s);
  if (!m) return null;
  const y = Number(m[3]!.length === 2 ? `20${m[3]}` : m[3]);
  return Date.UTC(y, Number(m[2]) - 1, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0));
}

export function toInstrument(d: IgMarketDetails, accountType: string | null): Instrument {
  const inst = d.instrument ?? {};
  const snap = d.snapshot ?? {};
  const rules = d.dealingRules ?? {};
  const facts = instrumentFacts(d, accountType);
  const epic = facts.epic;
  const type = mapInstrumentType(inst.type, accountType);
  const ccy = facts.currency;
  const refPrice = mid(num(snap.bid), num(snap.offer));

  const rawContractSize = num(inst.contractSize);
  // Effective multiplier so that generic notional = size * contractSize * price holds:
  // spread bet: 1 unit = 1 currency per point → 1 / pointSize; CFD: value of one point per contract / pointSize.
  let contractSize: number;
  if (facts.isSpreadbet) contractSize = 1 / facts.pointSize;
  else if (facts.valuePerPoint !== null && facts.valuePerPoint > 0) contractSize = facts.valuePerPoint / facts.pointSize;
  else contractSize = rawContractSize ?? 1;

  const sizeUnit = facts.isSpreadbet
    ? `${ccy ?? "currency"} per point`
    : `contracts (contract size ${rawContractSize ?? "?"}${inst.unit === "SHARES" ? " shares" : ""}${facts.valuePerPoint !== null ? `; ${facts.valuePerPoint} ${ccy ?? ""} per point move` : ""})`;

  const marginFactor = num(inst.marginFactor);
  const marginRate = marginFactor !== null && inst.marginFactorUnit === "PERCENTAGE" ? marginFactor / 100 : null;

  const hours = (inst.openingHours?.marketTimes ?? [])
    .filter((t) => t.openTime && t.closeTime)
    .map((t) => `${t.openTime}-${t.closeTime}`);

  const extra: Record<string, unknown> = {
    expiry: facts.expiry,
    currencies: (inst.currencies ?? []).map((c) => c.code).filter(Boolean),
    pointSize: facts.pointSize,
  };
  if (rawContractSize !== null) extra.igContractSize = rawContractSize;
  if (inst.onePipMeans) extra.onePipMeans = inst.onePipMeans;
  if (inst.controlledRiskAllowed !== undefined) extra.guaranteedStopAllowed = inst.controlledRiskAllowed;
  if (inst.controlledRiskAllowed && inst.limitedRiskPremium?.value !== undefined && inst.limitedRiskPremium.value !== null) {
    extra.guaranteedStopPremium = { value: num(inst.limitedRiskPremium.value), unit: inst.limitedRiskPremium.unit ?? null };
    const minGs = ruleDistanceToPrice(rules.minControlledRiskStopDistance, facts.pointSize, refPrice);
    if (minGs !== null) extra.minGuaranteedStopDistance = minGs;
  }
  if (inst.stopsLimitsAllowed === false) extra.stopsLimitsAllowed = false;
  if (rules.marketOrderPreference === "NOT_AVAILABLE") extra.marketOrdersAvailable = false;
  if (rules.trailingStopsPreference === "NOT_AVAILABLE") extra.trailingStopsAvailable = false;
  if (inst.expiryDetails?.lastDealingDate) extra.lastDealingDate = inst.expiryDetails.lastDealingDate;
  if (hours.length > 0) extra.tradingHoursTimezone = "IG account timezone";

  return {
    id: epic,
    symbol: epicSymbol(epic),
    name: inst.name ?? epic,
    type,
    assetClass: mapAssetClass(inst.type),
    quoteCurrency: ccy,
    status: mapMarketStatus(snap.marketStatus),
    expiry: lastDealingDate(inst.expiryDetails?.lastDealingDate),
    baseCurrency: null,
    settleCurrency: ccy,
    contractKind: "linear",
    contractSize,
    sizeUnit,
    minSize: num(rules.minDealSize?.value),
    maxSize: null,
    sizeStep: null,
    priceTick: facts.priceTick,
    minNotional: null,
    maxLeverage: marginRate ? Math.round((1 / marginRate) * 100) / 100 : null,
    marginRate,
    strike: null,
    optionType: null,
    underlying: null,
    minStopDistance: ruleDistanceToPrice(rules.minNormalStopOrLimitDistance, facts.pointSize, refPrice),
    fundingIntervalHours: null,
    tradingHours: hours.length > 0 ? hours.join(", ") : null,
    extra,
  };
}

export function toInstrumentSummary(m: IgMarketData, accountType: string | null): InstrumentSummary {
  const epic = m.epic ?? "";
  return {
    id: epic,
    symbol: epicSymbol(epic),
    name: m.instrumentName ?? epic,
    type: mapInstrumentType(m.instrumentType, accountType),
    assetClass: mapAssetClass(m.instrumentType),
    quoteCurrency: null,
    status: mapMarketStatus(m.marketStatus),
    expiry: null,
  };
}

export function toQuote(d: IgMarketDetails, now: number): Quote {
  const snap = d.snapshot ?? {};
  const bid = num(snap.bid);
  const ask = num(snap.offer);
  return {
    instrumentId: d.instrument?.epic ?? "",
    time: now,
    bid,
    ask,
    last: null,
    mark: mid(bid, ask),
    index: null,
    high24h: num(snap.high),
    low24h: num(snap.low),
    changePct24h: num(snap.percentageChange),
    volume24h: null,
    openInterest: null,
    fundingRate: null,
    nextFundingTime: null,
    status: mapMarketStatus(snap.marketStatus),
    greeks: null,
    underlyingPrice: null,
  };
}

// ---------------------------------------------------------------------------
// Candles
// ---------------------------------------------------------------------------

function midPrice(p: IgPricePoint | undefined): number | null {
  const bid = num(p?.bid);
  const ask = num(p?.ask);
  if (bid !== null && ask !== null) return clean((bid + ask) / 2);
  return num(p?.lastTraded) ?? bid ?? ask;
}

const clean = (x: number) => Number(x.toFixed(10));

export function toCandle(p: IgCandle): Candle | null {
  const t = parseIgUtc(p.snapshotTimeUTC);
  const o = midPrice(p.openPrice);
  const h = midPrice(p.highPrice);
  const l = midPrice(p.lowPrice);
  const c = midPrice(p.closePrice);
  if (t === null || o === null || h === null || l === null || c === null) return null;
  const cb = num(p.closePrice?.bid);
  const ca = num(p.closePrice?.ask);
  return { t, o, h, l, c, v: num(p.lastTradedVolume), spread: cb !== null && ca !== null ? clean(ca - cb) : null };
}

// ---------------------------------------------------------------------------
// Deal confirmations
// ---------------------------------------------------------------------------

const REJECT_HINTS: Record<string, string> = {
  INSUFFICIENT_FUNDS: "insufficient funds / margin",
  MARGIN_ERROR: "margin requirement not met",
  MARKET_CLOSED: "market is closed",
  MARKET_CLOSED_WITH_EDITS: "market is closed (only edits allowed)",
  MARKET_OFFLINE: "market is offline",
  MINIMUM_ORDER_SIZE_ERROR: "size is below the minimum deal size (see getInstrument minSize)",
  SIZE_INCREMENT: "size is not a valid increment for this market",
  ATTACHED_ORDER_LEVEL_ERROR: "stop/limit level is invalid or too close to the market (see minStopDistance)",
  ATTACHED_ORDER_TRAILING_STOP_ERROR: "trailing stop settings are invalid",
  TRAILING_STOP_NOT_ALLOWED: "trailing stops are not allowed on this market/account",
  STOP_OR_LIMIT_NOT_ALLOWED: "stops/limits are not allowed on this market",
  STOP_REQUIRED_ERROR: "this market requires a stop",
  CR_SPACING: "guaranteed stop is too close to the market",
  LIMIT_ORDER_WRONG_SIDE_OF_MARKET: "order level is on the wrong side of the market",
  WRONG_SIDE_OF_MARKET: "level is on the wrong side of the market",
  LEVEL_TOLERANCE_ERROR: "level is too far from the current price",
  POSITION_NOT_AVAILABLE_TO_CLOSE: "position is not available to close",
  POSITION_NOT_FOUND: "position not found",
  ORDER_NOT_FOUND: "order not found",
  OPPOSING_POSITIONS_NOT_ALLOWED: "account does not allow opposing positions in one market",
  OPPOSING_DIRECTION_ORDERS_NOT_ALLOWED: "account does not allow opposing orders in one market",
  POSITION_ALREADY_EXISTS_IN_OPPOSITE_DIRECTION: "a position in the opposite direction already exists",
  REJECT_CFD_ORDER_ON_SPREADBET_ACCOUNT: "this is a CFD epic but the account is a spread bet account",
  REJECT_SPREADBET_ORDER_ON_CFD_ACCOUNT: "this is a spread bet epic but the account is a CFD account",
  MARKET_ORDERS_NOT_ALLOWED_ON_INSTRUMENT: "market orders are not allowed on this instrument; use a limit order",
  DUPLICATE_ORDER_ERROR: "duplicate order (deal reference already used)",
  CLOSINGS_ONLY_ACCOUNT: "account is restricted to closing trades",
  CLOSING_ONLY_TRADES_ACCEPTED_ON_THIS_MARKET: "only closing trades are accepted on this market",
  INSTRUMENT_NOT_TRADEABLE_IN_THIS_CURRENCY: "instrument cannot be traded in this currency",
  OVER_NORMAL_MARKET_SIZE: "size exceeds the normal market size",
  MARKET_UNAVAILABLE_TO_CLIENT: "market is not available to this account",
};

export function rejectMessage(reason: unknown): string {
  const r = typeof reason === "string" && reason ? reason : "UNKNOWN";
  const hint = REJECT_HINTS[r];
  return hint ? `IG rejected the deal: ${hint} (${r}).` : `IG rejected the deal (${r}).`;
}

export function rejectCode(reason: unknown): "insufficient_funds" | "market_closed" | "rejected" {
  if (reason === "INSUFFICIENT_FUNDS" || reason === "MARGIN_ERROR") return "insufficient_funds";
  if (reason === "MARKET_CLOSED" || reason === "MARKET_CLOSED_WITH_EDITS" || reason === "MARKET_OFFLINE") return "market_closed";
  return "rejected";
}

/** Map an IG activity action type to an order status. */
export function actionStatus(actionTypes: string[], activityStatus: unknown): OrderStatus {
  if (activityStatus === "REJECTED") return "rejected";
  if (actionTypes.some((a) => a.endsWith("_DELETED"))) return "cancelled";
  if (actionTypes.some((a) => a.endsWith("_FILLED") || a.startsWith("POSITION_"))) return "filled";
  if (actionTypes.some((a) => a.endsWith("_OPENED") || a.endsWith("_AMENDED") || a.endsWith("_ROLLED"))) return "open";
  return "unknown";
}

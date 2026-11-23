/**
 * The generic trading model shared by every platform adapter.
 *
 * Rules for adapters:
 * - All timestamps are epoch milliseconds (the MCP layer converts to ISO strings).
 * - All numbers are plain JS numbers (parse platform strings), or null when unknown.
 * - Instrument ids are opaque strings chosen by the adapter. They must be stable and
 *   unique within the platform, and are what agents pass back (e.g. "linear:BTCUSDT"
 *   on Bybit, an epic like "CS.D.EURUSD.CFD.IP" on IG).
 * - Throw PlatformError (see errors.ts) with a clear message the agent can act on.
 * - Keep `extra` small: only platform facts an agent genuinely needs and that do not
 *   fit a generic field.
 */

export type EnvironmentId = "live" | "demo" | "testnet";
export type AgentEnvironment = "live" | "demo";

export type InstrumentType = "spot" | "perpetual" | "future" | "option" | "cfd" | "spreadbet" | "other";
export type AssetClass = "crypto" | "fx" | "index" | "stock" | "commodity" | "rates" | "other";
export type Side = "buy" | "sell";
export type PositionSide = "long" | "short";
export type OrderType = "market" | "limit" | "stop" | "stop_limit";
export type TimeInForce = "gtc" | "ioc" | "fok" | "post_only" | "day";
export type OrderStatus =
  | "open"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected"
  | "expired"
  | "untriggered"
  | "unknown";

export const RESOLUTIONS = [
  "1m", "2m", "3m", "5m", "10m", "15m", "30m",
  "1h", "2h", "3h", "4h", "6h", "12h",
  "1d", "1w", "1M",
] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const RESOLUTION_MS: Record<Resolution, number> = {
  "1m": 60_000,
  "2m": 120_000,
  "3m": 180_000,
  "5m": 300_000,
  "10m": 600_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "3h": 10_800_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
  "1M": 2_678_400_000, // 31 days: used as an upper bound for "is this candle finished"
};

// ---------------------------------------------------------------------------
// Platform definition
// ---------------------------------------------------------------------------

export interface CredentialField {
  key: string;
  label: string;
  type: "text" | "password" | "select";
  required: boolean;
  /** Secret fields are never shown again after saving. */
  secret: boolean;
  help?: string;
  options?: { value: string; label: string }[];
  default?: string;
}

export interface PlatformEnvironment {
  id: EnvironmentId;
  label: string;
  /** True when no real money is involved on the platform side. */
  isDemo: boolean;
  description?: string;
}

export interface PlatformCapabilities {
  instrumentTypes: InstrumentType[];
  resolutions: Resolution[];
  orderTypes: OrderType[];
  timeInForce: TimeInForce[];
  /** Level-2 order book available via getOrderBook. */
  orderBook: boolean;
  /** setLeverage is implemented. */
  setLeverage: boolean;
  /** amendOrder is implemented. */
  amendOrder: boolean;
  /** Stop loss / take profit can be attached to orders and positions. */
  stopLossTakeProfit: boolean;
  trailingStop: boolean;
  guaranteedStop: boolean;
  /** The account can hold separate long and short positions in one instrument. */
  hedgeMode: boolean;
  /** Short facts an agent must know about this platform (sizing units, quirks). */
  notes: string[];
}

export interface PlatformDefinition {
  id: string;
  name: string;
  description: string;
  website: string;
  /** Short how-to shown on the "add account" page. */
  setupHelp: string[];
  credentialFields: CredentialField[];
  /** API keys are usually bound to fixed IPs; the UI then shows the server's outbound IP. */
  ipAllowlist?: boolean;
  environments: PlatformEnvironment[];
  capabilities: PlatformCapabilities;
  createClient(ctx: PlatformClientContext): PlatformClient;
}

export interface PlatformClientContext {
  /** Our platform_accounts.id, for logging and cache keys. */
  accountId: string;
  environment: EnvironmentId;
  credentials: Record<string, string>;
  /** Metadata stored from a previous validate() call. */
  meta: Record<string, unknown>;
  /** Persist updated metadata (e.g. learned quota state). */
  saveMeta?(meta: Record<string, unknown>): void;
  /** Shared key/value store for rate-limit and quota state (survives restarts). */
  quotaStore: QuotaStore;
}

export interface QuotaStore {
  get(key: string): DataQuota | null;
  set(key: string, quota: DataQuota): void;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface ValidationResult {
  /** Blocking problems; the account is not saved when this is non-empty. */
  errors: string[];
  /** Non-blocking hints shown to the user. */
  warnings: string[];
  /** Whether the credentials allow placing orders. */
  canTrade: boolean;
  externalId: string | null;
  /** Human-readable summary, e.g. "UID 123456 · Unified Trading Account". */
  description: string | null;
  currency: string | null;
  /** Stored and passed back to createClient as ctx.meta. */
  meta: Record<string, unknown>;
}

export interface Balance {
  asset: string;
  total: number;
  available: number | null;
  /** Value in the account currency, when the platform reports it. */
  value: number | null;
}

export interface AccountSummary {
  externalId: string | null;
  accountType: string | null;
  /** Currency the totals below are expressed in. */
  currency: string;
  equity: number;
  /** Cash / wallet balance excluding unrealized PnL. */
  balance: number | null;
  /** Funds available for new positions. */
  available: number | null;
  unrealizedPnl: number | null;
  marginUsed: number | null;
  /** one_way = one net position per instrument; hedge = separate long and short positions. Null when not applicable/unknown. */
  positionMode?: "one_way" | "hedge" | null;
  /** e.g. "cross", "isolated", "portfolio"; null when not applicable/unknown. */
  marginMode?: string | null;
  balances: Balance[];
  extra?: Record<string, unknown>;
}

export interface InstrumentSummary {
  id: string;
  symbol: string;
  name: string;
  type: InstrumentType;
  assetClass: AssetClass;
  quoteCurrency: string | null;
  status: MarketStatus;
  expiry: number | null;
}

export type MarketStatus = "open" | "closed" | "auction" | "suspended" | "pre_launch" | "unknown";

export interface Instrument extends InstrumentSummary {
  baseCurrency: string | null;
  settleCurrency: string | null;
  /**
   * How notional is computed: linear => size * contractSize * price (in quote currency);
   * inverse => size * contractSize (already in quote currency, e.g. USD contracts).
   */
  contractKind: "linear" | "inverse";
  contractSize: number;
  /** What one unit of `size` means, in words, e.g. "BTC", "contracts (1 contract = 1 USD)", "GBP per point". */
  sizeUnit: string;
  minSize: number | null;
  maxSize: number | null;
  sizeStep: number | null;
  priceTick: number | null;
  minNotional: number | null;
  maxLeverage: number | null;
  /** Margin requirement as a fraction (0.05 = 5 %), when fixed per instrument. */
  marginRate: number | null;
  strike: number | null;
  optionType: "call" | "put" | null;
  underlying: string | null;
  /** Minimum distance for attached stops/limits, in price units, when the platform enforces one. */
  minStopDistance: number | null;
  fundingIntervalHours: number | null;
  tradingHours: string | null;
  extra?: Record<string, unknown>;
}

export interface Quote {
  instrumentId: string;
  time: number;
  bid: number | null;
  ask: number | null;
  last: number | null;
  mark: number | null;
  index: number | null;
  high24h: number | null;
  low24h: number | null;
  /** Percent, e.g. 1.5 means +1.5 %. */
  changePct24h: number | null;
  volume24h: number | null;
  openInterest: number | null;
  fundingRate: number | null;
  nextFundingTime: number | null;
  status: MarketStatus;
  /** Options only. */
  greeks: { iv: number | null; delta: number | null; gamma: number | null; vega: number | null; theta: number | null } | null;
  underlyingPrice: number | null;
}

export interface OrderBook {
  instrumentId: string;
  time: number;
  bids: [price: number, size: number][];
  asks: [price: number, size: number][];
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
  /** Close spread (ask - bid) when the platform provides bid/ask candles. Prices are mid in that case. */
  spread: number | null;
}

export interface DataQuota {
  kind: "weekly_points" | "rate_limit" | "none";
  remaining: number | null;
  total: number | null;
  resetsAt: number | null;
  note: string;
  updatedAt?: number;
}

export interface Position {
  id: string;
  instrumentId: string;
  symbol: string;
  side: PositionSide;
  size: number;
  entryPrice: number | null;
  markPrice: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number | null;
  currency: string | null;
  leverage: number | null;
  margin: number | null;
  liquidationPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  trailingStop: number | null;
  openedAt: number | null;
  extra?: Record<string, unknown>;
}

export interface Order {
  id: string;
  clientOrderId: string | null;
  instrumentId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  status: OrderStatus;
  size: number;
  filledSize: number | null;
  price: number | null;
  triggerPrice: number | null;
  avgFillPrice: number | null;
  timeInForce: TimeInForce | null;
  reduceOnly: boolean | null;
  stopLoss: number | null;
  takeProfit: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  rejectReason: string | null;
  extra?: Record<string, unknown>;
}

export interface Fill {
  id: string;
  orderId: string | null;
  instrumentId: string;
  symbol: string;
  side: Side;
  size: number;
  price: number;
  fee: number | null;
  feeCurrency: string | null;
  realizedPnl: number | null;
  isMaker: boolean | null;
  time: number;
}

export interface ClosedPnl {
  id: string;
  instrumentId: string;
  symbol: string;
  /** Side of the position that was closed. */
  side: PositionSide | null;
  size: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  /** Realized PnL after fees where the platform reports it that way. */
  pnl: number;
  currency: string | null;
  orderId: string | null;
  openedAt: number | null;
  closedAt: number;
}

export interface OrderResult {
  orderId: string | null;
  status: OrderStatus;
  message: string | null;
  filledSize: number | null;
  avgFillPrice: number | null;
  positionId: string | null;
  extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface TimeRange {
  instrumentId?: string;
  from?: number;
  to?: number;
  limit: number;
}

export interface PlaceOrderRequest {
  instrumentId: string;
  side: Side;
  type: OrderType;
  size: number;
  /** Limit price (limit, stop_limit). */
  price?: number;
  /** Trigger price (stop, stop_limit). */
  triggerPrice?: number;
  timeInForce?: TimeInForce;
  reduceOnly?: boolean;
  stopLoss?: number;
  takeProfit?: number;
  trailingStopDistance?: number;
  guaranteedStop?: boolean;
  /**
   * Hedge-mode accounts only: which position (long/short) the order belongs to. Optional: adapters
   * detect the account's position mode and derive the side (buy opens long, sell opens short,
   * reduce-only closes the opposite side). Ignored on one-way accounts.
   */
  positionSide?: PositionSide;
  clientOrderId?: string;
}

export interface AmendOrderRequest {
  orderId: string;
  instrumentId?: string;
  size?: number;
  price?: number;
  triggerPrice?: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
}

export interface ClosePositionRequest {
  positionId: string;
  /** Partial close size; omit to close everything. */
  size?: number;
  type?: "market" | "limit";
  price?: number;
}

export interface PositionProtectionRequest {
  positionId: string;
  /** undefined = leave unchanged, null = remove. */
  stopLoss?: number | null;
  takeProfit?: number | null;
  trailingStopDistance?: number | null;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface PlatformClient {
  /** Check credentials and permissions. Must refuse keys that can withdraw funds. */
  validate(): Promise<ValidationResult>;
  /** Cache partition for market data, e.g. "bybit:mainnet" or "ig:demo". */
  marketDataKey(): string;

  getAccount(): Promise<AccountSummary>;
  searchInstruments(p: { query?: string; type?: InstrumentType; limit: number }): Promise<InstrumentSummary[]>;
  getInstrument(instrumentId: string): Promise<Instrument>;
  getQuotes(instrumentIds: string[]): Promise<Quote[]>;
  getOrderBook?(instrumentId: string, depth: number): Promise<OrderBook>;

  /**
   * Return all candles with open time in [from, to), ascending. The cache layer calls
   * this only for ranges it does not have. Report the current data quota when known.
   */
  fetchCandles(p: { instrumentId: string; resolution: Resolution; from: number; to: number }): Promise<{
    candles: Candle[];
    quota: DataQuota | null;
  }>;
  /** Current usage limits relevant to the agent (historic data allowance, rate limits). */
  getQuota(): Promise<DataQuota | null>;

  getPositions(p: { instrumentId?: string }): Promise<Position[]>;
  getOpenOrders(p: { instrumentId?: string }): Promise<Order[]>;
  /** History methods return newest first, at most `limit` items. */
  getOrderHistory(p: TimeRange): Promise<Order[]>;
  getFills(p: TimeRange): Promise<Fill[]>;
  getClosedPnl(p: TimeRange): Promise<ClosedPnl[]>;

  placeOrder(req: PlaceOrderRequest): Promise<OrderResult>;
  amendOrder?(req: AmendOrderRequest): Promise<OrderResult>;
  cancelOrder(req: { orderId: string; instrumentId?: string }): Promise<OrderResult>;
  cancelAllOrders(p: { instrumentId?: string }): Promise<{ cancelled: string[] }>;
  closePosition(req: ClosePositionRequest): Promise<OrderResult>;
  setPositionProtection?(req: PositionProtectionRequest): Promise<Position | null>;
  setLeverage?(p: { instrumentId: string; leverage: number }): Promise<{ leverage: number }>;

  /** Release sessions/timers. */
  close?(): Promise<void>;
}

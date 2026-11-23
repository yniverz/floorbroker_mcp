import { PlatformError } from "../errors.js";
import type {
  PlatformCapabilities,
  PlatformClient,
  PlatformClientContext,
  PlatformDefinition,
  Resolution,
} from "../types.js";
import { BybitClient } from "./adapter.js";

export const BYBIT_REGION_HOSTS: Record<string, { host: string; label: string }> = {
  global: { host: "api.bybit.com", label: "Global (bybit.com)" },
  eu: { host: "api.bybit.eu", label: "EEA (bybit.eu)" },
  nl: { host: "api.bybit.nl", label: "Netherlands (bybit.nl)" },
  tr: { host: "api.bybit.tr", label: "Türkiye (bybit.tr)" },
  kz: { host: "api.bybit.kz", label: "Kazakhstan (bybit.kz)" },
  ge: { host: "api.bybitgeorgia.ge", label: "Georgia (bybitgeorgia.ge)" },
  ae: { host: "api.bybit.ae", label: "UAE (bybit.ae)" },
  id: { host: "api.bybit.id", label: "Indonesia (bybit.id)" },
  hk: { host: "api.spark-fintech.com", label: "Hong Kong (spark-fintech.com)" },
};

export const BYBIT_RESOLUTIONS: Resolution[] = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "1w", "1M"];

const capabilities: PlatformCapabilities = {
  instrumentTypes: ["spot", "perpetual", "future", "option"],
  resolutions: BYBIT_RESOLUTIONS,
  orderTypes: ["market", "limit", "stop", "stop_limit"],
  timeInForce: ["gtc", "ioc", "fok", "post_only"],
  orderBook: true,
  setLeverage: true,
  amendOrder: true,
  stopLossTakeProfit: true,
  trailingStop: true,
  guaranteedStop: false,
  hedgeMode: true,
  notes: [
    "Instrument ids are category:symbol, e.g. linear:BTCUSDT (USDT perpetual), spot:BTCUSDT, inverse:BTCUSD, option:BTC-25DEC26-100000-C-USDT. The same symbol exists in several categories.",
    "Size is a base-coin quantity for spot, linear contracts and options (1 option contract = 1 coin). Inverse contracts are sized in USD (1 contract = 1 USD).",
    "Spot holdings are balances (see get_account), not positions: reduce them with a spot sell order. reduceOnly applies to derivatives only.",
    "Options settle in the coin shown in the symbol suffix (currently USDT), have no stop orders and no candles, and appear in search results only with type=option or an option-style query like BTC-25DEC26.",
    "Stop orders trigger on the last traded price. Stop loss / take profit attached to a derivatives order cover the whole position.",
    "Accounts in hedge mode must pass positionSide (long/short) on orders; one-way accounts must omit it.",
    "A trailing stop cannot be attached to a new order: set it on the open position with set_position_protection.",
    "Demo trading uses real mainnet prices but keeps order history for 7 days only; testnet has its own, unrelated prices.",
  ],
};

export const bybitPlatform: PlatformDefinition = {
  id: "bybit",
  name: "Bybit",
  description: "Crypto exchange: spot, USDT/USDC perpetuals and futures, inverse contracts and options (API v5, Unified Trading Account).",
  website: "https://www.bybit.com",
  setupHelp: [
    "Log in to Bybit (for Demo: switch to Demo Trading first; for testnet: use testnet.bybit.com) and open Account → API Management → Create New Key.",
    "Choose \"System-generated API Keys\" (HMAC) and \"API Transaction\".",
    "Permissions: Read-Write; enable Orders and Positions for Contract (Unified Trading), plus Spot trade and Options trade if you want those. Do NOT enable any Withdrawal or transfer permission: keys that can withdraw are refused.",
    "Optionally bind the key to this server's IP address (keys without an IP binding expire after 90 days).",
    "Sub-account keys work too and keep the agent's funds separate from your main account.",
    "Paste the API key and secret here and pick the region your account is registered with.",
  ],
  credentialFields: [
    { key: "apiKey", label: "API key", type: "text", required: true, secret: true },
    { key: "apiSecret", label: "API secret", type: "password", required: true, secret: true },
    {
      key: "region",
      label: "Region",
      type: "select",
      required: true,
      secret: false,
      default: "global",
      help: "The Bybit site your account belongs to. Only used for the Live environment.",
      options: Object.entries(BYBIT_REGION_HOSTS).map(([value, r]) => ({ value, label: r.label })),
    },
  ],
  environments: [
    { id: "live", label: "Live", isDemo: false, description: "Real money on the selected Bybit region." },
    {
      id: "demo",
      label: "Demo trading",
      isDemo: true,
      description: "Bybit's mainnet Demo Trading account (api-demo.bybit.com) with real market prices. Create the key while in Demo Trading mode.",
    },
    {
      id: "testnet",
      label: "Testnet",
      isDemo: true,
      description: "testnet.bybit.com (api-testnet.bybit.com): separate test exchange with its own prices.",
    },
  ],
  capabilities,
  createClient(ctx: PlatformClientContext): PlatformClient {
    const region = ctx.credentials.region || "global";
    const regionHost = BYBIT_REGION_HOSTS[region]?.host;
    if (!regionHost) {
      throw new PlatformError("invalid_request", `Unknown Bybit region "${region}". Use one of: ${Object.keys(BYBIT_REGION_HOSTS).join(", ")}.`);
    }
    let host: string;
    let publicHost: string;
    switch (ctx.environment) {
      case "live":
        host = regionHost;
        publicHost = regionHost;
        break;
      case "demo":
        host = "api-demo.bybit.com";
        publicHost = "api.bybit.com";
        break;
      case "testnet":
        host = "api-testnet.bybit.com";
        publicHost = "api-testnet.bybit.com";
        break;
    }
    return new BybitClient(ctx, { host, publicHost, apiKey: ctx.credentials.apiKey ?? "", apiSecret: ctx.credentials.apiSecret ?? "" });
  },
};

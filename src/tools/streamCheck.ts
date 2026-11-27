/**
 * Read-only stream check: subscribes to ticks, candles and (optionally) account events
 * for one account and prints what arrives. Places no orders.
 *
 *   node dist/tools/streamCheck.js <account-id> <instrument-id> [resolution=1m] [seconds=75] [--account-events]
 */
import { loadConfig } from "../config.js";
import { createContext } from "../context.js";
import { openAppDb } from "../db/app.js";
import { openMarketDb } from "../db/marketdata.js";
import { setLogLevel } from "../logger.js";
import { configureOutboundProxy } from "../platforms/http.js";
import { RESOLUTIONS, type Resolution } from "../platforms/types.js";

const [accountId, instrumentId, resArg, secondsArg, ...flags] = process.argv.slice(2);
if (!accountId || !instrumentId) {
  console.error("usage: streamCheck <account-id> <instrument-id> [resolution] [seconds] [--account-events]");
  process.exit(2);
}
const resolution = (resArg ?? "1m") as Resolution;
if (!RESOLUTIONS.includes(resolution)) throw new Error(`unknown resolution ${resolution}`);
const seconds = Number(secondsArg ?? 75);

const config = loadConfig();
setLogLevel(process.env.LOG_LEVEL ?? "info");
configureOutboundProxy(config.outboundProxy, config.outboundProxyPlatforms, config.outboundProxyVia);
const ctx = createContext(config, openAppDb(config.appDbPath), openMarketDb(config.marketDbPath));

let ticks = 0;
let lastTick: unknown = null;
let provisional = 0;
const finals: unknown[] = [];
const events: string[] = [];

const unsub = [
  ctx.streams.ticks(accountId, instrumentId, (t) => {
    ticks++;
    lastTick = t;
  }),
  ctx.streams.candleStream(accountId, instrumentId, resolution, (c) => {
    if (c.final) finals.push(c);
    else provisional++;
  }),
];
if (flags.includes("--account-events")) {
  unsub.push(ctx.streams.accountEvents(accountId, (e) => events.push(e.type)));
}

const t0 = Date.now();
const timer = setInterval(() => {
  const s = ctx.streams.status(accountId);
  console.log(`${Math.round((Date.now() - t0) / 1000)}s ticks=${ticks} provisional=${provisional} final=${finals.length} events=${events.length} connected=${s?.connected} error=${s?.error ?? "-"}`);
}, 15_000);

setTimeout(async () => {
  clearInterval(timer);
  console.log("status:", JSON.stringify(ctx.streams.status(accountId)));
  console.log("last tick:", JSON.stringify(lastTick));
  console.log("final candles:", JSON.stringify(finals));
  console.log("account events:", JSON.stringify(events));
  for (const u of unsub) u();
  await ctx.accountService.closeAll();
  process.exit(0);
}, seconds * 1000);

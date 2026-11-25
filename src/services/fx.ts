import { logger } from "../logger.js";

/**
 * Currency conversion for display totals, based on the ECB euro reference rates
 * (published once per working day, no API key). Stablecoins count as their fiat peg.
 */
const ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const TTL_MS = 6 * 3_600_000;
const ALIASES: Record<string, string> = { USDT: "USD", USDC: "USD", FDUSD: "USD", DAI: "USD", EURC: "EUR" };

export interface FxRates {
  /** Units of currency per 1 EUR, e.g. USD → 1.0942. */
  perEur: Record<string, number>;
  date: string | null;
}

let cache: { at: number; rates: FxRates } | null = null;

export async function fxRates(): Promise<FxRates | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rates;
  try {
    const res = await fetch(ECB_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const perEur: Record<string, number> = { EUR: 1 };
    for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]/g)) perEur[m[1]!] = Number(m[2]);
    const date = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1] ?? null;
    if (!perEur.USD) throw new Error("no USD rate in ECB file");
    cache = { at: Date.now(), rates: { perEur, date } };
    return cache.rates;
  } catch (err) {
    logger.warn("fx rates unavailable", { err: String(err) });
    return cache?.rates ?? null; // stale rates are better than none
  }
}

export function normalizeCurrency(ccy: string): string {
  const c = ccy.toUpperCase();
  return ALIASES[c] ?? c;
}

/** Converts an amount between currencies; null when a rate is missing. */
export function convert(rates: FxRates, amount: number, from: string, to: string): number | null {
  const f = rates.perEur[normalizeCurrency(from)];
  const t = rates.perEur[normalizeCurrency(to)];
  if (!f || !t) return null;
  return (amount / f) * t;
}

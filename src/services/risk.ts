import { PlatformError } from "../platforms/errors.js";
import type { Instrument, PlaceOrderRequest, PlatformClient } from "../platforms/types.js";
import type { RiskLimits } from "../repos/connections.js";

export function hasLimits(r: RiskLimits): boolean {
  return (
    r.maxOrderNotional !== undefined ||
    r.maxPositionNotional !== undefined ||
    r.maxLeverage !== undefined ||
    (r.allowedInstruments?.length ?? 0) > 0
  );
}

export function notional(instrument: Instrument, size: number, price: number): number {
  const cs = instrument.contractSize || 1;
  return instrument.contractKind === "inverse" ? Math.abs(size) * cs : Math.abs(size) * cs * price;
}

export function instrumentAllowed(r: RiskLimits, instrumentId: string): boolean {
  const list = r.allowedInstruments ?? [];
  if (list.length === 0) return true;
  return list.some((p) => (p.endsWith("*") ? instrumentId.startsWith(p.slice(0, -1)) : p === instrumentId));
}

function deny(message: string): PlatformError {
  return new PlatformError("permission_denied", `Blocked by this connection's risk limits: ${message}`);
}

/**
 * Checks an order against the connection's risk limits. Reduce-only orders are
 * always allowed (except for the instrument allowlist), so an agent can always exit.
 */
export async function checkOrder(client: PlatformClient, limits: RiskLimits, req: PlaceOrderRequest): Promise<void> {
  if (!instrumentAllowed(limits, req.instrumentId)) {
    throw deny(`instrument ${req.instrumentId} is not in the allowed list (${(limits.allowedInstruments ?? []).join(", ")}).`);
  }
  if (req.reduceOnly) return;
  if (limits.maxOrderNotional === undefined && limits.maxPositionNotional === undefined) return;

  const instrument = await client.getInstrument(req.instrumentId);
  let price = req.price ?? req.triggerPrice;
  if (price === undefined) {
    const [q] = await client.getQuotes([req.instrumentId]);
    const mid = q && q.bid !== null && q.ask !== null ? (q.bid + q.ask) / 2 : null;
    price = (req.side === "buy" ? q?.ask : q?.bid) ?? mid ?? q?.last ?? q?.mark ?? undefined;
  }
  if (price === undefined || price === null) throw deny("could not determine a price to evaluate the order's notional.");

  const orderNotional = notional(instrument, req.size, price);
  const ccy = instrument.quoteCurrency ?? "";
  if (limits.maxOrderNotional !== undefined && orderNotional > limits.maxOrderNotional) {
    throw deny(`order notional ≈ ${orderNotional.toFixed(2)} ${ccy} exceeds the maximum of ${limits.maxOrderNotional} ${ccy}.`);
  }

  if (limits.maxPositionNotional !== undefined) {
    const positions = await client.getPositions({ instrumentId: req.instrumentId });
    const signed = positions.reduce((sum, p) => sum + (p.side === "long" ? p.size : -p.size), 0);
    const after = signed + (req.side === "buy" ? req.size : -req.size);
    const afterNotional = notional(instrument, after, price);
    if (Math.abs(after) > Math.abs(signed) && afterNotional > limits.maxPositionNotional) {
      throw deny(
        `resulting position notional ≈ ${afterNotional.toFixed(2)} ${ccy} would exceed the maximum of ${limits.maxPositionNotional} ${ccy}.`,
      );
    }
  }
}

export function checkLeverage(limits: RiskLimits, instrumentId: string, leverage: number): void {
  if (!instrumentAllowed(limits, instrumentId)) throw deny(`instrument ${instrumentId} is not in the allowed list.`);
  if (limits.maxLeverage !== undefined && leverage > limits.maxLeverage) {
    throw deny(`leverage ${leverage}x exceeds the maximum of ${limits.maxLeverage}x.`);
  }
}

import type { Candle, Resolution } from "../platforms/types.js";

/** What a strategy declares about itself (read from `strategy` after loading). */
export interface StrategyDeclaration {
  name: string | null;
  params: Record<string, unknown>;
  data: { instrument: string; resolution: Resolution; history?: number }[];
  ticks: string[];
  handlers: string[];
}

export interface StrategyLog {
  t: number;
  msg: string;
}

/** Synchronous, read-only bridge from the sandbox to floorbroker. */
export type HostApi = (op: string, args: unknown[]) => unknown;

export type Intent =
  | {
      kind: "order";
      localId: string;
      instrument: string;
      side: "buy" | "sell";
      type: "market" | "limit" | "stop";
      size: number;
      price?: number;
      triggerPrice?: number;
      stopLoss?: number;
      takeProfit?: number;
      reduceOnly: boolean;
      tag: string | null;
    }
  | { kind: "cancel"; localId: string; target: string }
  | { kind: "cancelAll"; localId: string; instrument: string | null }
  | { kind: "close"; localId: string; instrument: string; size: number | null }
  | { kind: "protect"; localId: string; instrument: string; stopLoss?: number | null; takeProfit?: number | null };

/** Trading rules the engine needs per instrument. */
export interface InstrumentRules {
  instrumentId: string;
  minSize: number | null;
  sizeStep: number | null;
  priceTick: number | null;
  contractSize: number;
  contractKind: "linear" | "inverse";
  quoteCurrency: string | null;
}

export interface Bar extends Candle {
  instrument: string;
  resolution: Resolution;
}

export interface SimOrder {
  id: string;
  tag: string | null;
  instrument: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop";
  size: number;
  price: number | null;
  triggerPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  reduceOnly: boolean;
  createdAt: number;
}

export interface SimPosition {
  instrument: string;
  /** Signed: positive long, negative short. */
  qty: number;
  avgPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: number;
  /** Fills before this time do not trigger SL/TP checks (avoids same-bar ambiguity). */
  protectFrom: number;
}

export interface SimFill {
  id: string;
  orderId: string;
  tag: string | null;
  instrument: string;
  side: "buy" | "sell";
  size: number;
  price: number;
  fee: number;
  /** Realized PnL of the closing part, in account currency (0 for pure opens). */
  pnl: number;
  reason: "order" | "stop_loss" | "take_profit" | "close";
  time: number;
}

export interface OrderEvent {
  id: string;
  tag: string | null;
  instrument: string;
  status: "open" | "filled" | "cancelled" | "rejected";
  reason: string | null;
}

export interface CostModel {
  /** Fee in basis points for orders that rest (limit). */
  makerBps: number;
  /** Fee in basis points for orders that take liquidity (market, stop, SL/TP exits). */
  takerBps: number;
  /** Extra adverse slippage in basis points for market/stop executions. */
  slippageBps: number;
  /** Use candle/tick spreads (IG) for market executions. */
  useSpread: boolean;
}

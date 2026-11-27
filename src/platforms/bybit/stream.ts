import { createHmac } from "node:crypto";
import { logger } from "../../logger.js";
import { dispatcherFor } from "../http.js";
import { ManagedSocket, StatusTracker, Topics } from "../streamKit.js";
import { RESOLUTION_MS, type AccountEvent, type CandleUpdate, type PlatformStream, type Resolution, type StreamStatus, type Tick, type Unsubscribe } from "../types.js";
import {
  KLINE_INTERVALS,
  instrumentId,
  mapFill,
  mapOrder,
  mapPosition,
  nz,
  parseInstrumentId,
  type Category,
  type RawExecution,
  type RawOrder,
  type RawPosition,
} from "./mappers.js";

const PING_MS = 20_000;
const IDLE_MS = 60_000;

export interface BybitStreamOptions {
  /** Host for public market data, e.g. "stream.bybit.com". */
  publicHost: string;
  /** Full URL of the private stream, e.g. "wss://stream-demo.bybit.com/v5/private". */
  privateUrl: string;
  apiKey: string;
  apiSecret: string;
}

/** Maps a REST host to its WebSocket host: api.bybit.com → stream.bybit.com, api-demo… → stream-demo… */
export function streamHostFor(restHost: string): string {
  return restHost.replace(/^api(-demo|-testnet)?\./, (_m, suffix: string | undefined) => `stream${suffix ?? ""}.`);
}

const INTERVAL_TO_RES = new Map<string, Resolution>(Object.entries(KLINE_INTERVALS).map(([res, iv]) => [iv!, res as Resolution]));

interface TickerState {
  bid: number | null;
  ask: number | null;
  last: number | null;
}

/** One public socket per category (Bybit splits public streams by category). */
class PublicChannel {
  readonly status = new StatusTracker();
  private readonly topics = new Set<string>();
  readonly socket: ManagedSocket;

  constructor(
    category: Category,
    host: string,
    onMessage: (msg: BybitMessage) => void,
  ) {
    this.socket = new ManagedSocket({
      name: `bybit-public-${category}`,
      url: `wss://${host}/v5/public/${category}`,
      pingIntervalMs: PING_MS,
      ping: () => JSON.stringify({ op: "ping" }),
      idleTimeoutMs: IDLE_MS,
      status: this.status,
      onOpen: (send) => {
        // Resubscribe everything after a (re)connect, in batches of 10 (Bybit's per-request limit).
        const all = [...this.topics];
        for (let i = 0; i < all.length; i += 10) send(JSON.stringify({ op: "subscribe", args: all.slice(i, i + 10) }));
      },
      onMessage: (raw) => onMessage(JSON.parse(raw) as BybitMessage),
    });
  }

  add(topic: string): void {
    this.topics.add(topic);
    if (this.topics.size === 1) this.socket.start();
    else this.socket.send(JSON.stringify({ op: "subscribe", args: [topic] }));
  }

  remove(topic: string): void {
    this.topics.delete(topic);
    if (this.topics.size === 0) this.socket.stop();
    else this.socket.send(JSON.stringify({ op: "unsubscribe", args: [topic] }));
  }

  get topicCount(): number {
    return this.topics.size;
  }
}

interface BybitMessage {
  op?: string;
  success?: boolean;
  ret_msg?: string;
  topic?: string;
  type?: string;
  ts?: number;
  data?: unknown;
}

interface RawKline {
  start: number;
  end: number;
  interval: string;
  open: string;
  close: string;
  high: string;
  low: string;
  volume: string;
  confirm: boolean;
}

interface RawTickerMsg {
  symbol?: string;
  bid1Price?: string;
  ask1Price?: string;
  bidPrice?: string;
  askPrice?: string;
  lastPrice?: string;
}

export class BybitStream implements PlatformStream {
  readonly candleResolutions: Resolution[] = [...INTERVAL_TO_RES.values()];

  private readonly channels = new Map<Category, PublicChannel>();
  private readonly ticks = new Topics<Tick>();
  private readonly candles = new Topics<CandleUpdate>();
  private readonly tickerState = new Map<string, TickerState>();

  private readonly account = new Topics<AccountEvent>();
  private readonly privateStatus = new StatusTracker();
  private privateSocket: ManagedSocket | null = null;

  constructor(private readonly o: BybitStreamOptions) {}

  private channel(category: Category): PublicChannel {
    let ch = this.channels.get(category);
    if (!ch) {
      ch = new PublicChannel(category, this.o.publicHost, (msg) => this.onPublic(category, msg));
      this.channels.set(category, ch);
    }
    return ch;
  }

  subscribeTicks(id: string, cb: (t: Tick) => void): Unsubscribe {
    const { category, symbol } = parseInstrumentId(id);
    const topic = `tickers.${symbol}`;
    const key = `${category}|${topic}`;
    return this.ticks.add(
      key,
      cb,
      () => this.channel(category).add(topic),
      () => {
        this.tickerState.delete(key);
        this.channel(category).remove(topic);
      },
    );
  }

  subscribeCandles(id: string, resolution: Resolution, cb: (c: CandleUpdate) => void): Unsubscribe {
    const { category, symbol } = parseInstrumentId(id);
    const interval = KLINE_INTERVALS[resolution];
    if (!interval) throw new Error(`Bybit does not stream ${resolution} candles.`);
    if (category === "option") throw new Error("Bybit has no candle stream for options.");
    const topic = `kline.${interval}.${symbol}`;
    return this.candles.add(
      `${category}|${topic}`,
      cb,
      () => this.channel(category).add(topic),
      () => this.channel(category).remove(topic),
    );
  }

  subscribeAccount(cb: (e: AccountEvent) => void): Unsubscribe {
    return this.account.add(
      "account",
      cb,
      () => this.privateSocketFor().start(),
      () => this.privateSocket?.stop(),
    );
  }

  status(): StreamStatus {
    const subs = [
      ...this.ticks.keys().map((k) => `ticks ${k.replace("|tickers.", ":")}`),
      ...this.candles.keys().map((k) => {
        const [category, topic] = k.split("|");
        const [, interval, symbol] = (topic ?? "").split(".");
        return `candles ${INTERVAL_TO_RES.get(interval ?? "") ?? interval} ${category}:${symbol}`;
      }),
      ...(this.account.size ? ["account events"] : []),
    ];
    const trackers = [...[...this.channels.values()].filter((c) => c.topicCount > 0).map((c) => c.status), ...(this.account.size ? [this.privateStatus] : [])];
    if (trackers.length === 0) return new StatusTracker().snapshot(subs);
    const merged = new StatusTracker();
    merged.connected = trackers.every((t) => t.connected);
    merged.since = Math.max(...trackers.map((t) => t.since ?? 0)) || null;
    merged.lastMessageAt = Math.max(...trackers.map((t) => t.lastMessageAt ?? 0)) || null;
    merged.reconnects = trackers.reduce((s, t) => s + t.reconnects, 0);
    merged.error = trackers.map((t) => t.error).find((e) => e) ?? null;
    return merged.snapshot(subs);
  }

  async close(): Promise<void> {
    for (const ch of this.channels.values()) ch.socket.stop();
    this.privateSocket?.stop();
  }

  // --- public messages ------------------------------------------------------

  private onPublic(category: Category, msg: BybitMessage): void {
    if (msg.op) {
      if (msg.op === "subscribe" && msg.success === false) logger.warn("bybit subscribe failed", { category, msg: msg.ret_msg });
      return;
    }
    const topic = msg.topic ?? "";
    if (topic.startsWith("tickers.")) this.onTicker(category, topic, msg);
    else if (topic.startsWith("kline.")) this.onKline(category, topic, msg);
  }

  private onTicker(category: Category, topic: string, msg: BybitMessage): void {
    const key = `${category}|${topic}`;
    const d = (msg.data ?? {}) as RawTickerMsg;
    const prev = msg.type === "snapshot" ? undefined : this.tickerState.get(key);
    // Deltas only carry changed fields; merge them into the last known state.
    const state: TickerState = {
      bid: nz(d.bid1Price ?? d.bidPrice) ?? prev?.bid ?? null,
      ask: nz(d.ask1Price ?? d.askPrice) ?? prev?.ask ?? null,
      last: nz(d.lastPrice) ?? prev?.last ?? null,
    };
    this.tickerState.set(key, state);
    const symbol = topic.slice("tickers.".length);
    this.ticks.emit(key, { instrumentId: instrumentId(category, symbol), time: msg.ts ?? Date.now(), ...state });
  }

  private onKline(category: Category, topic: string, msg: BybitMessage): void {
    const [, interval, symbol] = topic.split(".");
    const resolution = INTERVAL_TO_RES.get(interval ?? "");
    if (!resolution || !symbol) return;
    const key = `${category}|${topic}`;
    for (const k of (msg.data ?? []) as RawKline[]) {
      const candle = {
        t: Number(k.start),
        o: Number(k.open),
        h: Number(k.high),
        l: Number(k.low),
        c: Number(k.close),
        v: nz(k.volume),
        spread: null,
      };
      if (![candle.t, candle.o, candle.h, candle.l, candle.c].every(Number.isFinite)) continue;
      // Bybit marks the last update of a candle with confirm=true.
      const final = k.confirm === true || candle.t + RESOLUTION_MS[resolution] <= (msg.ts ?? 0) - 1000;
      this.candles.emit(key, { instrumentId: instrumentId(category, symbol), resolution, candle, final });
    }
  }

  // --- private stream (orders, executions, positions) ----------------------

  private privateSocketFor(): ManagedSocket {
    if (this.privateSocket) return this.privateSocket;
    let authResolve: (() => void) | null = null;
    let authReject: ((e: Error) => void) | null = null;
    this.privateSocket = new ManagedSocket({
      name: "bybit-private",
      url: this.o.privateUrl,
      // API keys are IP-bound: the private stream must leave through the outbound proxy like REST calls.
      dispatcher: dispatcherFor("bybit"),
      pingIntervalMs: PING_MS,
      ping: () => JSON.stringify({ op: "ping" }),
      idleTimeoutMs: IDLE_MS,
      status: this.privateStatus,
      onOpen: (send) =>
        new Promise<void>((resolve, reject) => {
          if (!this.o.apiKey || !this.o.apiSecret) {
            reject(new Error("Bybit API key/secret missing for the private stream."));
            return;
          }
          const expires = Date.now() + 10_000;
          const signature = createHmac("sha256", this.o.apiSecret).update(`GET/realtime${expires}`).digest("hex");
          authResolve = () => {
            send(JSON.stringify({ op: "subscribe", args: ["order", "execution", "position"] }));
            resolve();
          };
          authReject = reject;
          send(JSON.stringify({ op: "auth", args: [this.o.apiKey, expires, signature] }));
          setTimeout(() => reject(new Error("Bybit private stream: no auth response within 10 s.")), 10_000);
        }),
      onMessage: (raw) => {
        const msg = JSON.parse(raw) as BybitMessage;
        if (msg.op === "auth") {
          if (msg.success) authResolve?.();
          else authReject?.(new Error(`Bybit private stream auth failed: ${msg.ret_msg ?? "unknown error"}`));
          authResolve = null;
          authReject = null;
          return;
        }
        if (msg.op) return;
        this.onPrivate(msg);
      },
    });
    return this.privateSocket;
  }

  private onPrivate(msg: BybitMessage): void {
    const rows = (Array.isArray(msg.data) ? msg.data : []) as (Record<string, unknown> & { category?: string })[];
    for (const row of rows) {
      const category = (row.category ?? "linear") as Category;
      try {
        if (msg.topic === "order") {
          this.account.emit("account", { type: "order", order: mapOrder(category, row as unknown as RawOrder) });
        } else if (msg.topic === "execution") {
          this.account.emit("account", { type: "fill", fill: mapFill(category, row as unknown as RawExecution) });
        } else if (msg.topic === "position") {
          const position = mapPosition(category, row as unknown as RawPosition);
          this.account.emit("account", { type: "position", position, closed: !(position.size > 0) });
        }
      } catch (err) {
        logger.warn("bybit private event could not be mapped", { topic: msg.topic, err: String(err) });
      }
    }
  }
}

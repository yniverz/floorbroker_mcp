import { WebSocket, type Dispatcher } from "undici";
import { logger } from "../logger.js";
import type { StreamStatus, Unsubscribe } from "./types.js";

/** Reference-counted fan-out: several subscribers share one platform topic. */
export class Topics<T> {
  private readonly subs = new Map<string, Set<(v: T) => void>>();

  /** Adds a listener. `onFirst` runs when the topic gains its first listener, `onLast` when it loses its last. */
  add(topic: string, cb: (v: T) => void, onFirst: () => void, onLast: () => void): Unsubscribe {
    let set = this.subs.get(topic);
    const first = !set;
    if (!set) {
      set = new Set();
      this.subs.set(topic, set);
    }
    set.add(cb);
    if (first) onFirst();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const s = this.subs.get(topic);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) {
        this.subs.delete(topic);
        onLast();
      }
    };
  }

  emit(topic: string, value: T): void {
    const set = this.subs.get(topic);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(value);
      } catch (err) {
        logger.warn("stream listener threw", { topic, err: String(err) });
      }
    }
  }

  has(topic: string): boolean {
    return this.subs.has(topic);
  }

  keys(): string[] {
    return [...this.subs.keys()];
  }

  get size(): number {
    return this.subs.size;
  }
}

/** Exponential backoff with jitter: 1 s, 2 s, 4 s … capped at 60 s. */
export class Backoff {
  private attempt = 0;
  next(): number {
    const base = Math.min(60_000, 1000 * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 10);
    return Math.round(base * (0.75 + Math.random() * 0.5));
  }
  reset(): void {
    this.attempt = 0;
  }
}

/** Mutable status shared by the stream implementations. */
export class StatusTracker {
  connected = false;
  since: number | null = null;
  lastMessageAt: number | null = null;
  reconnects = 0;
  error: string | null = null;

  up(): void {
    this.connected = true;
    this.since = Date.now();
    this.error = null;
  }
  down(error: string | null): void {
    if (this.connected) this.reconnects++;
    this.connected = false;
    this.since = null;
    if (error) this.error = error;
  }
  touch(): void {
    this.lastMessageAt = Date.now();
  }
  snapshot(subscriptions: string[]): StreamStatus {
    return {
      connected: this.connected,
      since: this.since,
      lastMessageAt: this.lastMessageAt,
      reconnects: this.reconnects,
      error: this.error,
      subscriptions,
    };
  }
}

export interface ManagedSocketOptions {
  name: string;
  url: string;
  dispatcher?: Dispatcher;
  /** Interval for application-level pings; the payload is sent as-is. */
  pingIntervalMs: number;
  ping: () => string;
  /** Called on every (re)connect before the socket counts as ready; resolve when ready (e.g. after auth). */
  onOpen: (send: (msg: string) => void) => Promise<void> | void;
  onMessage: (data: string) => void;
  /** Called after each disconnect (before reconnecting). */
  onClose?: (reason: string) => void;
  status: StatusTracker;
  /** Considered dead if nothing arrives for this long. */
  idleTimeoutMs?: number;
}

/**
 * A WebSocket that reconnects with backoff until stopped. Callers decide when to start
 * (first subscription) and stop (last unsubscription).
 */
export class ManagedSocket {
  private ws: WebSocket | null = null;
  private running = false;
  private ready = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly backoff = new Backoff();

  constructor(private readonly o: ManagedSocketOptions) {}

  get isReady(): boolean {
    return this.ready;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    if (ws) {
      try {
        ws.close(1000, "done");
      } catch {
        /* ignore */
      }
    }
    this.o.status.down(null);
  }

  send(msg: string): boolean {
    if (!this.ws || !this.ready) return false;
    try {
      this.ws.send(msg);
      return true;
    } catch {
      return false;
    }
  }

  private connect(): void {
    if (!this.running) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.o.url, this.o.dispatcher ? { dispatcher: this.o.dispatcher } : undefined);
    } catch (err) {
      this.scheduleReconnect(`cannot open: ${String(err)}`);
      return;
    }
    this.ws = ws;
    const rawSend = (msg: string) => ws.send(msg);

    ws.addEventListener("open", () => {
      this.o.status.touch();
      Promise.resolve(this.o.onOpen(rawSend))
        .then(() => {
          if (this.ws !== ws) return;
          this.ready = true;
          this.backoff.reset();
          this.o.status.up();
          this.pingTimer = setInterval(() => {
            try {
              ws.send(this.o.ping());
            } catch {
              /* reconnect handles it */
            }
          }, this.o.pingIntervalMs);
          this.armWatchdog(ws);
        })
        .catch((err: unknown) => {
          this.o.status.error = err instanceof Error ? err.message : String(err);
          try {
            ws.close(4000, "open handler failed");
          } catch {
            /* ignore */
          }
        });
    });
    ws.addEventListener("message", (ev) => {
      this.o.status.touch();
      this.armWatchdog(ws);
      const data = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8");
      try {
        this.o.onMessage(data);
      } catch (err) {
        logger.warn("stream message handler failed", { stream: this.o.name, err: String(err) });
      }
    });
    ws.addEventListener("error", (ev) => {
      // undici's WebSocket usually reports no details here; keep whatever it gives.
      const e = ev as unknown as { message?: string; error?: { message?: string; cause?: { message?: string } } };
      const msg = e.error?.cause?.message || e.error?.message || e.message || "";
      if (msg) this.o.status.error = msg;
    });
    ws.addEventListener("close", (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      this.clearTimers();
      const host = new URL(this.o.url).host;
      const reason =
        ev.code === 1006
          ? `connection to ${host}${this.o.dispatcher ? " via the outbound proxy" : ""} failed or dropped (no details; check that the host is reachable${this.o.dispatcher ? " and allowed by the proxy" : ""})`
          : `closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`;
      this.o.onClose?.(reason);
      // Use the error captured during this attempt (if any), then record it via down().
      const cause = this.o.status.error || reason;
      this.o.status.error = null;
      this.scheduleReconnect(cause);
    });
  }

  private armWatchdog(ws: WebSocket): void {
    if (!this.o.idleTimeoutMs) return;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (this.ws !== ws) return;
      this.o.status.error = "no data received (idle timeout)";
      try {
        ws.close(4001, "idle");
      } catch {
        /* ignore */
      }
    }, this.o.idleTimeoutMs);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchdog) clearTimeout(this.watchdog);
    this.pingTimer = null;
    this.watchdog = null;
  }

  private scheduleReconnect(reason: string): void {
    this.o.status.down(reason);
    if (!this.running) return;
    const delay = this.backoff.next();
    logger.info("stream disconnected, reconnecting", { stream: this.o.name, reason, delayMs: delay });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }
}

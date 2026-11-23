import { Pool, ProxyAgent, fetch as undiciFetch } from "undici";
import { PlatformError } from "./errors.js";
import { socks5Connect } from "./socks.js";

// --- outbound proxy -------------------------------------------------------------
// Some platforms bind API keys to fixed IPs (Bybit). OUTBOUND_PROXY routes the
// requests of selected platforms through an HTTP proxy with a static public IP.
// OUTBOUND_PROXY_VIA (socks5://host:port) optionally reaches that proxy through a
// SOCKS5 server, e.g. a NetBird sidecar in userspace (netstack) mode.

let proxy: { url: string; agent: ProxyAgent; platforms: Set<string> } | null = null;

export function configureOutboundProxy(url: string | null, platforms: string[], via: string | null = null): void {
  if (!url) {
    proxy = null;
    return;
  }
  let agent: ProxyAgent;
  if (via) {
    const v = new URL(via);
    if (v.protocol !== "socks5:" && v.protocol !== "socks5h:") throw new Error("OUTBOUND_PROXY_VIA must be a socks5:// URL");
    const socksHost = v.hostname;
    const socksPort = Number(v.port || 1080);
    agent = new ProxyAgent({
      uri: url,
      // The connection to the HTTP proxy itself is opened through SOCKS5.
      clientFactory: (origin, opts) =>
        new Pool(origin, {
          ...opts,
          connect: (o, cb) => {
            socks5Connect(socksHost, socksPort, o.hostname, Number(o.port) || 80).then(
              (s) => cb(null, s),
              (e: Error) => cb(e, null),
            );
          },
        }),
    });
  } else {
    agent = new ProxyAgent(url);
  }
  proxy = { url, agent, platforms: new Set(platforms.map((p) => p.toLowerCase())) };
}

export function usesProxy(platform: string | undefined): boolean {
  return !!proxy && !!platform && (proxy.platforms.has("*") || proxy.platforms.has(platform.toLowerCase()));
}

/** Proxy URL without credentials, for display. */
export function proxyLabel(): string | null {
  if (!proxy) return null;
  const u = new URL(proxy.url);
  return `${u.protocol}//${u.host}`;
}

/**
 * fetch with a timeout that maps network failures to PlatformError("network").
 * Pass `platform` so requests are routed through OUTBOUND_PROXY when configured for it.
 */
export async function httpFetch(url: string, init: RequestInit & { timeoutMs?: number; platform?: string } = {}): Promise<Response> {
  const { timeoutMs = 15_000, platform, ...rest } = init;
  try {
    if (usesProxy(platform)) {
      const res = await undiciFetch(url, {
        ...(rest as Parameters<typeof undiciFetch>[1]),
        dispatcher: proxy!.agent,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res as unknown as Response;
    }
    return await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
    const msg = (err instanceof Error ? err.message : String(err)) + cause;
    const via = usesProxy(platform) ? ` via outbound proxy ${proxyLabel()}` : "";
    throw new PlatformError("network", `Could not reach ${new URL(url).host}${via}: ${msg}`);
  }
}

const egressCache = new Map<string, { ip: string | null; error: string | null; at: number }>();

/** Public IP the given platform sees for this server (through the proxy if one applies). Cached 10 min. */
export async function egressIp(platform: string): Promise<{ ip: string | null; error: string | null; viaProxy: boolean }> {
  const key = usesProxy(platform) ? `proxy:${proxy!.url}` : "direct";
  const viaProxy = usesProxy(platform);
  const hit = egressCache.get(key);
  if (hit && Date.now() - hit.at < 600_000) return { ip: hit.ip, error: hit.error, viaProxy };
  let ip: string | null = null;
  let error: string | null = null;
  try {
    const res = await httpFetch("https://checkip.amazonaws.com/", { platform, timeoutMs: 8000 });
    const text = (await res.text()).trim();
    if (res.ok && /^[0-9a-f.:]{3,45}$/i.test(text)) ip = text;
    else error = `unexpected answer (HTTP ${res.status})`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  egressCache.set(key, { ip, error, at: Date.now() });
  return { ip, error, viaProxy };
}

/**
 * Simple sliding-window limiter: at most `limit` calls per `windowMs`.
 * `acquire()` waits until a slot is free (up to maxWaitMs, then throws rate_limited).
 */
export class RateLimiter {
  private stamps: number[] = [];
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxWaitMs = 20_000,
  ) {}

  async acquire(): Promise<void> {
    const deadline = Date.now() + this.maxWaitMs;
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => t > now - this.windowMs);
      if (this.stamps.length < this.limit) {
        this.stamps.push(now);
        return;
      }
      const wait = this.stamps[0]! + this.windowMs - now + 5;
      if (now + wait > deadline) {
        throw new PlatformError("rate_limited", "Local rate limit for this platform account reached. Retry in a minute.");
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function numOr(v: unknown, fallback: number): number {
  return num(v) ?? fallback;
}

/** Round to the number of decimals implied by a step (avoids float artifacts like 0.30000000000000004). */
export function formatToStep(value: number, step: number | null): string {
  if (!step || step <= 0) return String(value);
  const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  const rounded = Math.round(value / step) * step;
  return rounded.toFixed(Math.min(decimals, 12));
}

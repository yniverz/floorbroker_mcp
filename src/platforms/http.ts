import { PlatformError } from "./errors.js";

/** fetch with a timeout that maps network failures to PlatformError("network"). */
export async function httpFetch(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 15_000, ...rest } = init;
  try {
    return await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PlatformError("network", `Could not reach ${new URL(url).host}: ${msg}`);
  }
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

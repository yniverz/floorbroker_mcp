import { createHmac } from "node:crypto";
import { PlatformError, type PlatformErrorCode } from "../errors.js";
import { httpFetch, RateLimiter } from "../http.js";

/** Signed + public HTTP client for the Bybit v5 REST API. */

export const RECV_WINDOW = "10000";

export type Params = Record<string, string | number | boolean | undefined | null>;

interface Envelope<T> {
  retCode: number;
  retMsg: string;
  result: T;
  retExtInfo?: unknown;
  time?: number;
}

export interface BybitResponse<T> {
  result: T;
  time: number;
}

/** Error codes Bybit uses for "not enough money". */
const INSUFFICIENT_FUNDS = new Set([
  110004, 110006, 110007, 110012, 110014, 110044, 110045, 110052, 170131, 170033, 170034, 170136, 3100326,
]);
const AUTH_FAILED = new Set([10003, 10004, 10007, 33004]);
const NOT_FOUND = new Set([110001, 170213, 110025]);
const RATE_LIMITED = new Set([10006, 10018, 10429]);

function mapRetCode(retCode: number, retMsg: string, path: string): PlatformError {
  const msg = retMsg || "no message";
  const tag = `Bybit ${path} failed (retCode ${retCode}): ${msg}`;
  let code: PlatformErrorCode;
  let hint = "";
  if (AUTH_FAILED.has(retCode)) {
    code = "auth_failed";
    hint =
      " Check the API key/secret, that the key has not expired, and that it belongs to the selected environment and region (demo keys only work in Demo, testnet keys only on testnet).";
  } else if (retCode === 10005) {
    code = "permission_denied";
    hint = " The API key lacks the permission for this action; edit the key on Bybit and grant it (never grant withdrawal).";
  } else if (retCode === 10010) {
    code = "permission_denied";
    hint = " The request IP is not in the API key's IP whitelist.";
  } else if (retCode === 10009) {
    code = "permission_denied";
    hint = " Bybit has banned this IP temporarily.";
  } else if (RATE_LIMITED.has(retCode)) {
    code = "rate_limited";
    hint = " Wait a few seconds and retry.";
  } else if (INSUFFICIENT_FUNDS.has(retCode)) {
    code = "insufficient_funds";
    hint = " Reduce the size or free up margin.";
  } else if (NOT_FOUND.has(retCode)) {
    code = "not_found";
  } else if (retCode === 10001) {
    code = "invalid_request";
    if (/position ?idx/i.test(msg)) {
      hint = " The account's position mode does not match: in hedge mode pass positionSide (long/short), in one-way mode omit it.";
    }
  } else if (retCode === 10002) {
    code = "platform_error";
    hint = " The server clock differs from Bybit's; check the host's NTP sync.";
  } else if (retCode < 20000) {
    // 10xxx are system-level codes (server error, service restarting, ...).
    code = "platform_error";
  } else {
    code = "rejected";
  }
  return new PlatformError(code, tag + hint, { retCode, retMsg });
}

/** Query string exactly as Bybit expects it (and signs it): raw `k=v` pairs, no re-encoding (cursors arrive pre-encoded). */
export function buildQuery(params: Params): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("&");
}

export interface BybitHttpOptions {
  /** Host for private (signed) requests, e.g. "api.bybit.com". */
  host: string;
  /** Host for public market data. */
  publicHost: string;
  apiKey: string;
  apiSecret: string;
}

export class BybitHttp {
  private timeOffset = 0;
  private readonly privateLimiter = new RateLimiter(10, 1000, 60_000);
  private readonly publicLimiter = new RateLimiter(20, 1000, 60_000);

  constructor(private readonly opts: BybitHttpOptions) {}

  get host(): string {
    return this.opts.host;
  }

  get publicHost(): string {
    return this.opts.publicHost;
  }

  async publicGet<T>(path: string, params: Params = {}): Promise<BybitResponse<T>> {
    await this.publicLimiter.acquire();
    const qs = buildQuery(params);
    const url = `https://${this.opts.publicHost}${path}${qs ? `?${qs}` : ""}`;
    const res = await httpFetch(url, { method: "GET", headers: { Accept: "application/json" } });
    const env = await this.parse<T>(res, path, this.opts.publicHost);
    if (env.retCode !== 0) throw mapRetCode(env.retCode, env.retMsg, path);
    return { result: env.result, time: env.time ?? Date.now() };
  }

  async privateGet<T>(path: string, params: Params = {}): Promise<BybitResponse<T>> {
    return this.signed<T>("GET", path, buildQuery(params));
  }

  async privatePost<T>(path: string, body: Record<string, unknown>): Promise<BybitResponse<T>> {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null) clean[k] = v;
    return this.signed<T>("POST", path, JSON.stringify(clean));
  }

  /** POST that also returns the raw retCode instead of throwing for the listed "harmless" codes. */
  async privatePostAllow<T>(
    path: string,
    body: Record<string, unknown>,
    allow: number[],
  ): Promise<{ retCode: number; retMsg: string; result: T | null }> {
    try {
      const r = await this.privatePost<T>(path, body);
      return { retCode: 0, retMsg: "OK", result: r.result };
    } catch (err) {
      if (err instanceof PlatformError && typeof err.details?.retCode === "number" && allow.includes(err.details.retCode)) {
        return { retCode: err.details.retCode, retMsg: String(err.details.retMsg ?? ""), result: null };
      }
      throw err;
    }
  }

  private async signed<T>(method: "GET" | "POST", path: string, payload: string, retried = false): Promise<BybitResponse<T>> {
    if (!this.opts.apiKey || !this.opts.apiSecret) {
      throw new PlatformError("auth_failed", "Bybit API key and secret are required for this action.");
    }
    await this.privateLimiter.acquire();
    const timestamp = String(Date.now() + this.timeOffset);
    const sign = createHmac("sha256", this.opts.apiSecret)
      .update(timestamp + this.opts.apiKey + RECV_WINDOW + payload)
      .digest("hex");
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-BAPI-API-KEY": this.opts.apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-SIGN": sign,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
    };
    let url = `https://${this.opts.host}${path}`;
    const init: RequestInit = { method, headers };
    if (method === "GET") {
      if (payload) url += `?${payload}`;
    } else {
      headers["Content-Type"] = "application/json";
      init.body = payload;
    }
    const res = await httpFetch(url, init);
    const env = await this.parse<T>(res, path, this.opts.host);
    if (env.retCode === 10002 && !retried) {
      await this.syncTime();
      return this.signed<T>(method, path, payload, true);
    }
    if (env.retCode !== 0) throw mapRetCode(env.retCode, env.retMsg, path);
    return { result: env.result, time: env.time ?? Date.now() };
  }

  /** Learn the offset between the local clock and Bybit's server time. */
  async syncTime(): Promise<void> {
    const before = Date.now();
    const res = await httpFetch(`https://${this.opts.host}/v5/market/time`, { method: "GET" });
    const env = await this.parse<{ timeNano?: string; timeSecond?: string }>(res, "/v5/market/time", this.opts.host);
    const after = Date.now();
    const server = env.time ?? (env.result?.timeSecond ? Number(env.result.timeSecond) * 1000 : NaN);
    if (Number.isFinite(server)) {
      // Aim slightly behind server time: Bybit rejects timestamps more than 1 s ahead.
      this.timeOffset = Math.round(server - (before + after) / 2) - 500;
    }
  }

  private async parse<T>(res: Response, path: string, host: string): Promise<Envelope<T>> {
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (body && typeof body === "object" && "retCode" in body) {
      return body as Envelope<T>;
    }
    if (res.status === 403 || res.status === 429) {
      throw new PlatformError(
        "rate_limited",
        `Bybit (${host}) answered HTTP ${res.status} for ${path}. This usually means the IP is rate-limited/banned for a while or the region blocks this IP. Wait a few minutes and retry.`,
      );
    }
    if (res.status === 401) {
      throw new PlatformError("auth_failed", `Bybit (${host}) answered HTTP 401 for ${path}: check the API key and secret.`);
    }
    if (res.status === 404) {
      throw new PlatformError("unsupported", `Bybit host ${host} does not provide ${path} (HTTP 404). This region or environment may not offer it.`);
    }
    throw new PlatformError(
      "platform_error",
      `Bybit (${host}) returned an unexpected response for ${path} (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }
}

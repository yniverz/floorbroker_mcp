/**
 * IG REST session handling and HTTP plumbing.
 *
 * - One IG session (CST + X-SECURITY-TOKEN) per client instance, reused across calls.
 * - Logins are serialized (one in flight); a request that fails with 401 / an invalid
 *   token is retried once after a fresh login.
 * - Rate limiters are shared per (environment, API key) because IG's app limit is per key.
 */
import { createHash } from "node:crypto";
import { PlatformError } from "../errors.js";
import { httpFetch, RateLimiter } from "../http.js";
import type { EnvironmentId } from "../types.js";

export const IG_BASE_URLS: Record<string, string> = {
  live: "https://api.ig.com/gateway/deal",
  demo: "https://demo-api.ig.com/gateway/deal",
};

/** IG sessions expire after 6 h without use; log in again a bit earlier. */
const SESSION_IDLE_MS = 5.5 * 60 * 60 * 1000;

export function sha16(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

interface Limiters {
  nonTrading: RateLimiter;
  trading: RateLimiter;
}

/**
 * IG documents roughly: 60 non-trading req/min per app key, 30 non-trading req/min per
 * account, 100 trading req/min per account. We stay well below with 25 / 90 per key.
 */
const LIMITERS = new Map<string, Limiters>();

function limitersFor(apiKey: string, env: string): Limiters {
  const key = `${env}:${sha16(apiKey)}`;
  let l = LIMITERS.get(key);
  if (!l) {
    l = { nonTrading: new RateLimiter(25, 60_000, 45_000), trading: new RateLimiter(90, 60_000, 30_000) };
    LIMITERS.set(key, l);
  }
  return l;
}

export interface IgCredentials {
  username: string;
  password: string;
  apiKey: string;
}

export interface IgAccountRef {
  accountId: string;
  accountName: string | null;
  accountType: string | null;
  preferred: boolean;
}

export interface IgSession {
  cst: string;
  xst: string;
  accountId: string;
  accountType: string | null;
  accounts: IgAccountRef[];
  trailingStopsEnabled: boolean | null;
  lastUsed: number;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface IgRequest {
  method?: HttpMethod;
  /** Path below /gateway/deal, starting with "/". */
  path: string;
  /** IG "Version" header for this endpoint. */
  version: number;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  /** Counts against the trading limiter (deal submissions). */
  trading?: boolean;
  /** Send as POST with header `_method: DELETE` (IG's way of passing a body with DELETE). */
  deleteViaPost?: boolean;
  timeoutMs?: number;
}

export function describeAccounts(accounts: IgAccountRef[]): string {
  return accounts
    .map((a) => `${a.accountId} (${a.accountType ?? "?"}${a.accountName ? `, "${a.accountName}"` : ""}${a.preferred ? ", preferred" : ""})`)
    .join(", ");
}

export class IgHttp {
  private session: IgSession | null = null;
  private loginInFlight: Promise<IgSession> | null = null;
  private readonly baseUrl: string;
  private readonly limiters: Limiters;
  private readonly env: EnvironmentId;

  constructor(
    env: EnvironmentId,
    private readonly creds: IgCredentials,
    private readonly targetAccountId: string | null,
  ) {
    this.env = env;
    this.baseUrl = IG_BASE_URLS[env] ?? "";
    this.limiters = limitersFor(creds.apiKey, env);
  }

  /** Current session, logging in if needed. */
  async getSession(): Promise<IgSession> {
    const s = this.session;
    if (s && Date.now() - s.lastUsed < SESSION_IDLE_MS) return s;
    return this.login();
  }

  /** Force a fresh login (serialized: concurrent callers share one attempt). */
  login(): Promise<IgSession> {
    if (!this.loginInFlight) {
      this.loginInFlight = this.doLogin().finally(() => {
        this.loginInFlight = null;
      });
    }
    return this.loginInFlight;
  }

  logout(): void {
    this.session = null;
  }

  private baseHeaders(version: number): Record<string, string> {
    return {
      Accept: "application/json; charset=UTF-8",
      "Content-Type": "application/json; charset=UTF-8",
      "X-IG-API-KEY": this.creds.apiKey,
      Version: String(version),
    };
  }

  private async doLogin(): Promise<IgSession> {
    this.session = null;
    if (!this.baseUrl) {
      throw new PlatformError("invalid_request", `IG has no "${this.env}" environment; use "live" or "demo".`);
    }
    if (!this.creds.username || !this.creds.password || !this.creds.apiKey) {
      throw new PlatformError("auth_failed", "IG credentials are incomplete: username, password and API key are required.");
    }
    await this.limiters.nonTrading.acquire();
    const res = await httpFetch(`${this.baseUrl}/session`, {
      method: "POST",
      headers: this.baseHeaders(2),
      body: JSON.stringify({ identifier: this.creds.username, password: this.creds.password }),
    });
    const body = (await readJson(res)) as LoginResponse;
    if (!res.ok) throw mapIgError(res.status, errorCodeOf(body));

    let cst = res.headers.get("CST");
    let xst = res.headers.get("X-SECURITY-TOKEN");
    if (!cst || !xst) {
      throw new PlatformError("platform_error", "IG login succeeded but returned no session tokens (CST / X-SECURITY-TOKEN).");
    }

    const accounts: IgAccountRef[] = (body.accounts ?? []).map((a) => ({
      accountId: String(a.accountId ?? ""),
      accountName: a.accountName ?? null,
      accountType: a.accountType ?? null,
      preferred: a.preferred === true,
    }));
    let accountId = String(body.currentAccountId ?? "");
    let accountType = accounts.find((a) => a.accountId === accountId)?.accountType ?? body.accountType ?? null;

    const target = this.targetAccountId;
    if (target && target !== accountId) {
      const match = accounts.find((a) => a.accountId.toUpperCase() === target.toUpperCase());
      if (!match && accounts.length > 0) {
        throw new PlatformError(
          "invalid_request",
          `Account id "${target}" is not part of this IG login. Available accounts: ${describeAccounts(accounts)}.`,
        );
      }
      const targetId = match?.accountId ?? target;
      await this.limiters.nonTrading.acquire();
      const sw = await httpFetch(`${this.baseUrl}/session`, {
        method: "PUT",
        headers: { ...this.baseHeaders(1), CST: cst, "X-SECURITY-TOKEN": xst },
        body: JSON.stringify({ accountId: targetId, defaultAccount: false }),
      });
      const swBody = await readJson(sw);
      if (!sw.ok) {
        const code = errorCodeOf(swBody);
        if (code !== "error.switch.accountId-must-be-different") throw mapIgError(sw.status, code);
      }
      // IG may rotate the tokens on an account switch.
      cst = sw.headers.get("CST") ?? cst;
      xst = sw.headers.get("X-SECURITY-TOKEN") ?? xst;
      accountId = targetId;
      accountType = match?.accountType ?? null;
    }

    const session: IgSession = {
      cst,
      xst,
      accountId,
      accountType,
      accounts,
      trailingStopsEnabled: typeof body.trailingStopsEnabled === "boolean" ? body.trailingStopsEnabled : null,
      lastUsed: Date.now(),
    };
    this.session = session;
    return session;
  }

  /** Authenticated request; re-logs in once on 401 / invalid token. */
  async request<T>(req: IgRequest): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const session = await this.getSession();
      await (req.trading ? this.limiters.trading : this.limiters.nonTrading).acquire();

      const url = new URL(this.baseUrl + req.path);
      for (const [k, v] of Object.entries(req.query ?? {})) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      }
      const headers: Record<string, string> = {
        ...this.baseHeaders(req.version),
        CST: session.cst,
        "X-SECURITY-TOKEN": session.xst,
      };
      let method: HttpMethod = req.method ?? "GET";
      if (req.deleteViaPost) {
        headers["_method"] = "DELETE";
        method = "POST";
      }
      const res = await httpFetch(url.toString(), {
        method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        timeoutMs: req.timeoutMs,
      });
      const body = await readJson(res);
      if (res.ok) {
        session.lastUsed = Date.now();
        return body as T;
      }
      const code = errorCodeOf(body);
      if (attempt === 0 && isSessionError(res.status, code)) {
        if (this.session === session) this.session = null;
        continue;
      }
      throw mapIgError(res.status, code);
    }
  }
}

interface LoginResponse {
  currentAccountId?: string;
  accountType?: string;
  trailingStopsEnabled?: boolean;
  accounts?: { accountId?: string; accountName?: string; accountType?: string; preferred?: boolean }[];
  errorCode?: string;
}

async function readJson(res: Response): Promise<unknown> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    return {};
  }
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

function errorCodeOf(body: unknown): string | null {
  if (body && typeof body === "object" && "errorCode" in body) {
    const c = (body as { errorCode?: unknown }).errorCode;
    if (typeof c === "string" && c) return c;
  }
  return null;
}

function isSessionError(status: number, code: string | null): boolean {
  if (status === 401) return true;
  const c = code ?? "";
  return c.includes("client-token-invalid") || c.includes("oauth-token-invalid") || c.includes("client-token-missing");
}

/** Map an IG error response to a PlatformError. The IG errorCode is always part of the message. */
export function mapIgError(status: number, code: string | null): PlatformError {
  const c = code ?? "";
  const tag = code ? ` (IG error ${code})` : ` (HTTP ${status})`;
  const details = { igErrorCode: code, status };
  const mk = (pc: ConstructorParameters<typeof PlatformError>[0], msg: string) => new PlatformError(pc, msg + tag, details);

  if (c === "error.security.invalid-details") {
    return mk("auth_failed", "IG rejected the username or password. Demo and live use separate logins; check you use the right one for this environment.");
  }
  if (/api-?key/i.test(c)) {
    return mk("auth_failed", "IG rejected the API key. Check it in My IG → Settings → API keys; a demo account needs an API key created while logged in to the demo account.");
  }
  if (c.includes("too-many-failed-attempts")) {
    return mk("auth_failed", "Too many failed login attempts; IG has temporarily blocked logins. Wait before retrying and check the password.");
  }
  if (c.includes("pending.agreements")) {
    return mk("auth_failed", "IG requires you to accept updated agreements. Log in to the IG web platform once and accept them.");
  }
  if (c.includes("suspended") || c.includes("disabled")) {
    return mk("permission_denied", "The IG account or client is suspended or disabled for API use. Contact IG or pick another account.");
  }
  if (/exceeded-.*allowance/.test(c)) {
    if (c.includes("historical-data")) {
      return mk("rate_limited", "IG's weekly historical price data allowance is used up. Use cached candles or wait until the allowance resets (see getQuota).");
    }
    if (c.includes("trading")) {
      return mk("rate_limited", "IG's per-account trading request limit was hit. Wait a minute before placing more orders.");
    }
    return mk("rate_limited", "IG's request rate limit (per API key / per account) was hit. Wait a minute and retry.");
  }
  if (c.startsWith("error.security.")) {
    return mk("auth_failed", "IG authentication failed. Check the credentials for this environment.");
  }
  if (/epic/i.test(c) || (/instrument/i.test(c) && /unavailable|not.?found|invalid/i.test(c))) {
    return mk("not_found", "Unknown or unavailable IG epic. Use searchInstruments to find the epic; CFD and spread bet accounts use different epics.");
  }
  if (/market.?closed|market-offline|market\.offline|closed/i.test(c)) {
    return mk("market_closed", "The market is closed. Check the instrument's trading hours.");
  }
  if (/insufficient|funds/i.test(c)) {
    return mk("insufficient_funds", "Insufficient funds / margin for this deal.");
  }
  if (status === 404 || /not.?found/i.test(c)) {
    return mk("not_found", "IG could not find the requested item.");
  }
  if (status === 403) {
    return mk("permission_denied", "IG refused the request for this account / API key.");
  }
  if (status === 429) {
    return mk("rate_limited", "IG rate limit hit. Wait a minute and retry.");
  }
  if (status >= 500) {
    return mk("platform_error", "IG server error. Retry later.");
  }
  if (status >= 400) {
    return mk("invalid_request", "IG rejected the request as invalid. Check sizes, levels, epic and expiry.");
  }
  return mk("platform_error", "Unexpected IG response.");
}

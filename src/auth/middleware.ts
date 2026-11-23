import type { NextFunction, Request, Response } from "express";
import type { AppContext } from "../context.js";
import type { UserRow, WebSessionRow } from "../repos/users.js";
import { safeEqual } from "../util/crypto.js";
import { errorPage } from "../web/layout.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      webUser?: UserRow;
      webSession?: WebSessionRow;
      csrfToken?: string;
    }
  }
}

export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-fb_session" : "fb_session";
}

export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name || name in out) continue;
    const value = part.slice(idx + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function setSessionCookie(res: Response, secure: boolean, value: string, maxAgeMs: number): void {
  res.cookie(sessionCookieName(secure), value, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: maxAgeMs });
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  res.clearCookie(sessionCookieName(secure), { httpOnly: true, secure, sameSite: "lax", path: "/" });
}

export function attachWebSession(ctx: AppContext) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const raw = parseCookies(req)[sessionCookieName(ctx.config.cookieSecure)];
    if (!raw) return next();
    const session = ctx.webSessions.findByToken(raw);
    const now = Date.now();
    if (!session || session.revoked_at !== null || session.absolute_exp <= now || session.last_seen_at + ctx.config.webSessionIdleTtlMs <= now) {
      clearSessionCookie(res, ctx.config.cookieSecure);
      return next();
    }
    const user = ctx.users.findById(session.user_id);
    if (!user || user.is_active !== 1) {
      ctx.webSessions.revoke(session.id);
      clearSessionCookie(res, ctx.config.cookieSecure);
      return next();
    }
    if (now - session.last_seen_at > 60_000) ctx.webSessions.touch(session.id);
    req.webSession = session;
    req.webUser = user;
    req.csrfToken = session.csrf_secret;
    next();
  };
}

export function requireLogin(req: Request, res: Response, next: NextFunction): void {
  if (!req.webUser) {
    const target = req.originalUrl.startsWith("/") ? req.originalUrl : "/";
    res.redirect(`/login?next=${encodeURIComponent(target)}`);
    return;
  }
  if (req.webUser.must_change_password === 1 && !req.path.startsWith("/account/password") && req.path !== "/logout") {
    res.redirect("/account/password");
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.webUser || req.webUser.role !== "admin") {
    errorPage(res, req, 404, "Not found", "That page does not exist.");
    return;
  }
  next();
}

/** CSRF check for every state-changing request from the web UI. */
export function verifyCsrf(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const expected = req.webSession?.csrf_secret;
  const body = req.body as Record<string, unknown> | undefined;
  const presented = typeof body?._csrf === "string" ? body._csrf : undefined;
  if (!expected || !presented || !safeEqual(expected, presented)) {
    errorPage(res, req, 403, "Request rejected", "Security check failed. Reload the page and try again.");
    return;
  }
  next();
}

/** Only allows redirects to local paths. */
export function safeNext(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value.slice(0, 2000);
}

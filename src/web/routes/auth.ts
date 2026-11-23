import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { clearSessionCookie, parseCookies, safeNext, setSessionCookie, verifyCsrf } from "../../auth/middleware.js";
import { dummyVerify, verifyPassword } from "../../auth/password.js";
import type { AppContext } from "../../context.js";
import { randomToken, safeEqual } from "../../util/crypto.js";
import { html } from "../html.js";
import { errorPage, send } from "../layout.js";

const LOGIN_CSRF_COOKIE = "fb_lcsrf";

function loginForm(req: Request, res: Response, status: number, token: string, next: string, error?: string): void {
  send(
    res,
    status,
    { title: "Sign in", bare: true, flash: error ? { kind: "error", text: error } : null },
    html`<section class="card">
      <h1>Sign in</h1>
      <form method="post" action="/login" class="stack">
        <input type="hidden" name="_csrf" value="${token}" />
        <input type="hidden" name="next" value="${next}" />
        <label>Username <input type="text" name="username" autocomplete="username" required autofocus /></label>
        <label>Password <input type="password" name="password" autocomplete="current-password" required /></label>
        <div class="actions"><button class="primary" type="submit">Sign in</button></div>
      </form>
    </section>`,
  );
}

export function authRouter(ctx: AppContext): Router {
  const router = Router();
  const limiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: ctx.config.rateLimit.loginPer15Min,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: "Too many sign-in attempts. Try again later.",
  });

  router.get("/login", (req, res) => {
    if (req.webUser) return res.redirect(safeNext(req.query.next));
    const token = randomToken(24);
    res.cookie(LOGIN_CSRF_COOKIE, token, { httpOnly: true, secure: ctx.config.cookieSecure, sameSite: "lax", path: "/", maxAge: 15 * 60_000 });
    loginForm(req, res, 200, token, safeNext(req.query.next));
  });

  router.post("/login", limiter, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cookieToken = parseCookies(req)[LOGIN_CSRF_COOKIE];
    const formToken = typeof body._csrf === "string" ? body._csrf : "";
    if (!cookieToken || !formToken || !safeEqual(cookieToken, formToken)) {
      return errorPage(res, req, 403, "Request rejected", "Security check failed. Reload the sign-in page and try again.");
    }
    const username = typeof body.username === "string" ? body.username.trim().slice(0, 64) : "";
    const password = typeof body.password === "string" ? body.password.slice(0, 256) : "";
    const next = safeNext(body.next);
    const fail = (msg = "Invalid credentials.") => {
      ctx.activity.audit({ userId: null, action: "auth.login.failed", detail: { username }, ip: req.ip });
      loginForm(req, res, 401, cookieToken, next, msg);
    };

    const user = username ? ctx.users.findByUsername(username) : undefined;
    if (!user || user.is_active !== 1 || !password) {
      await dummyVerify();
      return fail();
    }
    if (ctx.users.isLocked(user)) {
      await dummyVerify();
      return fail("This account is temporarily locked. Try again later.");
    }
    if (!(await verifyPassword(password, user.password_hash))) {
      ctx.users.registerFailedLogin(user.id, ctx.config.lockout.threshold, ctx.config.lockout.minutes);
      return fail();
    }
    ctx.users.registerSuccessfulLogin(user.id);
    const session = ctx.webSessions.create({
      userId: user.id,
      ip: req.ip ?? null,
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
      absoluteTtlMs: ctx.config.webSessionAbsoluteTtlMs,
    });
    res.clearCookie(LOGIN_CSRF_COOKIE, { path: "/", httpOnly: true, secure: ctx.config.cookieSecure, sameSite: "lax" });
    setSessionCookie(res, ctx.config.cookieSecure, session.token, ctx.config.webSessionAbsoluteTtlMs);
    ctx.activity.audit({ userId: user.id, action: "auth.login.success", ip: req.ip });
    res.redirect(user.must_change_password === 1 ? `/account/password?next=${encodeURIComponent(next)}` : next);
  });

  router.post("/logout", verifyCsrf, (req, res) => {
    if (req.webSession) ctx.webSessions.revoke(req.webSession.id);
    clearSessionCookie(res, ctx.config.cookieSecure);
    res.redirect("/login");
  });

  return router;
}

import type { Request, Response } from "express";
import type { PlatformAccountRow } from "../repos/accounts.js";
import type { UserRow } from "../repos/users.js";
import { html, raw, type Html } from "./html.js";

export interface PageOptions {
  title: string;
  user?: UserRow | null;
  csrf?: string;
  active?: string;
  flash?: { kind: "ok" | "error" | "warn"; text: string | Html } | null;
  bare?: boolean;
}

const LOGO = raw(
  `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M3 17l5-6 4 3 6-8 3 2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 21h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
);

export function page(opts: PageOptions, body: Html): string {
  const nav = (href: string, key: string, label: string) =>
    html`<a href="${href}" class="${opts.active === key ? "active" : ""}">${label}</a>`;
  const header =
    opts.user && !opts.bare
      ? html`<header class="top">
          <a class="brand" href="/">${LOGO}<span>floorbroker</span></a>
          <nav>
            ${nav("/", "dashboard", "Dashboard")} ${nav("/accounts", "accounts", "Accounts")} ${nav("/activity", "activity", "Activity")}
            ${nav("/connections", "connections", "Agents")}
            ${opts.user.role === "admin" ? nav("/admin", "admin", "Admin") : ""}
          </nav>
          <div class="who">
            <a href="/account" class="${opts.active === "me" ? "active" : ""}">${opts.user.username}</a>
            <form method="post" action="/logout" class="inline">
              <input type="hidden" name="_csrf" value="${opts.csrf ?? ""}" />
              <button class="link" type="submit">Sign out</button>
            </form>
          </div>
        </header>`
      : html`<header class="top bare"><span class="brand">${LOGO}<span>floorbroker</span></span></header>`;

  const flash = opts.flash ? html`<div class="flash ${opts.flash.kind}">${opts.flash.text}</div>` : "";

  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>${opts.title} · floorbroker</title>
<link rel="stylesheet" href="/assets/style.css" />
</head>
<body>
${header}
<main class="${opts.bare ? "narrow" : ""}">
${flash}
${body}
</main>
</body>
</html>`.value;
}

export function send(res: Response, status: number, opts: PageOptions, body: Html): void {
  res.status(status).type("html").send(page(opts, body));
}

/** Common page options from the request. */
export function base(req: Request, title: string, active?: string): PageOptions {
  return { title, user: req.webUser ?? null, csrf: req.csrfToken, active };
}

export function csrfField(req: Request): Html {
  return html`<input type="hidden" name="_csrf" value="${req.csrfToken ?? ""}" />`;
}

export function envBadges(a: Pick<PlatformAccountRow, "environment" | "agent_environment">): Html {
  const real = a.environment === "live" ? "live" : a.environment === "testnet" ? "testnet" : "demo";
  const realIsDemo = real !== "live";
  const agentMismatch = (a.agent_environment === "demo") !== realIsDemo;
  return html`<span class="badge ${realIsDemo ? "demo" : "live"}">${real.toUpperCase()}</span>${agentMismatch
    ? html` <span class="badge agent" title="What connected agents are told">agent sees ${a.agent_environment.toUpperCase()}</span>`
    : ""}`;
}

export function errorPage(res: Response, req: Request, status: number, title: string, message: string): void {
  send(res, status, { ...base(req, title), bare: !req.webUser }, html`<section class="card"><h1>${title}</h1><p>${message}</p><p><a href="/">Back</a></p></section>`);
}

// --- flash messages (one-shot cookie) --------------------------------------------

const FLASH_COOKIE = "fb_flash";

export function setFlash(res: Response, kind: "ok" | "error" | "warn", text: string): void {
  const value = Buffer.from(JSON.stringify({ kind, text: text.slice(0, 1500) })).toString("base64url");
  res.cookie(FLASH_COOKIE, value, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60_000 });
}

export function takeFlash(req: Request, res: Response): PageOptions["flash"] {
  const header = req.headers.cookie ?? "";
  const m = new RegExp(`(?:^|;\\s*)${FLASH_COOKIE}=([^;]+)`).exec(header);
  if (!m) return null;
  res.clearCookie(FLASH_COOKIE, { path: "/" });
  try {
    const v = JSON.parse(Buffer.from(m[1]!, "base64url").toString("utf8")) as { kind: "ok" | "error" | "warn"; text: string };
    return { kind: v.kind, text: v.text };
  } catch {
    return null;
  }
}

/** Page options including any pending flash message. */
export function pageOpts(req: Request, res: Response, title: string, active?: string): PageOptions {
  return { ...base(req, title, active), flash: takeFlash(req, res) };
}

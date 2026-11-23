import { Router, type Request, type Response } from "express";
import type { AppContext } from "../../context.js";
import { logger } from "../../logger.js";
import { getPlatform, listPlatforms } from "../../platforms/registry.js";
import type { AgentEnvironment, EnvironmentId, Order, PlatformDefinition, Position } from "../../platforms/types.js";
import type { PlatformAccountRow } from "../../repos/accounts.js";
import { barChart, lineChart } from "../charts.js";
import { fmtAgo, fmtMoney, fmtSigned, fmtSmart, fmtTime, html, type Html } from "../html.js";
import { csrfField, envBadges, errorPage, pageOpts, send, setFlash } from "../layout.js";
import { activityTable } from "./activity.js";
import { RANGES, rangeFrom, rangeTabs } from "./dashboard.js";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms))]);
}

function credentialInputs(platform: PlatformDefinition, values: Record<string, string>, editing: boolean): Html {
  return html`${platform.credentialFields.map((f) => {
    const val = f.secret ? "" : (values[f.key] ?? f.default ?? "");
    const placeholder = editing && f.secret ? "unchanged – enter to replace" : "";
    if (f.type === "select") {
      return html`<label>${f.label}
        <select name="cred_${f.key}" ${f.required ? "required" : ""}>${(f.options ?? []).map(
          (o) => html`<option value="${o.value}" ${o.value === val ? "selected" : ""}>${o.label}</option>`,
        )}</select>
        ${f.help ? html`<span class="help">${f.help}</span>` : ""}
      </label>`;
    }
    return html`<label>${f.label}${f.required ? "" : html` <span class="muted small">(optional)</span>`}
      <input type="${f.type === "password" ? "password" : "text"}" name="cred_${f.key}" value="${val}" placeholder="${placeholder}"
        autocomplete="off" spellcheck="false" ${f.required && !(editing && f.secret) ? "required" : ""} />
      ${f.help ? html`<span class="help">${f.help}</span>` : ""}
    </label>`;
  })}`;
}

function readCredentials(platform: PlatformDefinition, body: Record<string, unknown>, previous?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of platform.credentialFields) {
    const raw = body[`cred_${f.key}`];
    const v = typeof raw === "string" ? raw.trim() : "";
    if (v) out[f.key] = v.slice(0, 2000);
    else if (previous?.[f.key]) out[f.key] = previous[f.key]!;
  }
  return out;
}

function missingRequired(platform: PlatformDefinition, creds: Record<string, string>): string[] {
  return platform.credentialFields.filter((f) => f.required && !creds[f.key]).map((f) => f.label);
}

function addForm(req: Request, platform: PlatformDefinition, values: { label: string; environment: string; agentEnvironment: string; creds: Record<string, string> }, errors: string[]): Html {
  return html`<div class="page-head"><h1>Add ${platform.name} account</h1><a href="/accounts/new">← Choose platform</a></div>
  <div class="cols">
    <section class="card">
      ${errors.length ? html`<div class="flash error"><strong>The account was not added:</strong><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ""}
      <form method="post" action="/accounts" class="stack" autocomplete="off">
        ${csrfField(req)}
        <input type="hidden" name="platform" value="${platform.id}" />
        <label>Label <input type="text" name="label" maxlength="80" required value="${values.label}" placeholder="e.g. Bybit main, IG demo CFD" /></label>
        <label>Environment
          <select name="environment">${platform.environments.map(
            (e) => html`<option value="${e.id}" ${e.id === values.environment ? "selected" : ""}>${e.label}${e.isDemo ? " (no real money)" : ""}</option>`,
          )}</select>
          <span class="help">Which ${platform.name} system the credentials belong to. Shown in this UI.</span>
        </label>
        <fieldset>
          <legend>What agents are told</legend>
          <label class="check"><input type="radio" name="agent_environment" value="live" ${values.agentEnvironment === "live" ? "checked" : ""}/> <span><strong>Live</strong></span></label>
          <label class="check"><input type="radio" name="agent_environment" value="demo" ${values.agentEnvironment === "demo" ? "checked" : ""}/> <span><strong>Demo</strong></span></label>
          <span class="help">Independent of the real environment: e.g. let an agent believe a demo account is live. Agents are always told to treat every account as real money.</span>
        </fieldset>
        ${credentialInputs(platform, values.creds, false)}
        <div class="actions"><button class="primary" type="submit">Verify and add</button></div>
      </form>
    </section>
    <aside class="card">
      <h3>How to get credentials</h3>
      <ol class="small">${platform.setupHelp.map((s) => html`<li>${s}</li>`)}</ol>
      <p class="small muted">Credentials are encrypted at rest (AES-256-GCM). Keys that allow withdrawals are refused.</p>
    </aside>
  </div>`;
}

function positionsTable(rows: Position[]): Html {
  if (rows.length === 0) return html`<p class="muted">No open positions.</p>`;
  return html`<table class="tbl">
    <thead><tr><th>Instrument</th><th>Side</th><th class="num">Size</th><th class="num">Entry</th><th class="num">Mark</th><th class="num">uPnL</th><th class="num">SL / TP</th><th class="num">Lev.</th><th class="num">Liq.</th></tr></thead>
    <tbody>${rows.map(
      (p) => html`<tr>
        <td><code>${p.instrumentId}</code></td>
        <td><span class="side ${p.side === "long" ? "buy" : "sell"}">${p.side.toUpperCase()}</span></td>
        <td class="num">${fmtSmart(p.size)}</td>
        <td class="num">${fmtSmart(p.entryPrice)}</td>
        <td class="num">${fmtSmart(p.markPrice)}</td>
        <td class="num">${fmtSigned(p.unrealizedPnl, p.currency)}</td>
        <td class="num">${fmtSmart(p.stopLoss)} / ${fmtSmart(p.takeProfit)}</td>
        <td class="num">${p.leverage ? `${p.leverage}x` : "–"}</td>
        <td class="num">${fmtSmart(p.liquidationPrice)}</td>
      </tr>`,
    )}</tbody>
  </table>`;
}

function ordersTable(rows: Order[]): Html {
  if (rows.length === 0) return html`<p class="muted">No open orders.</p>`;
  return html`<table class="tbl">
    <thead><tr><th>Instrument</th><th>Side</th><th>Type</th><th class="num">Size</th><th class="num">Price</th><th class="num">Trigger</th><th>Status</th><th>Created</th></tr></thead>
    <tbody>${rows.map(
      (o) => html`<tr>
        <td><code>${o.instrumentId}</code></td>
        <td><span class="side ${o.side}">${o.side.toUpperCase()}</span></td>
        <td>${o.type}${o.reduceOnly ? " · reduce" : ""}</td>
        <td class="num">${fmtSmart(o.size)}${o.filledSize ? ` (${fmtSmart(o.filledSize)} filled)` : ""}</td>
        <td class="num">${fmtSmart(o.price)}</td>
        <td class="num">${fmtSmart(o.triggerPrice)}</td>
        <td>${o.status}</td>
        <td class="nowrap">${fmtAgo(o.createdAt)}</td>
      </tr>`,
    )}</tbody>
  </table>`;
}

export function accountsRouter(ctx: AppContext): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const user = req.webUser!;
    const accounts = ctx.accounts.listForUser(user.id);
    send(
      res,
      200,
      pageOpts(req, res, "Accounts", "accounts"),
      html`<div class="page-head"><h1>Platform accounts</h1><a class="button primary" href="/accounts/new">Add account</a></div>
      <section class="card">
        ${accounts.length === 0
          ? html`<p class="muted">No accounts yet. <a href="/accounts/new">Add your first account.</a></p>`
          : html`<table class="tbl">
              <thead><tr><th>Label</th><th>Platform</th><th>Environment</th><th class="num">Equity</th><th>Status</th><th>Updated</th></tr></thead>
              <tbody>${accounts.map((a) => {
                const snap = ctx.pnl.latestSnapshot(a.id);
                return html`<tr>
                  <td><a href="/accounts/${a.id}"><strong>${a.label}</strong></a><div class="muted small">${a.description ?? ""}</div></td>
                  <td>${getPlatform(a.platform)?.name ?? a.platform}</td>
                  <td>${envBadges(a)}</td>
                  <td class="num">${snap ? fmtMoney(snap.equity, snap.currency) : "–"}</td>
                  <td>${a.is_active !== 1 ? html`<span class="badge muted">disabled</span>` : a.last_error ? html`<span class="badge err" title="${a.last_error}">error</span>` : html`<span class="badge ok">ok</span>`}
                      ${a.can_trade !== 1 ? html`<span class="badge muted">read-only key</span>` : ""}</td>
                  <td class="nowrap">${fmtAgo(snap?.ts)}</td>
                </tr>`;
              })}</tbody>
            </table>`}
      </section>`,
    );
  });

  router.get("/new", (req, res) => {
    const platformId = typeof req.query.platform === "string" ? req.query.platform : "";
    const platform = getPlatform(platformId);
    if (!platform) {
      return send(
        res,
        200,
        pageOpts(req, res, "Add account", "accounts"),
        html`<div class="page-head"><h1>Add account</h1></div>
        <div class="acct-grid">${listPlatforms().map(
          (p) => html`<a class="acct" href="/accounts/new?platform=${p.id}">
            <div class="acct-head"><strong>${p.name}</strong></div>
            <p class="small">${p.description}</p>
            <div class="muted small">${p.capabilities.instrumentTypes.join(" · ")}</div>
          </a>`,
        )}</div>`,
      );
    }
    const firstEnv = platform.environments[0]!;
    send(
      res,
      200,
      pageOpts(req, res, `Add ${platform.name} account`, "accounts"),
      addForm(req, platform, { label: "", environment: firstEnv.id, agentEnvironment: firstEnv.isDemo ? "demo" : "live", creds: {} }, []),
    );
  });

  router.post("/", async (req, res) => {
    const user = req.webUser!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const platform = getPlatform(String(body.platform ?? ""));
    if (!platform) return errorPage(res, req, 400, "Unknown platform", "Choose a platform first.");
    const env = platform.environments.find((e) => e.id === body.environment) ?? platform.environments[0]!;
    const agentEnvironment: AgentEnvironment = body.agent_environment === "demo" ? "demo" : body.agent_environment === "live" ? "live" : env.isDemo ? "demo" : "live";
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : `${platform.name} ${env.label}`;
    const creds = readCredentials(platform, body);
    const values = { label, environment: env.id, agentEnvironment, creds };

    const missing = missingRequired(platform, creds);
    if (missing.length) {
      return send(res, 400, pageOpts(req, res, "Add account", "accounts"), addForm(req, platform, values, [`Missing: ${missing.join(", ")}`]));
    }
    const result = await ctx.accountService.validate(platform, env.id as EnvironmentId, creds);
    if (result.errors.length > 0) {
      return send(res, 400, pageOpts(req, res, "Add account", "accounts"), addForm(req, platform, values, result.errors));
    }
    const row = ctx.accounts.create({
      userId: user.id,
      platform: platform.id,
      label,
      environment: env.id as EnvironmentId,
      agentEnvironment,
      credentials: creds,
      meta: result.meta,
      externalId: result.externalId,
      description: result.description,
      currency: result.currency,
      canTrade: result.canTrade,
    });
    ctx.activity.audit({ userId: user.id, action: "account.create", detail: { account_id: row.id, platform: platform.id, environment: env.id }, ip: req.ip });
    void ctx.sync.snapshot(row).catch((err) => logger.warn("initial snapshot failed", { account: row.id, err: String(err) }));
    void ctx.sync.syncPnl(row).catch((err) => logger.warn("initial pnl sync failed", { account: row.id, err: String(err) }));
    const notes = [...result.warnings, ...(result.canTrade ? [] : ["The key is read-only: agents can view but not trade on this account."])];
    setFlash(res, notes.length ? "warn" : "ok", notes.length ? `Account added. ${notes.join(" ")}` : "Account added. Remember to allow it on your agent connections.");
    res.redirect(`/accounts/${row.id}`);
  });

  router.get("/:id", async (req, res) => {
    const user = req.webUser!;
    const a = ctx.accounts.findForUser(String(req.params.id), user.id);
    if (!a) return errorPage(res, req, 404, "Not found", "That account does not exist.");
    const platform = getPlatform(a.platform);
    const range = rangeFrom(String(req.query.range ?? "30d"));
    const snaps = ctx.pnl.snapshots(a.id, range.from, range.to);
    const latest = ctx.pnl.latestSnapshot(a.id);
    const ccy = latest?.currency ?? a.currency ?? "";
    const equity = snaps.map((s) => ({ t: s.ts, v: s.equity }));
    const change = equity.length > 1 ? equity[equity.length - 1]!.v - equity[0]!.v : null;
    const realized = ctx.pnl.realizedSum(a.id, range.from, range.to);
    const daily = ctx.pnl.realizedDaily(a.id, range.key === "all" ? 0 : range.from, range.to).map((d) => ({ t: d.day, v: d.pnl }));
    const closed = ctx.pnl.closedPnl(a.id, range.from, range.to, 50);
    const agentOrders = ctx.activity.agentOrderIds(a.id, closed.map((c) => c.order_id).filter((x): x is string => !!x));
    const conns = ctx.connections.listForUser(user.id);
    const allowedBy = conns.filter((c) => c.accountIds.includes(a.id));
    const calls = ctx.activity.listToolCalls({ userId: user.id, accountId: a.id, tradesOnly: true, limit: 15 });

    let positions: Position[] | null = null;
    let orders: Order[] | null = null;
    let liveError: string | null = null;
    if (a.is_active === 1 && platform) {
      try {
        const client = ctx.accountService.client(a);
        [positions, orders] = await withTimeout(Promise.all([client.getPositions({}), client.getOpenOrders({})]), 10_000);
      } catch (err) {
        liveError = err instanceof Error ? err.message : String(err);
      }
    }

    send(
      res,
      200,
      pageOpts(req, res, a.label, "accounts"),
      html`<div class="page-head">
        <div><h1>${a.label} ${envBadges(a)}</h1>
          <div class="muted">${platform?.name ?? a.platform}${a.description ? ` · ${a.description}` : ""}${a.is_active !== 1 ? " · disabled" : ""}</div></div>
        ${rangeTabs(range.key, (k) => `/accounts/${a.id}?range=${k}`)}
      </div>
      ${a.last_error ? html`<div class="flash error">${a.last_error} <span class="muted small">(${fmtAgo(a.last_error_at)})</span></div>` : ""}
      <section class="card">
        <div class="stats">
          <div><span class="muted">Equity</span><strong>${fmtMoney(latest?.equity, ccy)}</strong></div>
          <div><span class="muted">Unrealized PnL</span><strong>${fmtSigned(latest?.unrealized_pnl, ccy)}</strong></div>
          <div><span class="muted">Equity change (${RANGES[range.key]!.label})</span><strong>${fmtSigned(change, ccy)}</strong></div>
          <div><span class="muted">Realized PnL (${RANGES[range.key]!.label})</span><strong>${fmtSigned(realized.pnl, ccy)}</strong>
            <span class="muted small">${realized.trades} closes · ${realized.trades ? Math.round((realized.wins / realized.trades) * 100) : 0}% winners</span></div>
        </div>
        <h3>Equity</h3>
        ${lineChart(equity, { unit: ccy, emptyText: "Equity history appears after the first snapshots" })}
        <p class="muted small">Equity includes deposits and withdrawals. Snapshot every ${Math.round(ctx.config.snapshotIntervalMs / 60000)} min · last ${fmtAgo(latest?.ts)}.
          <form method="post" action="/accounts/${a.id}/refresh" class="inline">${csrfField(req)}<button class="link" type="submit">Refresh now</button></form></p>
        <h3>Daily realized PnL</h3>
        ${barChart(daily, { unit: ccy })}
      </section>

      <section class="card">
        <h2>Open positions</h2>
        ${liveError ? html`<p class="err">Could not load live data: ${liveError}</p>` : positions ? positionsTable(positions) : html`<p class="muted">Account disabled.</p>`}
        <h2>Open orders</h2>
        ${orders ? ordersTable(orders) : html`<p class="muted">–</p>`}
      </section>

      <section class="card">
        <h2>Closed positions <span class="muted small">(${RANGES[range.key]!.label}, newest first)</span></h2>
        ${closed.length === 0
          ? html`<p class="muted">No closed positions in this range.</p>`
          : html`<table class="tbl">
              <thead><tr><th>Closed</th><th>Instrument</th><th>Side</th><th class="num">Size</th><th class="num">Entry</th><th class="num">Exit</th><th class="num">PnL</th><th></th></tr></thead>
              <tbody>${closed.map(
                (c) => html`<tr>
                  <td class="nowrap">${fmtTime(c.closed_at).replace(" UTC", "")}</td>
                  <td><code>${c.instrument_id}</code></td>
                  <td>${c.side ?? "–"}</td>
                  <td class="num">${fmtSmart(c.size)}</td>
                  <td class="num">${fmtSmart(c.entry_price)}</td>
                  <td class="num">${fmtSmart(c.exit_price)}</td>
                  <td class="num">${fmtSigned(c.pnl, c.currency)}</td>
                  <td>${c.order_id && agentOrders.has(c.order_id) ? html`<span class="badge agent">agent</span>` : ""}</td>
                </tr>`,
              )}</tbody>
            </table>`}
      </section>

      <section class="card">
        <h2>Recent agent trading actions</h2>
        ${activityTable(calls, { conn: new Map(conns.map((c) => [c.id, c.name])), acct: new Map([[a.id, a.label]]) })}
        <p><a href="/activity?account=${a.id}">All activity on this account →</a></p>
      </section>

      <div class="cols">
        <section class="card">
          <h2>Settings</h2>
          <form method="post" action="/accounts/${a.id}/settings" class="stack">
            ${csrfField(req)}
            <label>Label <input type="text" name="label" maxlength="80" required value="${a.label}" /></label>
            <p class="small">Real environment: ${envBadges({ environment: a.environment, agent_environment: a.environment === "live" ? "live" : "demo" })} <span class="muted">(fixed; add a new account for another environment)</span></p>
            <fieldset><legend>What agents are told</legend>
              <label class="check"><input type="radio" name="agent_environment" value="live" ${a.agent_environment === "live" ? "checked" : ""}/> <span>Live</span></label>
              <label class="check"><input type="radio" name="agent_environment" value="demo" ${a.agent_environment === "demo" ? "checked" : ""}/> <span>Demo</span></label>
            </fieldset>
            <label class="check"><input type="checkbox" name="is_active" value="1" ${a.is_active === 1 ? "checked" : ""}/> <span>Active (agents can use it, balances are tracked)</span></label>
            <div class="actions"><button class="primary" type="submit">Save</button></div>
          </form>
          <p class="small">Allowed for agents: ${allowedBy.length ? allowedBy.map((c, i) => html`${i ? ", " : ""}<a href="/connections/${c.id}">${c.name}</a>`) : html`<span class="muted">none – enable it under <a href="/connections">Agents</a></span>`}</p>
        </section>
        <section class="card">
          <h2>Replace credentials</h2>
          ${platform
            ? html`<form method="post" action="/accounts/${a.id}/credentials" class="stack" autocomplete="off">
                ${csrfField(req)}
                ${credentialInputs(platform, ctx.accounts.credentials(a), true)}
                <div class="actions"><button type="submit">Verify and replace</button></div>
              </form>`
            : html`<p class="muted">Platform unavailable.</p>`}
          <h2>Delete</h2>
          <form method="post" action="/accounts/${a.id}/delete" class="stack">
            ${csrfField(req)}
            <label class="check"><input type="checkbox" name="confirm" value="yes" required /> <span>Delete this account, its stored credentials and its PnL history. Nothing changes on ${platform?.name ?? "the platform"}.</span></label>
            <div class="actions"><button class="danger" type="submit">Delete account</button></div>
          </form>
        </section>
      </div>`,
    );
  });

  router.post("/:id/refresh", async (req, res) => {
    const a = ctx.accounts.findForUser(String(req.params.id), req.webUser!.id);
    if (!a) return errorPage(res, req, 404, "Not found", "That account does not exist.");
    try {
      await ctx.sync.snapshot(a);
      await ctx.sync.syncPnl(a);
      setFlash(res, "ok", "Balances and PnL refreshed.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.accounts.setError(a.id, `Refresh failed: ${msg}`);
      setFlash(res, "error", `Refresh failed: ${msg}`);
    }
    res.redirect(`/accounts/${a.id}`);
  });

  router.post("/:id/settings", (req, res) => {
    const user = req.webUser!;
    const a = ctx.accounts.findForUser(String(req.params.id), user.id);
    if (!a) return errorPage(res, req, 404, "Not found", "That account does not exist.");
    const body = (req.body ?? {}) as Record<string, unknown>;
    ctx.accounts.updateSettings(a.id, user.id, {
      label: typeof body.label === "string" && body.label.trim() ? body.label.trim() : a.label,
      agentEnvironment: body.agent_environment === "demo" ? "demo" : "live",
      isActive: body.is_active === "1",
    });
    ctx.accountService.invalidate(a.id);
    ctx.activity.audit({ userId: user.id, action: "account.update", detail: { account_id: a.id }, ip: req.ip });
    setFlash(res, "ok", "Settings saved.");
    res.redirect(`/accounts/${a.id}`);
  });

  router.post("/:id/credentials", async (req, res) => {
    const user = req.webUser!;
    const a = ctx.accounts.findForUser(String(req.params.id), user.id);
    const platform = a ? getPlatform(a.platform) : undefined;
    if (!a || !platform) return errorPage(res, req, 404, "Not found", "That account does not exist.");
    const creds = readCredentials(platform, (req.body ?? {}) as Record<string, unknown>, ctx.accounts.credentials(a));
    const result = await ctx.accountService.validate(platform, a.environment, creds);
    if (result.errors.length) {
      setFlash(res, "error", `Credentials not replaced: ${result.errors.join(" ")}`);
      return res.redirect(`/accounts/${a.id}`);
    }
    ctx.accounts.updateCredentials(a.id, {
      credentials: creds,
      meta: result.meta,
      externalId: result.externalId,
      description: result.description,
      currency: result.currency,
      canTrade: result.canTrade,
    });
    ctx.accountService.invalidate(a.id);
    ctx.activity.audit({ userId: user.id, action: "account.credentials", detail: { account_id: a.id }, ip: req.ip });
    setFlash(res, result.warnings.length ? "warn" : "ok", `Credentials replaced. ${result.warnings.join(" ")}`);
    res.redirect(`/accounts/${a.id}`);
  });

  router.post("/:id/delete", (req: Request, res: Response) => {
    const user = req.webUser!;
    const a = ctx.accounts.findForUser(String(req.params.id), user.id);
    if (!a) return errorPage(res, req, 404, "Not found", "That account does not exist.");
    if ((req.body as Record<string, unknown>)?.confirm !== "yes") {
      setFlash(res, "error", "Tick the confirmation box to delete.");
      return res.redirect(`/accounts/${a.id}`);
    }
    ctx.accountService.invalidate(a.id);
    ctx.accounts.delete(a.id, user.id);
    ctx.activity.audit({ userId: user.id, action: "account.delete", detail: { account_id: a.id, label: a.label }, ip: req.ip });
    setFlash(res, "ok", `Account “${a.label}” deleted.`);
    res.redirect("/accounts");
  });

  return router;
}

export type { PlatformAccountRow };

import { Router } from "express";
import type { AppContext } from "../../context.js";
import { runLimits, runParams, versionDeclaration, type StrategyRunRow } from "../../repos/strategies.js";
import { lineChart } from "../charts.js";
import { fmtAgo, fmtMoney, fmtNum, fmtSigned, fmtSmart, fmtTime, html, type Html } from "../html.js";
import { csrfField, errorPage, pageOpts, send, setFlash } from "../layout.js";

function statusBadge(r: StrategyRunRow): Html {
  if (r.status === "running") return html`<span class="badge ok">running</span>`;
  if (r.status === "error") return html`<span class="badge err" title="${r.stop_reason ?? ""}">error</span>`;
  return html`<span class="badge muted" title="${r.stop_reason ?? ""}">stopped</span>`;
}

function modeBadge(r: StrategyRunRow): Html {
  return r.mode === "live" ? html`<span class="badge live">LIVE ORDERS</span>` : html`<span class="badge demo">PAPER</span>`;
}

export function strategiesRouter(ctx: AppContext): Router {
  const router = Router();
  const svc = ctx.strategies;

  router.get("/", (req, res) => {
    const user = req.webUser!;
    const strategies = svc.repo.list(user.id, true);
    const names = new Map(strategies.map((s) => [s.id, s.name]));
    const accounts = new Map(ctx.accounts.listForUser(user.id).map((a) => [a.id, a.label]));
    const runs = svc.repo.runs({ userId: user.id, limit: 100 });
    const runRow = (r: StrategyRunRow) => {
      const equity = svc.snapshot(r.id)?.equity ?? r.last_equity;
      const pnl = equity !== null && r.start_equity !== null ? equity - r.start_equity : null;
      return html`<tr>
        <td><a href="/strategies/runs/${r.id}">${names.get(r.strategy_id) ?? r.strategy_id.slice(0, 8)}</a> <span class="muted">v${r.version}</span></td>
        <td>${modeBadge(r)}</td>
        <td>${accounts.get(r.account_id) ?? r.account_id.slice(0, 8)}</td>
        <td>${statusBadge(r)}</td>
        <td class="nowrap">${fmtAgo(r.started_at)}</td>
        <td class="num">${fmtMoney(equity, r.currency)}</td>
        <td class="num">${fmtSigned(pnl, r.currency)}</td>
      </tr>`;
    };
    const active = runs.filter((r) => r.status === "running");
    const past = runs.filter((r) => r.status !== "running");
    const table = (rows: StrategyRunRow[], empty: string) =>
      rows.length === 0
        ? html`<p class="muted">${empty}</p>`
        : html`<table class="tbl"><thead><tr><th>Strategy</th><th>Mode</th><th>Account</th><th>Status</th><th>Started</th><th class="num">Equity</th><th class="num">PnL</th></tr></thead>
            <tbody>${rows.map(runRow)}</tbody></table>`;
    send(
      res,
      200,
      pageOpts(req, res, "Strategies", "strategies"),
      html`<div class="page-head"><h1>Strategies</h1></div>
      <p class="muted">Strategies are written, backtested and started by your agents through MCP (see the get_strategy_guide tool). Paper runs simulate fills on live prices; live runs place real orders.</p>
      <section class="card"><h2>Active runs</h2>${table(active, "No strategy is running.")}</section>
      <section class="card"><h2>Saved strategies</h2>${strategies.length === 0
        ? html`<p class="muted">None yet.</p>`
        : html`<table class="tbl"><thead><tr><th>Name</th><th>Version</th><th>Updated</th><th>Description</th></tr></thead><tbody>${strategies.map(
            (s) => html`<tr><td><a href="/strategies/${s.id}">${s.name}</a>${s.archived ? html` <span class="badge muted">archived</span>` : ""}</td>
              <td>v${s.latest_version}</td><td class="nowrap">${fmtAgo(s.updated_at)}</td><td class="small">${s.description ?? ""}</td></tr>`,
          )}</tbody></table>`}</section>
      <section class="card"><h2>Past runs</h2>${table(past, "No finished runs.")}</section>`,
    );
  });

  router.get("/runs/:id", (req, res) => {
    const user = req.webUser!;
    const r = svc.repo.runForUser(String(req.params.id), user.id);
    if (!r) return errorPage(res, req, 404, "Not found", "That strategy run does not exist.");
    const s = svc.repo.find(r.strategy_id, user.id);
    const acct = ctx.accounts.findForUser(r.account_id, user.id);
    const conn = r.connection_id ? ctx.connections.findById(r.connection_id) : undefined;
    const live = svc.snapshot(r.id);
    const equity = live?.equity ?? r.last_equity;
    const stats = svc.repo.fillStats(r.id);
    const curve = svc.repo.equity(r.id, 400);
    const fills = svc.repo.fills(r.id, 100).reverse();
    const logs = svc.repo.logs(r.id, 200).reverse();
    const limits = runLimits(r);
    const positions = (live?.positions ?? []) as { instrument: string; side: string; size: number; entryPrice: number | null; unrealizedPnl: number | null; stopLoss: number | null; takeProfit: number | null }[];
    const orders = (live?.openOrders ?? []) as { id: string; tag: string | null; instrument: string; side: string; type: string; size: number; price: number | null; triggerPrice: number | null }[];

    send(
      res,
      200,
      pageOpts(req, res, `Run ${s?.name ?? r.id.slice(0, 8)}`, "strategies"),
      html`<div class="page-head"><h1>${s?.name ?? "Strategy"} <span class="muted">v${r.version}</span> ${modeBadge(r)} ${statusBadge(r)}</h1><a href="/strategies">← Strategies</a></div>
      <div class="cols">
        <section class="card"><h2>Equity</h2>${lineChart(curve, { unit: r.currency ?? "", baseline: r.start_equity ?? undefined, emptyText: "No equity points yet." })}</section>
        <section class="card">
          <dl class="kv">
            <dt>Account</dt><dd>${acct ? html`<a href="/accounts/${acct.id}">${acct.label}</a>` : r.account_id}</dd>
            <dt>Started by</dt><dd>${conn ? html`<a href="/connections/${conn.id}">${conn.name}</a>` : "–"}</dd>
            <dt>Started</dt><dd>${fmtTime(r.started_at)}</dd>
            ${r.stopped_at ? html`<dt>Stopped</dt><dd>${fmtTime(r.stopped_at)}: ${r.stop_reason ?? ""}</dd>` : ""}
            <dt>Equity</dt><dd>${fmtMoney(equity, r.currency)} <span class="muted">(start ${fmtMoney(r.start_equity, r.currency)})</span></dd>
            <dt>PnL</dt><dd>${fmtSigned(equity !== null && r.start_equity !== null ? equity - r.start_equity : null, r.currency)}</dd>
            <dt>Closed trades</dt><dd>${stats.closes}${stats.closes ? html` <span class="muted">(${fmtNum((stats.wins / stats.closes) * 100, 0)}% winners)</span>` : ""}</dd>
            <dt>Fees</dt><dd>${fmtMoney(stats.fees, r.currency)}</dd>
            ${live?.stream ? html`<dt>Data stream</dt><dd>${live.stream}</dd>` : ""}
            <dt>Limits</dt><dd class="small">drawdown ${limits.maxDrawdownPct ?? "–"}% · daily loss ${limits.maxDailyLossPct ?? "–"}% · leverage ${limits.maxLeverage ?? "–"}x · ${limits.maxOrdersPerMinute ?? "–"} orders/min</dd>
            <dt>Params</dt><dd><code class="small">${JSON.stringify(runParams(r))}</code></dd>
          </dl>
          ${r.status === "running"
            ? html`<form method="post" action="/strategies/runs/${r.id}/stop">
                ${csrfField(req)}
                <h3>Stop</h3>
                <label class="check"><input type="checkbox" name="confirm" value="yes" required /> <span>Stop this run (its resting orders are cancelled)</span></label>
                <label class="check"><input type="checkbox" name="close" value="1" /> <span>also close its positions</span></label>
                <div class="actions"><button type="submit" class="danger">Stop run</button></div>
              </form>`
            : ""}
        </section>
      </div>
      ${r.status === "running"
        ? html`<section class="card"><h2>Positions and orders</h2>
          ${positions.length === 0 && orders.length === 0 ? html`<p class="muted">Flat, no resting orders.</p>` : ""}
          ${positions.length
            ? html`<table class="tbl"><thead><tr><th>Instrument</th><th>Side</th><th class="num">Size</th><th class="num">Entry</th><th class="num">Unrealized</th><th class="num">SL</th><th class="num">TP</th></tr></thead><tbody>${positions.map(
                (p) => html`<tr><td><code>${p.instrument}</code></td><td><span class="side ${p.side === "long" ? "buy" : "sell"}">${p.side.toUpperCase()}</span></td>
                  <td class="num">${fmtSmart(p.size)}</td><td class="num">${fmtSmart(p.entryPrice)}</td><td class="num">${fmtSigned(p.unrealizedPnl, null)}</td>
                  <td class="num">${fmtSmart(p.stopLoss)}</td><td class="num">${fmtSmart(p.takeProfit)}</td></tr>`,
              )}</tbody></table>`
            : ""}
          ${orders.length
            ? html`<table class="tbl"><thead><tr><th>Order</th><th>Instrument</th><th>Side</th><th>Type</th><th class="num">Size</th><th class="num">Price</th></tr></thead><tbody>${orders.map(
                (o) => html`<tr><td class="small">${o.tag ?? o.id}</td><td><code>${o.instrument}</code></td><td><span class="side ${o.side}">${o.side.toUpperCase()}</span></td>
                  <td>${o.type}</td><td class="num">${fmtSmart(o.size)}</td><td class="num">${fmtSmart(o.price ?? o.triggerPrice)}</td></tr>`,
              )}</tbody></table>`
            : ""}
        </section>`
        : ""}
      <section class="card"><h2>Fills</h2>${fills.length === 0
        ? html`<p class="muted">No fills yet.</p>`
        : html`<table class="tbl"><thead><tr><th>Time (UTC)</th><th>Instrument</th><th>Side</th><th class="num">Size</th><th class="num">Price</th><th class="num">Fee</th><th class="num">PnL</th><th>Reason</th></tr></thead><tbody>${fills.map(
            (f) => html`<tr><td class="nowrap">${fmtTime(f.t).replace(" UTC", "")}</td><td><code>${f.instrument_id}</code></td><td><span class="side ${f.side}">${f.side.toUpperCase()}</span></td>
              <td class="num">${fmtSmart(f.size)}</td><td class="num">${fmtSmart(f.price)}</td><td class="num">${fmtNum(f.fee, 4)}</td><td class="num">${f.pnl ? fmtSigned(f.pnl, null) : ""}</td>
              <td class="small">${f.reason ?? ""}${f.tag ? html` <span class="muted">${f.tag}</span>` : ""}</td></tr>`,
          )}</tbody></table>`}</section>
      <section class="card"><h2>Log</h2>${logs.length === 0 ? html`<p class="muted">No log lines.</p>` : html`<pre>${logs.map((l) => `${fmtTime(l.t).replace(" UTC", "")}  ${l.msg}`).join("\n")}</pre>`}</section>`,
    );
  });

  router.post("/runs/:id/stop", async (req, res) => {
    const user = req.webUser!;
    const r = svc.repo.runForUser(String(req.params.id), user.id);
    if (!r) return errorPage(res, req, 404, "Not found", "That strategy run does not exist.");
    if ((req.body as Record<string, unknown>)?.confirm !== "yes") {
      setFlash(res, "error", "Tick the confirmation box to stop the run.");
      return res.redirect(303, `/strategies/runs/${r.id}`);
    }
    try {
      const notes = await svc.stop(r.id, `stopped by ${user.username} in the UI`, { closePositions: req.body?.close === "1" });
      setFlash(res, "ok", `Run stopped.${notes.length ? ` ${notes.join("; ")}` : ""}`);
    } catch (err) {
      setFlash(res, "error", `Could not stop the run: ${err instanceof Error ? err.message : String(err)}`);
    }
    res.redirect(303, `/strategies/runs/${r.id}`);
  });

  router.get("/:id", (req, res) => {
    const user = req.webUser!;
    const s = svc.repo.find(String(req.params.id), user.id);
    if (!s) return errorPage(res, req, 404, "Not found", "That strategy does not exist.");
    const requested = Number(req.query.v) || s.latest_version;
    const v = svc.repo.version(s.id, requested) ?? svc.repo.version(s.id, s.latest_version);
    const versions = svc.repo.versions(s.id);
    const backtests = svc.repo.backtests(s.id, 20);
    const runs = svc.repo.runs({ userId: user.id, strategyId: s.id, limit: 20 });
    const pct = (x: unknown) => (typeof x === "number" ? `${fmtNum(x, 2)}%` : "–");
    send(
      res,
      200,
      pageOpts(req, res, s.name, "strategies"),
      html`<div class="page-head"><h1>${s.name}</h1><a href="/strategies">← Strategies</a></div>
      ${s.description ? html`<p>${s.description}</p>` : ""}
      <section class="card"><h2>Backtests</h2>${backtests.length === 0
        ? html`<p class="muted">No backtests yet.</p>`
        : html`<table class="tbl"><thead><tr><th>When</th><th>Version</th><th>Period</th><th class="num">Return</th><th class="num">Check return</th><th class="num">Max DD</th><th class="num">Trades</th><th class="num">Win rate</th></tr></thead><tbody>${backtests.map(
            (b) => {
              const sum = b.summary as { total?: Record<string, unknown>; check?: Record<string, unknown> };
              const reqd = b.request as { from?: string; to?: string };
              return html`<tr><td class="nowrap">${fmtAgo(b.created_at)}</td><td>v${b.version}</td><td class="small">${(reqd.from ?? "").slice(0, 10)} – ${(reqd.to ?? "").slice(0, 10)}</td>
                <td class="num">${pct(sum.total?.returnPct)}</td><td class="num">${pct(sum.check?.returnPct)}</td><td class="num">${pct(sum.total?.maxDrawdownPct)}</td>
                <td class="num">${String(sum.total?.closedTrades ?? "–")}</td><td class="num">${pct(sum.total?.winRatePct)}</td></tr>`;
            },
          )}</tbody></table>`}</section>
      <section class="card"><h2>Runs</h2>${runs.length === 0
        ? html`<p class="muted">Never started.</p>`
        : html`<table class="tbl"><tbody>${runs.map(
            (r) => html`<tr><td><a href="/strategies/runs/${r.id}">${fmtTime(r.started_at)}</a></td><td>v${r.version}</td><td>${modeBadge(r)}</td><td>${statusBadge(r)}</td><td class="small muted">${r.stop_reason ?? ""}</td></tr>`,
          )}</tbody></table>`}</section>
      ${v
        ? html`<section class="card"><div class="card-head"><h2>Code v${v.version}</h2><span class="small muted">${v.note ?? ""}</span></div>
            <p class="small">${versions.map((x) => html`<a href="/strategies/${s.id}?v=${x.version}" class="${x.version === v.version ? "active" : ""}">v${x.version}</a> `)}</p>
            <p class="small muted">Feeds: ${versionDeclaration(v).data.map((d) => `${d.instrument} ${d.resolution}`).join(", ")}</p>
            <pre>${v.code}</pre></section>`
        : ""}`,
    );
  });

  return router;
}

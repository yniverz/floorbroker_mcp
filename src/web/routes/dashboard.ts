import { Router } from "express";
import type { AppContext } from "../../context.js";
import { getPlatform } from "../../platforms/registry.js";
import type { PlatformAccountRow } from "../../repos/accounts.js";
import { lineChart, sparkline, type Point } from "../charts.js";
import { fmtAgo, fmtMoney, fmtSigned, html, type Html } from "../html.js";
import { envBadges, pageOpts, send } from "../layout.js";
import { summarizeCall } from "./activity.js";

export const RANGES: Record<string, { label: string; ms: number | null }> = {
  "1d": { label: "24h", ms: 86_400_000 },
  "7d": { label: "7d", ms: 7 * 86_400_000 },
  "30d": { label: "30d", ms: 30 * 86_400_000 },
  "90d": { label: "90d", ms: 90 * 86_400_000 },
  all: { label: "All", ms: null },
};

export function rangeFrom(key: string): { key: string; from: number; to: number } {
  const k = key in RANGES ? key : "7d";
  const to = Date.now();
  const ms = RANGES[k]!.ms;
  return { key: k, from: ms === null ? 0 : to - ms, to };
}

export function rangeTabs(current: string, hrefFor: (k: string) => string): Html {
  return html`<div class="tabs">${Object.entries(RANGES).map(
    ([k, r]) => html`<a href="${hrefFor(k)}" class="${k === current ? "active" : ""}">${r.label}</a>`,
  )}</div>`;
}

/** Sum of several accounts' equity over time, forward-filling each account's last snapshot. */
export function combinedSeries(ctx: AppContext, accountIds: string[], from: number, to: number, buckets = 200): Point[] {
  const series = accountIds.map((id) => ctx.pnl.snapshots(id, from, to, buckets * 2));
  const starts = series.map((s) => s[0]?.ts ?? Infinity);
  const t0 = Math.max(from, Math.min(...starts));
  if (!Number.isFinite(t0)) return [];
  const out: Point[] = [];
  const idx = series.map(() => 0);
  for (let i = 0; i <= buckets; i++) {
    const t = t0 + ((to - t0) * i) / buckets;
    let sum = 0;
    let any = false;
    series.forEach((s, k) => {
      while (idx[k]! + 1 < s.length && s[idx[k]! + 1]!.ts <= t) idx[k]!++;
      const snap = s[idx[k]!];
      if (snap && snap.ts <= t) {
        sum += snap.equity;
        any = true;
      }
    });
    if (any) out.push({ t, v: sum });
  }
  return out;
}

function changeOver(ctx: AppContext, a: PlatformAccountRow, ms: number): number | null {
  const now = ctx.pnl.latestSnapshot(a.id);
  const then = ctx.pnl.snapshotAtOrBefore(a.id, Date.now() - ms);
  if (!now || !then || now.ts === then.ts) return null;
  return now.equity - then.equity;
}

export function dashboardRouter(ctx: AppContext): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const user = req.webUser!;
    const range = rangeFrom(String(req.query.range ?? "7d"));
    const accounts = ctx.accounts.listForUser(user.id).filter((a) => a.is_active === 1);
    const connections = ctx.connections.listForUser(user.id);
    const counts = ctx.activity.countSince(user.id, Date.now() - 86_400_000);

    // Group by real environment (live vs demo) and currency; demo never mixes into live totals.
    const groups = new Map<string, { live: boolean; currency: string; accounts: PlatformAccountRow[] }>();
    for (const a of accounts) {
      const snap = ctx.pnl.latestSnapshot(a.id);
      const currency = snap?.currency ?? a.currency ?? "?";
      const live = a.environment === "live";
      const key = `${live ? "live" : "demo"}:${currency}`;
      if (!groups.has(key)) groups.set(key, { live, currency, accounts: [] });
      groups.get(key)!.accounts.push(a);
    }
    const sortedGroups = [...groups.values()].sort((x, y) => Number(y.live) - Number(x.live));

    const summary = sortedGroups.map((g) => {
      const equity = g.accounts.reduce((s, a) => s + (ctx.pnl.latestSnapshot(a.id)?.equity ?? 0), 0);
      const series = combinedSeries(ctx, g.accounts.map((a) => a.id), range.from, range.to);
      const change = series.length > 1 ? series[series.length - 1]!.v - series[0]!.v : null;
      const realized = g.accounts.reduce((s, a) => s + ctx.pnl.realizedSum(a.id, range.from, range.to).pnl, 0);
      return html`<section class="card">
        <div class="card-head">
          <h2><span class="badge ${g.live ? "live" : "demo"}">${g.live ? "LIVE" : "DEMO"}</span> ${g.currency} · ${g.accounts.length} account${g.accounts.length === 1 ? "" : "s"}</h2>
        </div>
        <div class="stats">
          <div><span class="muted">Equity</span><strong>${fmtMoney(equity, g.currency)}</strong></div>
          <div><span class="muted">Change (${RANGES[range.key]!.label})</span><strong>${fmtSigned(change, g.currency)}</strong></div>
          <div><span class="muted">Realized PnL (${RANGES[range.key]!.label})</span><strong>${fmtSigned(realized, g.currency)}</strong></div>
        </div>
        ${lineChart(series, { unit: g.currency, emptyText: "Equity history appears after the first snapshots" })}
      </section>`;
    });

    const cards = accounts.map((a) => {
      const snap = ctx.pnl.latestSnapshot(a.id);
      const spark = ctx.pnl.snapshots(a.id, Date.now() - 7 * 86_400_000, Date.now(), 60).map((s) => ({ t: s.ts, v: s.equity }));
      return html`<a class="acct" href="/accounts/${a.id}">
        <div class="acct-head"><strong>${a.label}</strong> ${envBadges(a)}</div>
        <div class="muted small">${getPlatform(a.platform)?.name ?? a.platform}${a.description ? ` · ${a.description}` : ""}</div>
        <div class="acct-body">
          <div>
            <div class="big">${snap ? fmtMoney(snap.equity, snap.currency) : "–"}</div>
            <div class="small">24h ${fmtSigned(changeOver(ctx, a, 86_400_000), snap?.currency)} · uPnL ${fmtSigned(snap?.unrealized_pnl, snap?.currency)}</div>
            <div class="muted small">${snap?.positions ?? 0} positions · updated ${fmtAgo(snap?.ts)}</div>
          </div>
          ${sparkline(spark)}
        </div>
        ${a.last_error ? html`<div class="err small">${a.last_error}</div>` : ""}
      </a>`;
    });

    const recent = ctx.activity.listToolCalls({ userId: user.id, tradesOnly: true, limit: 10 });
    const connName = new Map(connections.map((c) => [c.id, c.name]));
    const acctName = new Map(accounts.map((a) => [a.id, a.label]));

    send(
      res,
      200,
      pageOpts(req, res, "Dashboard", "dashboard"),
      html`
      <div class="page-head">
        <h1>Dashboard</h1>
        ${rangeTabs(range.key, (k) => `/?range=${k}`)}
      </div>
      ${accounts.length === 0
        ? html`<section class="card empty">
            <h2>Get started</h2>
            <ol>
              <li>Create an API key on your trading platform (read + trade, <strong>no withdrawals</strong>).</li>
              <li><a href="/accounts/new">Add the account</a> here.</li>
              <li>Connect your AI agent to <code>${ctx.config.mcpResourceUrl}</code> and pick which accounts it may use. See <a href="/connections">Agents</a>.</li>
            </ol>
          </section>`
        : ""}
      ${summary}
      ${accounts.length > 0 ? html`<h2 class="section">Accounts</h2><div class="acct-grid">${cards}</div>` : ""}
      <h2 class="section">Recent agent trading actions <span class="muted small">· last 24h: ${counts.calls} tool calls, ${counts.trades} trading actions, ${counts.errors} errors</span></h2>
      <section class="card">
        ${recent.length === 0
          ? html`<p class="muted">No trading actions yet.</p>`
          : html`<table class="tbl">
              <thead><tr><th>Time</th><th>Agent</th><th>Account</th><th>Action</th><th></th></tr></thead>
              <tbody>${recent.map(
                (c) => html`<tr>
                  <td class="nowrap"><a href="/activity/${c.id}">${fmtAgo(c.created_at)}</a></td>
                  <td>${connName.get(c.connection_id ?? "") ?? "–"}</td>
                  <td>${acctName.get(c.account_id ?? "") ?? "–"}</td>
                  <td>${summarizeCall(c)}</td>
                  <td>${c.ok ? html`<span class="badge ok">ok</span>` : html`<span class="badge err">error</span>`}</td>
                </tr>`,
              )}</tbody>
            </table>
            <p><a href="/activity?trades=1">All activity →</a></p>`}
      </section>`,
    );
  });

  return router;
}

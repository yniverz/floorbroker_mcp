import { Router } from "express";
import type { AppContext } from "../../context.js";
import type { ToolCallRow } from "../../repos/activity.js";
import { fmtTime, html, type Html } from "../html.js";
import { errorPage, pageOpts, send } from "../layout.js";

function parseArgs(c: ToolCallRow): Record<string, unknown> {
  try {
    return JSON.parse(c.args_json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** One-line human summary of a tool call. */
export function summarizeCall(c: ToolCallRow): Html {
  const a = parseArgs(c);
  const s = (k: string) => (a[k] === undefined || a[k] === null ? "" : String(a[k]));
  switch (c.tool) {
    case "place_order": {
      const px = a.price !== undefined ? ` @ ${s("price")}` : a.trigger_price !== undefined ? ` trigger ${s("trigger_price")}` : "";
      const extras = [a.stop_loss !== undefined ? `SL ${s("stop_loss")}` : "", a.take_profit !== undefined ? `TP ${s("take_profit")}` : "", a.reduce_only ? "reduce-only" : ""]
        .filter(Boolean)
        .join(", ");
      return html`<span class="side ${s("side")}">${s("side").toUpperCase()}</span> ${s("size")} <code>${s("instrument_id")}</code> ${s("type")}${px}${extras ? html` <span class="muted">(${extras})</span>` : ""}`;
    }
    case "close_position":
      return html`Close <code>${s("position_id")}</code>${a.size !== undefined ? ` (${s("size")})` : ""}`;
    case "cancel_order":
      return html`Cancel order <code>${s("order_id")}</code>`;
    case "cancel_all_orders":
      return html`Cancel all orders${a.instrument_id ? html` on <code>${s("instrument_id")}</code>` : ""}`;
    case "amend_order":
      return html`Amend order <code>${s("order_id")}</code>`;
    case "set_position_protection":
      return html`Protect <code>${s("position_id")}</code> SL ${s("stop_loss") || "–"} TP ${s("take_profit") || "–"}`;
    case "set_leverage":
      return html`Leverage ${s("leverage")}x on <code>${s("instrument_id")}</code>`;
    default: {
      const target = a.instrument_id ?? (Array.isArray(a.instrument_ids) ? (a.instrument_ids as string[]).join(", ") : a.query);
      return html`<span class="muted">${c.tool}</span>${target ? html` <code>${String(target)}</code>` : ""}`;
    }
  }
}

function errorText(c: ToolCallRow): string {
  if (!c.error) return "";
  return c.error.length > 140 ? c.error.slice(0, 140) + "…" : c.error;
}

export function activityTable(rows: ToolCallRow[], names: { conn: Map<string, string>; acct: Map<string, string> }): Html {
  if (rows.length === 0) return html`<p class="muted">Nothing here yet.</p>`;
  return html`<table class="tbl">
    <thead><tr><th>Time (UTC)</th><th>Agent</th><th>Account</th><th>Call</th><th>Result</th><th class="num">ms</th></tr></thead>
    <tbody>${rows.map(
      (c) => html`<tr class="${c.is_trade ? "trade" : ""}">
        <td class="nowrap"><a href="/activity/${c.id}">${fmtTime(c.created_at).replace(" UTC", "")}</a></td>
        <td>${names.conn.get(c.connection_id ?? "") ?? html`<span class="muted">revoked</span>`}</td>
        <td>${names.acct.get(c.account_id ?? "") ?? (c.account_id ? html`<span class="muted">${c.account_id.slice(0, 8)}</span>` : "–")}</td>
        <td>${summarizeCall(c)}</td>
        <td>${c.ok ? html`<span class="badge ok">ok</span>` : html`<span class="badge err" title="${c.error ?? ""}">error</span> <span class="small err">${errorText(c)}</span>`}</td>
        <td class="num muted">${c.duration_ms}</td>
      </tr>`,
    )}</tbody>
  </table>`;
}

export function activityRouter(ctx: AppContext): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const user = req.webUser!;
    const q = req.query;
    const accountId = typeof q.account === "string" && q.account ? q.account : undefined;
    const connectionId = typeof q.agent === "string" && q.agent ? q.agent : undefined;
    const tradesOnly = q.trades === "1";
    const errorsOnly = q.errors === "1";
    const before = typeof q.before === "string" ? Number(q.before) || undefined : undefined;
    const rows = ctx.activity.listToolCalls({ userId: user.id, accountId, connectionId, tradesOnly, errorsOnly, before, limit: 100 });
    const accounts = ctx.accounts.listForUser(user.id);
    const connections = ctx.connections.listForUser(user.id);
    const names = { conn: new Map(connections.map((c) => [c.id, c.name])), acct: new Map(accounts.map((a) => [a.id, a.label])) };
    const params = new URLSearchParams();
    if (accountId) params.set("account", accountId);
    if (connectionId) params.set("agent", connectionId);
    if (tradesOnly) params.set("trades", "1");
    if (errorsOnly) params.set("errors", "1");
    const last = rows[rows.length - 1];
    if (last) params.set("before", String(last.id));

    send(
      res,
      200,
      pageOpts(req, res, "Activity", "activity"),
      html`<div class="page-head"><h1>Agent activity</h1></div>
      <form method="get" action="/activity" class="filters">
        <select name="account"><option value="">All accounts</option>${accounts.map(
          (a) => html`<option value="${a.id}" ${a.id === accountId ? "selected" : ""}>${a.label}</option>`,
        )}</select>
        <select name="agent"><option value="">All agents</option>${connections.map(
          (c) => html`<option value="${c.id}" ${c.id === connectionId ? "selected" : ""}>${c.name}</option>`,
        )}</select>
        <label class="check"><input type="checkbox" name="trades" value="1" ${tradesOnly ? "checked" : ""}/> Trading actions only</label>
        <label class="check"><input type="checkbox" name="errors" value="1" ${errorsOnly ? "checked" : ""}/> Errors only</label>
        <button type="submit">Filter</button>
      </form>
      <section class="card">${activityTable(rows, names)}
        ${rows.length === 100 ? html`<p><a href="/activity?${params.toString()}">Older →</a></p>` : ""}
      </section>`,
    );
  });

  router.get("/:id", (req, res) => {
    const user = req.webUser!;
    const call = ctx.activity.getToolCall(Number(req.params.id), user.id);
    if (!call) return errorPage(res, req, 404, "Not found", "That activity entry does not exist.");
    const conn = call.connection_id ? ctx.connections.findById(call.connection_id) : undefined;
    const acct = call.account_id ? ctx.accounts.findForUser(call.account_id, user.id) : undefined;
    const pretty = (s: string | null) => {
      if (!s) return "";
      try {
        return JSON.stringify(JSON.parse(s), null, 2);
      } catch {
        return s;
      }
    };
    send(
      res,
      200,
      pageOpts(req, res, `Call ${call.tool}`, "activity"),
      html`<div class="page-head"><h1>${call.tool}</h1><a href="/activity">← Activity</a></div>
      <section class="card">
        <dl class="kv">
          <dt>Time</dt><dd>${fmtTime(call.created_at)}</dd>
          <dt>Agent</dt><dd>${conn ? html`<a href="/connections/${conn.id}">${conn.name}</a>` : "–"}</dd>
          <dt>Account</dt><dd>${acct ? html`<a href="/accounts/${acct.id}">${acct.label}</a>` : (call.account_id ?? "–")}</dd>
          <dt>Result</dt><dd>${call.ok ? html`<span class="badge ok">ok</span>` : html`<span class="badge err">error</span> ${call.error}`}</dd>
          <dt>Duration</dt><dd>${call.duration_ms} ms</dd>
        </dl>
        <h3>Arguments</h3><pre>${pretty(call.args_json)}</pre>
        <h3>Response (as sent to the agent)</h3><pre>${pretty(call.result_json)}</pre>
      </section>`,
    );
  });

  return router;
}

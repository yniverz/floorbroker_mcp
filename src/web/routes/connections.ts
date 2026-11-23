import { Router } from "express";
import type { AppContext } from "../../context.js";
import type { Connection } from "../../repos/connections.js";
import { hasLimits } from "../../services/risk.js";
import { connectionFields, parseConnectionForm } from "../connectionForm.js";
import { fmtAgo, html, type Html } from "../html.js";
import { csrfField, errorPage, pageOpts, send, setFlash } from "../layout.js";

function limitsSummary(c: Connection): Html {
  if (!hasLimits(c.risk)) return html`<span class="muted">none</span>`;
  const parts: string[] = [];
  if (c.risk.maxOrderNotional !== undefined) parts.push(`order ≤ ${c.risk.maxOrderNotional}`);
  if (c.risk.maxPositionNotional !== undefined) parts.push(`position ≤ ${c.risk.maxPositionNotional}`);
  if (c.risk.maxLeverage !== undefined) parts.push(`leverage ≤ ${c.risk.maxLeverage}x`);
  if (c.risk.allowedInstruments?.length) parts.push(`${c.risk.allowedInstruments.length} instruments`);
  return html`${parts.join(" · ")}`;
}

export function connectionsRouter(ctx: AppContext): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const user = req.webUser!;
    const conns = ctx.connections.listForUser(user.id);
    const accounts = ctx.accounts.listForUser(user.id);
    const label = new Map(accounts.map((a) => [a.id, a.label]));
    const mcpUrl = ctx.config.mcpResourceUrl;
    send(
      res,
      200,
      pageOpts(req, res, "Agents", "connections"),
      html`<div class="page-head"><h1>Agent connections</h1></div>
      <section class="card">
        <h2>Connect an agent</h2>
        <p>MCP server URL: <code class="copy">${mcpUrl}</code></p>
        <ul class="small">
          <li><strong>Claude (claude.ai / Desktop / mobile):</strong> Settings → Connectors → Add custom connector → paste the URL. You will be asked to sign in here and choose accounts and permissions.</li>
          <li><strong>ChatGPT:</strong> Settings → Apps &amp; Connectors → Developer mode → Create → paste the URL, authentication OAuth.</li>
          <li><strong>Other clients (Claude Code, scripts):</strong> they can use OAuth too, or a personal token created below, sent as <code>Authorization: Bearer …</code>.</li>
        </ul>
      </section>
      <section class="card">
        <h2>Active connections</h2>
        ${conns.length === 0
          ? html`<p class="muted">No agents connected yet.</p>`
          : html`<table class="tbl">
              <thead><tr><th>Name</th><th>Type</th><th>Accounts</th><th>Permission</th><th>Risk limits</th><th>Last used</th></tr></thead>
              <tbody>${conns.map(
                (c) => html`<tr>
                  <td><a href="/connections/${c.id}"><strong>${c.name}</strong></a></td>
                  <td>${c.kind === "oauth" ? "OAuth" : "Token"}</td>
                  <td>${c.accountIds.length ? c.accountIds.map((id, i) => html`${i ? ", " : ""}${label.get(id) ?? "?"}`) : html`<span class="muted">none</span>`}</td>
                  <td>${c.can_trade ? html`<span class="badge live">trade</span>` : html`<span class="badge muted">read only</span>`}</td>
                  <td class="small">${limitsSummary(c)}</td>
                  <td class="nowrap">${fmtAgo(c.last_used_at)}</td>
                </tr>`,
              )}</tbody>
            </table>`}
      </section>
      <section class="card">
        <h2>Create a personal token</h2>
        <form method="post" action="/connections/token" class="stack">
          ${csrfField(req)}
          ${connectionFields(accounts, { name: "", canTrade: false, accountIds: accounts.filter((a) => a.is_active === 1).map((a) => a.id), risk: {} })}
          <div class="actions"><button class="primary" type="submit">Create token</button></div>
        </form>
      </section>`,
    );
  });

  router.post("/token", (req, res) => {
    const user = req.webUser!;
    const owned = new Set(ctx.accounts.listForUser(user.id).map((a) => a.id));
    const form = parseConnectionForm((req.body ?? {}) as Record<string, unknown>, owned, "Personal token");
    const conn = ctx.connections.create({ userId: user.id, kind: "token", clientId: null, ...form });
    const token = ctx.connections.issueAccessToken({
      userId: user.id,
      connectionId: conn.id,
      clientId: null,
      scope: form.canTrade ? "trading:read trading:trade" : "trading:read",
      resource: null,
      ttlMs: null,
      kind: "pat",
    });
    ctx.activity.audit({ userId: user.id, action: "connection.token.create", detail: { connection_id: conn.id }, ip: req.ip });
    res.setHeader("Cache-Control", "no-store");
    send(
      res,
      200,
      pageOpts(req, res, "Token created", "connections"),
      html`<section class="card">
        <h1>Token for “${conn.name}”</h1>
        <p class="flash warn">Copy it now – it is shown only once.</p>
        <pre class="token">${token.value}</pre>
        <h3>Claude Code</h3>
        <pre>claude mcp add --transport http floorbroker ${ctx.config.mcpResourceUrl} \\
  --header "Authorization: Bearer ${token.value}"</pre>
        <h3>Generic MCP client config</h3>
        <pre>${JSON.stringify({ mcpServers: { floorbroker: { type: "http", url: ctx.config.mcpResourceUrl, headers: { Authorization: `Bearer ${token.value}` } } } }, null, 2)}</pre>
        <p><a href="/connections/${conn.id}">Connection settings →</a></p>
      </section>`,
    );
  });

  router.get("/:id", (req, res) => {
    const user = req.webUser!;
    const c = ctx.connections.findActiveForUser(String(req.params.id), user.id);
    if (!c) return errorPage(res, req, 404, "Not found", "That connection does not exist.");
    const client = c.client_id ? ctx.oauthClients.find(c.client_id) : undefined;
    const accounts = ctx.accounts.listForUser(user.id);
    send(
      res,
      200,
      pageOpts(req, res, c.name, "connections"),
      html`<div class="page-head"><h1>${c.name}</h1><a href="/connections">← Agents</a></div>
      <div class="cols">
        <section class="card">
          <form method="post" action="/connections/${c.id}" class="stack">
            ${csrfField(req)}
            ${connectionFields(accounts, { name: c.name, canTrade: c.can_trade === 1, accountIds: c.accountIds, risk: c.risk })}
            <div class="actions"><button class="primary" type="submit">Save</button></div>
          </form>
          <p class="muted small">Changes apply to the agent's next request.</p>
        </section>
        <aside class="card">
          <dl class="kv">
            <dt>Type</dt><dd>${c.kind === "oauth" ? "OAuth connector" : "Personal token"}</dd>
            ${client ? html`<dt>Client</dt><dd>${client.client_name}${client.client_uri ? html` · <span class="muted">${client.client_uri}</span>` : ""}</dd>` : ""}
            <dt>Created</dt><dd>${fmtAgo(c.created_at)}</dd>
            <dt>Last used</dt><dd>${fmtAgo(c.last_used_at)}</dd>
          </dl>
          <p><a href="/activity?agent=${c.id}">Activity of this agent →</a></p>
          <form method="post" action="/connections/${c.id}/revoke" class="stack">
            ${csrfField(req)}
            <button class="danger" type="submit">Revoke connection</button>
            <span class="muted small">The agent loses access immediately. For OAuth connectors, remove the connector in the AI app too.</span>
          </form>
        </aside>
      </div>`,
    );
  });

  router.post("/:id", (req, res) => {
    const user = req.webUser!;
    const c = ctx.connections.findActiveForUser(String(req.params.id), user.id);
    if (!c) return errorPage(res, req, 404, "Not found", "That connection does not exist.");
    const owned = new Set(ctx.accounts.listForUser(user.id).map((a) => a.id));
    const form = parseConnectionForm((req.body ?? {}) as Record<string, unknown>, owned, c.name);
    ctx.connections.update(c.id, user.id, form);
    ctx.activity.audit({ userId: user.id, action: "connection.update", detail: { connection_id: c.id, can_trade: form.canTrade }, ip: req.ip });
    setFlash(res, "ok", "Connection saved.");
    res.redirect(`/connections/${c.id}`);
  });

  router.post("/:id/revoke", (req, res) => {
    const user = req.webUser!;
    const c = ctx.connections.findActiveForUser(String(req.params.id), user.id);
    if (!c) return errorPage(res, req, 404, "Not found", "That connection does not exist.");
    ctx.connections.revoke(c.id, user.id);
    ctx.activity.audit({ userId: user.id, action: "connection.revoke", detail: { connection_id: c.id }, ip: req.ip });
    setFlash(res, "ok", `“${c.name}” revoked.`);
    res.redirect("/connections");
  });

  return router;
}

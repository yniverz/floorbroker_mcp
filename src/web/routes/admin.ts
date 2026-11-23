import { Router } from "express";
import { requireAdmin, safeNext } from "../../auth/middleware.js";
import { generatePassword, hashPassword, validatePasswordStrength, verifyPassword } from "../../auth/password.js";
import type { AppContext } from "../../context.js";
import { fmtAgo, fmtTime, html } from "../html.js";
import { csrfField, errorPage, pageOpts, send, setFlash } from "../layout.js";

/** /account: the signed-in user's own settings. */
export function meRouter(ctx: AppContext): Router {
  const router = Router();

  const form = (req: Parameters<Parameters<typeof router.get>[1]>[0], forced: boolean) => html`<section class="card">
      <h1>${forced ? "Choose a new password" : "Change password"}</h1>
      ${forced ? html`<p>Your account uses a one-time password. Set your own to continue.</p>` : ""}
      <form method="post" action="/account/password" class="stack">
        ${csrfField(req)}
        <input type="hidden" name="next" value="${safeNext(req.query.next)}" />
        <label>Current password <input type="password" name="current" autocomplete="current-password" required /></label>
        <label>New password <input type="password" name="password" autocomplete="new-password" minlength="12" required /></label>
        <label>Repeat new password <input type="password" name="password2" autocomplete="new-password" minlength="12" required /></label>
        <div class="actions"><button class="primary" type="submit">Save</button></div>
      </form>
    </section>`;

  router.get("/", (req, res) => {
    const u = req.webUser!;
    send(
      res,
      200,
      pageOpts(req, res, "My account", "me"),
      html`<div class="page-head"><h1>${u.username}</h1></div>
      <section class="card"><dl class="kv"><dt>Role</dt><dd>${u.role}</dd><dt>Created</dt><dd>${fmtTime(u.created_at)}</dd><dt>Last sign-in</dt><dd>${fmtTime(u.last_login_at)}</dd></dl></section>
      ${form(req, false)}`,
    );
  });

  router.get("/password", (req, res) => {
    const forced = req.webUser!.must_change_password === 1;
    send(res, 200, { ...pageOpts(req, res, "Password", "me"), bare: forced }, form(req, forced));
  });

  router.post("/password", async (req, res) => {
    const u = req.webUser!;
    const body = (req.body ?? {}) as Record<string, string>;
    const back = (msg: string) => {
      setFlash(res, "error", msg);
      res.redirect("/account/password");
    };
    if (!(await verifyPassword(String(body.current ?? ""), u.password_hash))) return back("Current password is wrong.");
    if (body.password !== body.password2) return back("The new passwords do not match.");
    const weak = validatePasswordStrength(String(body.password ?? ""));
    if (weak) return back(weak);
    ctx.users.setPassword(u.id, await hashPassword(String(body.password)), false);
    ctx.webSessions.revokeAllForUser(u.id, req.webSession?.id);
    ctx.activity.audit({ userId: u.id, action: "auth.password.change", ip: req.ip });
    setFlash(res, "ok", "Password changed. Other sessions were signed out.");
    res.redirect(safeNext(body.next));
  });

  return router;
}

/** /admin: user management, OAuth clients, audit log. */
export function adminRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAdmin);

  router.get("/", (req, res) => {
    const users = ctx.users.list();
    const clients = ctx.oauthClients.list();
    const audit = ctx.activity.listAudit(100);
    const stats = ctx.candles.stats();
    send(
      res,
      200,
      pageOpts(req, res, "Admin", "admin"),
      html`<div class="page-head"><h1>Admin</h1></div>
      <section class="card">
        <h2>Users</h2>
        <p class="muted small">Every user has their own platform accounts and agents and sees only their own data.</p>
        <table class="tbl">
          <thead><tr><th>Username</th><th>Role</th><th>Status</th><th>Accounts</th><th>Last sign-in</th><th></th></tr></thead>
          <tbody>${users.map(
            (u) => html`<tr>
              <td><strong>${u.username}</strong></td>
              <td>${u.role}</td>
              <td>${u.is_active ? html`<span class="badge ok">active</span>` : html`<span class="badge muted">disabled</span>`}${u.must_change_password ? html` <span class="badge muted">one-time password</span>` : ""}</td>
              <td>${ctx.accounts.listForUser(u.id).length}</td>
              <td class="nowrap">${fmtAgo(u.last_login_at)}</td>
              <td class="nowrap">${u.id === req.webUser!.id
                ? html`<span class="muted small">you</span>`
                : html`<form method="post" action="/admin/users/${u.id}" class="inline">${csrfField(req)}
                    <button class="link" name="action" value="reset">Reset password</button> ·
                    <button class="link" name="action" value="${u.is_active ? "disable" : "enable"}">${u.is_active ? "Disable" : "Enable"}</button> ·
                    <button class="link" name="action" value="${u.role === "admin" ? "demote" : "promote"}">${u.role === "admin" ? "Make user" : "Make admin"}</button> ·
                    <button class="link danger" name="action" value="delete">Delete</button>
                  </form>`}</td>
            </tr>`,
          )}</tbody>
        </table>
        <h3>Add user</h3>
        <form method="post" action="/admin/users" class="row">
          ${csrfField(req)}
          <input type="text" name="username" placeholder="username" pattern="[A-Za-z0-9._-]{2,64}" required />
          <select name="role"><option value="user">user</option><option value="admin">admin</option></select>
          <button class="primary" type="submit">Create</button>
        </form>
        <p class="muted small">A one-time password is shown after creation; the user must change it at first sign-in.</p>
      </section>
      <section class="card">
        <h2>OAuth clients</h2>
        ${clients.length === 0
          ? html`<p class="muted">None registered.</p>`
          : html`<table class="tbl">
              <thead><tr><th>Name</th><th>Type</th><th>Redirect</th><th>Registered</th><th>Last used</th><th></th></tr></thead>
              <tbody>${clients.map(
                (c) => html`<tr>
                  <td>${c.client_name}</td>
                  <td>${c.kind.toUpperCase()}</td>
                  <td class="small"><code>${ctx.oauthClients.redirectUris(c).join(" ")}</code></td>
                  <td class="nowrap">${fmtAgo(c.created_at)}</td>
                  <td class="nowrap">${fmtAgo(c.last_used_at)}</td>
                  <td class="nowrap"><form method="post" action="/admin/clients" class="inline">${csrfField(req)}<input type="hidden" name="client_id" value="${c.client_id}" />
                    <button class="link" name="action" value="${c.is_active ? "disable" : "enable"}">${c.is_active ? "Disable" : "Enable"}</button> ·
                    <button class="link danger" name="action" value="delete">Delete</button></form></td>
                </tr>`,
              )}</tbody>
            </table>`}
      </section>
      <section class="card">
        <h2>Market data cache</h2>
        <p>${stats.candles.toLocaleString("en-US")} candles in ${stats.series} series. Stored in <code>marketdata.db</code>; safe to delete, it refills on demand.</p>
      </section>
      <section class="card">
        <h2>Audit log</h2>
        <table class="tbl">
          <thead><tr><th>Time (UTC)</th><th>User</th><th>Action</th><th>Detail</th><th>IP</th></tr></thead>
          <tbody>${audit.map(
            (e) => html`<tr><td class="nowrap">${fmtTime(e.created_at).replace(" UTC", "")}</td><td>${e.username ?? "–"}</td><td>${e.action}</td><td class="small"><code>${e.detail_json ?? ""}</code></td><td class="small">${e.ip ?? ""}</td></tr>`,
          )}</tbody>
        </table>
      </section>`,
    );
  });

  router.post("/users", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const username = String(body.username ?? "").trim();
    if (!/^[A-Za-z0-9._-]{2,64}$/.test(username)) {
      setFlash(res, "error", "Usernames use 2–64 letters, digits, dots, dashes or underscores.");
      return res.redirect("/admin");
    }
    if (ctx.users.findByUsername(username)) {
      setFlash(res, "error", "That username is taken.");
      return res.redirect("/admin");
    }
    const password = generatePassword();
    ctx.users.create({ username, passwordHash: await hashPassword(password), role: body.role === "admin" ? "admin" : "user", mustChange: true });
    ctx.activity.audit({ userId: req.webUser!.id, action: "admin.user.create", detail: { username }, ip: req.ip });
    res.setHeader("Cache-Control", "no-store");
    send(
      res,
      200,
      pageOpts(req, res, "User created", "admin"),
      html`<section class="card"><h1>User “${username}” created</h1>
        <p>One-time password (shown only now):</p><pre class="token">${password}</pre>
        <p>Sign-in URL: <code>${ctx.config.publicUrl}/login</code></p>
        <p><a href="/admin">← Admin</a></p></section>`,
    );
  });

  router.post("/users/:id", async (req, res) => {
    const target = ctx.users.findById(String(req.params.id));
    const me = req.webUser!;
    if (!target || target.id === me.id) return errorPage(res, req, 400, "Not allowed", "You cannot change your own account here.");
    const action = String((req.body as Record<string, string>)?.action ?? "");
    const audit = (a: string) => ctx.activity.audit({ userId: me.id, action: `admin.user.${a}`, detail: { username: target.username }, ip: req.ip });
    if (action === "reset") {
      const password = generatePassword();
      ctx.users.setPassword(target.id, await hashPassword(password), true);
      ctx.webSessions.revokeAllForUser(target.id);
      audit("reset");
      res.setHeader("Cache-Control", "no-store");
      return send(
        res,
        200,
        pageOpts(req, res, "Password reset", "admin"),
        html`<section class="card"><h1>New one-time password for “${target.username}”</h1><pre class="token">${password}</pre><p><a href="/admin">← Admin</a></p></section>`,
      );
    }
    if (action === "disable" || action === "enable") {
      ctx.users.setActive(target.id, action === "enable");
      if (action === "disable") ctx.webSessions.revokeAllForUser(target.id);
      audit(action);
    } else if (action === "promote" || action === "demote") {
      ctx.users.setRole(target.id, action === "promote" ? "admin" : "user");
      audit(action);
    } else if (action === "delete") {
      for (const a of ctx.accounts.listForUser(target.id)) ctx.accountService.invalidate(a.id);
      ctx.users.delete(target.id);
      audit("delete");
    }
    setFlash(res, "ok", "Done.");
    res.redirect("/admin");
  });

  router.post("/clients", (req, res) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const client = ctx.oauthClients.find(String(body.client_id ?? ""));
    if (!client) return res.redirect("/admin");
    if (body.action === "disable" || body.action === "enable") ctx.oauthClients.setActive(client.client_id, body.action === "enable");
    if (body.action === "delete") ctx.oauthClients.delete(client.client_id);
    ctx.activity.audit({ userId: req.webUser!.id, action: `admin.client.${body.action}`, detail: { client_id: client.client_id }, ip: req.ip });
    setFlash(res, "ok", "Done.");
    res.redirect("/admin");
  });

  return router;
}

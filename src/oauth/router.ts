import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireLogin, verifyCsrf } from "../auth/middleware.js";
import type { AppContext } from "../context.js";
import { logger } from "../logger.js";
import type { OAuthClientRow } from "../repos/oauthClients.js";
import { safeEqual, sha256, sha256Base64Url } from "../util/crypto.js";
import { connectionFields, parseConnectionForm } from "../web/connectionForm.js";
import { html } from "../web/html.js";
import { base, csrfField, errorPage, send } from "../web/layout.js";
import { cspHeaderValue } from "../http/csp.js";
import { isCimdClientId, resolveCimdClient } from "./cimd.js";
import { normalizeScope } from "./metadata.js";
import { matchRedirectUri, normalizeResource, validateRedirectUri } from "./redirectUri.js";

const AUTH_CODE_TTL_MS = 60_000;

const registrationSchema = z
  .object({
    client_name: z.string().min(1).max(200).optional(),
    redirect_uris: z.array(z.string().min(1).max(2000)).min(1).max(10),
    grant_types: z.array(z.string().max(60)).max(10).optional(),
    response_types: z.array(z.string().max(60)).max(10).optional(),
    token_endpoint_auth_method: z.enum(["none", "client_secret_basic", "client_secret_post"]).optional(),
    scope: z.string().max(500).optional(),
    client_uri: z.string().max(2000).optional(),
  })
  .loose();

interface AuthorizeParams {
  client: OAuthClientRow;
  redirectUri: string;
  scope: string;
  state: string | null;
  codeChallenge: string;
  resource: string | null;
}

type AuthorizeResult =
  | { kind: "ok"; params: AuthorizeParams }
  | { kind: "fatal"; message: string }
  | { kind: "redirect"; redirectUri: string; error: string; description: string; state: string | null };

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 2048 ? value : null;
}

async function findClient(ctx: AppContext, clientId: string): Promise<OAuthClientRow | undefined> {
  if (isCimdClientId(clientId)) return (await resolveCimdClient(ctx, clientId)) ?? undefined;
  return ctx.oauthClients.findActive(clientId);
}

async function validateAuthorize(ctx: AppContext, raw: Record<string, unknown>): Promise<AuthorizeResult> {
  const clientId = str(raw.client_id);
  if (!clientId) return { kind: "fatal", message: "Missing client_id." };
  const client = await findClient(ctx, clientId);
  if (!client) return { kind: "fatal", message: "Unknown or disabled client. Remove and re-add the connector in your AI app." };

  const redirectUri = str(raw.redirect_uri);
  if (!redirectUri) return { kind: "fatal", message: "Missing redirect_uri." };
  if (!matchRedirectUri(ctx.oauthClients.redirectUris(client), redirectUri)) {
    return { kind: "fatal", message: "redirect_uri does not match the registered value." };
  }
  const state = str(raw.state);
  const fail = (error: string, description: string): AuthorizeResult => ({ kind: "redirect", redirectUri, error, description, state });

  if (str(raw.response_type) !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  const codeChallenge = str(raw.code_challenge);
  if (!codeChallenge || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeChallenge)) return fail("invalid_request", "A valid S256 code_challenge is required.");
  if (str(raw.code_challenge_method) !== "S256") return fail("invalid_request", "code_challenge_method must be S256.");
  const resource = normalizeResource(raw.resource, ctx.config);
  if (!resource.ok) return fail("invalid_target", "The requested resource is not served here.");
  return {
    kind: "ok",
    params: { client, redirectUri, scope: normalizeScope(str(raw.scope)) ?? "", state, codeChallenge, resource: resource.value },
  };
}

function allowFormActionTo(ctx: AppContext, res: Response, redirectUri: string): void {
  try {
    const u = new URL(redirectUri);
    const target = u.protocol === "http:" || u.protocol === "https:" ? u.origin : `${u.protocol}`;
    res.setHeader("Content-Security-Policy", cspHeaderValue([target], ctx.config.cookieSecure));
  } catch {
    /* validated earlier */
  }
}

function redirectWithError(res: Response, redirectUri: string, error: string, description: string, state: string | null): void {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state !== null) url.searchParams.set("state", state);
  res.redirect(302, url.toString());
}

async function authenticateClient(
  ctx: AppContext,
  req: Request,
): Promise<{ ok: true; client: OAuthClientRow } | { ok: false; error: string; description: string }> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  let clientId = str(body.client_id);
  let clientSecret = str(body.client_secret);
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep > 0) {
      clientId = decodeURIComponent(decoded.slice(0, sep));
      clientSecret = decodeURIComponent(decoded.slice(sep + 1));
    }
  }
  if (!clientId) return { ok: false, error: "invalid_client", description: "Missing client_id." };
  const client = await findClient(ctx, clientId);
  if (!client) return { ok: false, error: "invalid_client", description: "Unknown client." };
  if (client.token_endpoint_auth_method === "none") return { ok: true, client };
  if (!clientSecret || !client.client_secret_hash || !safeEqual(client.client_secret_hash, sha256(clientSecret))) {
    return { ok: false, error: "invalid_client", description: "Client authentication failed." };
  }
  return { ok: true, client };
}

function renderConsent(ctx: AppContext, req: Request, res: Response, p: AuthorizeParams): void {
  const user = req.webUser!;
  const accounts = ctx.accounts.listForUser(user.id);
  const existing = ctx.connections.listForUser(user.id).find((c) => c.kind === "oauth" && c.client_id === p.client.client_id);
  const values = existing
    ? { name: existing.name, canTrade: existing.can_trade === 1, accountIds: existing.accountIds, risk: existing.risk }
    : { name: p.client.client_name, canTrade: false, accountIds: accounts.filter((a) => a.is_active === 1).map((a) => a.id), risk: {} };
  let redirectHost = p.redirectUri;
  try {
    redirectHost = new URL(p.redirectUri).host || p.redirectUri;
  } catch {
    /* keep raw */
  }
  allowFormActionTo(ctx, res, p.redirectUri);
  send(
    res,
    200,
    { ...base(req, "Connect an agent"), bare: true },
    html`<section class="card">
      <h1>Connect “${p.client.client_name}”</h1>
      <p>An AI agent wants to access floorbroker as <strong>${user.username}</strong>. After approval you will be sent back to <code>${redirectHost}</code>.</p>
      ${p.client.kind === "dcr" ? html`<p class="muted small">The client registered itself; its name is self-declared. Only approve if you just started connecting it.</p>` : ""}
      <form method="post" action="/oauth/authorize" class="stack">
        ${csrfField(req)}
        <input type="hidden" name="client_id" value="${p.client.client_id}" />
        <input type="hidden" name="redirect_uri" value="${p.redirectUri}" />
        <input type="hidden" name="scope" value="${p.scope}" />
        <input type="hidden" name="state" value="${p.state ?? ""}" />
        <input type="hidden" name="code_challenge" value="${p.codeChallenge}" />
        <input type="hidden" name="resource" value="${p.resource ?? ""}" />
        ${existing ? html`<input type="hidden" name="connection_id" value="${existing.id}" /><p class="flash warn">You connected this client before. Approving updates that connection (“${existing.name}”) instead of creating a new one.</p>` : ""}
        ${connectionFields(accounts, values)}
        <div class="actions">
          <button type="submit" name="decision" value="approve" class="primary">Approve</button>
          <button type="submit" name="decision" value="deny">Deny</button>
        </div>
      </form>
    </section>`,
  );
}

export function oauthRouter(ctx: AppContext): Router {
  const router = Router();

  router.post("/register", (req: Request, res: Response) => {
    if (ctx.oauthClients.count() >= ctx.config.oauthMaxClients) {
      ctx.oauthClients.pruneUnused(24 * 3_600_000);
      if (ctx.oauthClients.count() >= ctx.config.oauthMaxClients) {
        res.status(403).json({ error: "access_denied", error_description: "Client registration limit reached." });
        return;
      }
    }
    const parsed = registrationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "Malformed registration request." });
      return;
    }
    const body = parsed.data;
    for (const uri of body.redirect_uris) {
      const check = validateRedirectUri(uri, ctx.config);
      if (!check.ok) {
        res.status(400).json({ error: "invalid_redirect_uri", error_description: check.reason });
        return;
      }
    }
    const grantTypes = body.grant_types ?? ["authorization_code", "refresh_token"];
    if (!grantTypes.every((g) => g === "authorization_code" || g === "refresh_token")) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "Only authorization_code and refresh_token are supported." });
      return;
    }
    if (body.response_types && !body.response_types.every((r) => r === "code")) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "Only the code response type is supported." });
      return;
    }
    const { row, clientSecret } = ctx.oauthClients.register({
      clientName: body.client_name ?? "Unnamed client",
      redirectUris: body.redirect_uris,
      grantTypes,
      authMethod: body.token_endpoint_auth_method ?? "none",
      clientUri: body.client_uri ?? null,
      ip: req.ip ?? null,
    });
    ctx.activity.audit({ userId: null, action: "oauth.client.register", detail: { client_id: row.client_id, name: row.client_name }, ip: req.ip });
    res.status(201).json({
      client_id: row.client_id,
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(row.created_at / 1000),
      client_name: row.client_name,
      redirect_uris: body.redirect_uris,
      grant_types: grantTypes,
      response_types: ["code"],
      token_endpoint_auth_method: row.token_endpoint_auth_method,
      scope: normalizeScope(body.scope),
    });
  });

  router.get("/authorize", async (req: Request, res: Response) => {
    const result = await validateAuthorize(ctx, req.query as Record<string, unknown>);
    if (result.kind === "fatal") return errorPage(res, req, 400, "Authorization error", result.message);
    if (result.kind === "redirect") {
      allowFormActionTo(ctx, res, result.redirectUri);
      return redirectWithError(res, result.redirectUri, result.error, result.description, result.state);
    }
    if (!req.webUser || req.webUser.must_change_password === 1) {
      res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    renderConsent(ctx, req, res, result.params);
  });

  router.post("/authorize", requireLogin, verifyCsrf, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await validateAuthorize(ctx, {
      client_id: body.client_id,
      redirect_uri: body.redirect_uri,
      response_type: "code",
      scope: body.scope,
      state: body.state,
      code_challenge: body.code_challenge,
      code_challenge_method: "S256",
      resource: body.resource,
    });
    if (result.kind === "fatal") return errorPage(res, req, 400, "Authorization error", result.message);
    if (result.kind === "redirect") {
      allowFormActionTo(ctx, res, result.redirectUri);
      return redirectWithError(res, result.redirectUri, result.error, result.description, result.state);
    }
    const p = result.params;
    const user = req.webUser!;
    allowFormActionTo(ctx, res, p.redirectUri);

    if (body.decision !== "approve") {
      ctx.activity.audit({ userId: user.id, action: "oauth.authorize.denied", detail: { client_id: p.client.client_id }, ip: req.ip });
      return redirectWithError(res, p.redirectUri, "access_denied", "The user denied the request.", p.state);
    }

    const owned = new Set(ctx.accounts.listForUser(user.id).map((a) => a.id));
    const form = parseConnectionForm(body, owned, p.client.client_name);
    const existingId = typeof body.connection_id === "string" ? body.connection_id : null;
    const existing = existingId ? ctx.connections.findActiveForUser(existingId, user.id) : undefined;
    let connectionId: string;
    if (existing && existing.client_id === p.client.client_id) {
      ctx.connections.update(existing.id, user.id, form);
      connectionId = existing.id;
    } else {
      connectionId = ctx.connections.create({ userId: user.id, kind: "oauth", clientId: p.client.client_id, ...form }).id;
    }
    const scope = form.canTrade ? "trading:read trading:trade" : "trading:read";
    const code = ctx.connections.createAuthCode({
      client_id: p.client.client_id,
      user_id: user.id,
      connection_id: connectionId,
      redirect_uri: p.redirectUri,
      scope,
      code_challenge: p.codeChallenge,
      resource: p.resource,
      ttlMs: AUTH_CODE_TTL_MS,
    });
    ctx.activity.audit({ userId: user.id, action: "oauth.authorize.granted", detail: { client_id: p.client.client_id, connection_id: connectionId, scope }, ip: req.ip });
    const url = new URL(p.redirectUri);
    url.searchParams.set("code", code);
    if (p.state !== null) url.searchParams.set("state", p.state);
    res.redirect(302, url.toString());
  });

  router.post("/token", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    const auth = await authenticateClient(ctx, req);
    if (!auth.ok) {
      res.status(401).json({ error: auth.error, error_description: auth.description });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const grantType = str(body.grant_type);
    if (grantType === "authorization_code") return codeGrant(ctx, req, res, auth.client, body);
    if (grantType === "refresh_token") return refreshGrant(ctx, req, res, auth.client, body);
    res.status(400).json({ error: "unsupported_grant_type", error_description: "Unsupported grant_type." });
  });

  router.post("/revoke", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const auth = await authenticateClient(ctx, req);
    if (!auth.ok) {
      res.status(401).json({ error: auth.error, error_description: auth.description });
      return;
    }
    const token = str((req.body as Record<string, unknown>)?.token);
    if (token) ctx.connections.revokeByTokenValue(token, auth.client.client_id);
    res.status(200).end();
  });

  return router;
}

function issueTokens(
  ctx: AppContext,
  res: Response,
  input: { client: OAuthClientRow; userId: string; connectionId: string; scope: string; resource: string | null },
): void {
  const access = ctx.connections.issueAccessToken({
    userId: input.userId,
    connectionId: input.connectionId,
    clientId: input.client.client_id,
    scope: input.scope,
    resource: input.resource,
    ttlMs: ctx.config.oauthAccessTokenTtlMs,
  });
  const refresh = ctx.connections.createRefreshToken({
    userId: input.userId,
    connectionId: input.connectionId,
    clientId: input.client.client_id,
    accessTokenId: access.id,
    scope: input.scope,
    resource: input.resource,
    ttlMs: ctx.config.oauthRefreshTokenTtlMs,
  });
  ctx.oauthClients.markUsed(input.client.client_id);
  res.json({
    access_token: access.value,
    token_type: "Bearer",
    expires_in: Math.floor(ctx.config.oauthAccessTokenTtlMs / 1000),
    refresh_token: refresh,
    scope: input.scope,
  });
}

function codeGrant(ctx: AppContext, req: Request, res: Response, client: OAuthClientRow, body: Record<string, unknown>): void {
  const code = str(body.code);
  const redirectUri = str(body.redirect_uri);
  const verifier = str(body.code_verifier);
  if (!code || !redirectUri || !verifier) {
    res.status(400).json({ error: "invalid_request", error_description: "Missing code, redirect_uri or code_verifier." });
    return;
  }
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    res.status(400).json({ error: "invalid_grant", error_description: "Malformed code_verifier." });
    return;
  }
  const consumed = ctx.connections.consumeAuthCode(code);
  if (!consumed) {
    res.status(400).json({ error: "invalid_grant", error_description: "Invalid authorization code." });
    return;
  }
  const { row, replayed } = consumed;
  if (replayed) {
    // RFC 6749 §10.5: revoke everything issued from a replayed code.
    ctx.connections.revoke(row.connection_id);
    logger.warn("authorization code replay detected", { clientId: row.client_id });
    res.status(400).json({ error: "invalid_grant", error_description: "Authorization code already used." });
    return;
  }
  if (row.client_id !== client.client_id || row.expires_at <= Date.now() || row.redirect_uri !== redirectUri) {
    res.status(400).json({ error: "invalid_grant", error_description: "Authorization code is invalid for this request." });
    return;
  }
  if (!safeEqual(row.code_challenge, sha256Base64Url(verifier))) {
    res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed." });
    return;
  }
  const user = ctx.users.findById(row.user_id);
  const connection = ctx.connections.findById(row.connection_id);
  if (!user || user.is_active !== 1 || !connection || connection.revoked_at !== null) {
    res.status(400).json({ error: "invalid_grant", error_description: "Account or connection is unavailable." });
    return;
  }
  ctx.activity.audit({ userId: user.id, action: "oauth.token.issued", detail: { client_id: client.client_id, connection_id: connection.id }, ip: req.ip });
  issueTokens(ctx, res, { client, userId: user.id, connectionId: connection.id, scope: row.scope, resource: row.resource });
}

function refreshGrant(ctx: AppContext, req: Request, res: Response, client: OAuthClientRow, body: Record<string, unknown>): void {
  const token = str(body.refresh_token);
  if (!token) {
    res.status(400).json({ error: "invalid_request", error_description: "Missing refresh_token." });
    return;
  }
  const consumed = ctx.connections.consumeRefreshToken(token);
  if (!consumed) {
    res.status(400).json({ error: "invalid_grant", error_description: "Invalid refresh token." });
    return;
  }
  const { row, replayed } = consumed;
  if (replayed) {
    // A rotated refresh token was presented again: likely stolen. Revoke the connection's tokens.
    logger.warn("refresh token replay detected", { clientId: row.client_id, ip: req.ip });
    ctx.activity.audit({ userId: row.user_id, action: "oauth.refresh.replay", detail: { client_id: row.client_id, connection_id: row.connection_id }, ip: req.ip });
    res.status(400).json({ error: "invalid_grant", error_description: "Refresh token already used." });
    return;
  }
  if (row.client_id !== client.client_id || row.expires_at <= Date.now()) {
    res.status(400).json({ error: "invalid_grant", error_description: "Refresh token is invalid." });
    return;
  }
  const user = ctx.users.findById(row.user_id);
  const connection = ctx.connections.findById(row.connection_id);
  if (!user || user.is_active !== 1 || !connection || connection.revoked_at !== null) {
    res.status(400).json({ error: "invalid_grant", error_description: "Account or connection is unavailable." });
    return;
  }
  if (row.access_token_id) ctx.connections.revokeAccessToken(row.access_token_id);
  const scope = connection.can_trade === 1 ? "trading:read trading:trade" : "trading:read";
  issueTokens(ctx, res, { client, userId: user.id, connectionId: connection.id, scope, resource: row.resource });
}

// End-to-end smoke test: starts the server on a temp data dir and walks through
// OAuth (DCR + PKCE), MCP initialize/tools, and Bybit public market data via the candle cache.
// Usage: npm run build && node scripts/smoke-test.mjs
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 18080 + Math.floor(Math.random() * 1000);

// Minimal CONNECT proxy to verify OUTBOUND_PROXY routing (Bybit requests must pass through it).
const proxySeen = [];
const proxy = http.createServer((_req, res) => res.writeHead(405).end());
proxy.on("connect", (req, client, head) => {
  const [host, port] = req.url.split(":");
  proxySeen.push(host);
  const upstream = net.connect(Number(port) || 443, host, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const PROXY_PORT = proxy.address().port;

// Minimal SOCKS5 server (no auth) in front of it, like a NetBird netstack sidecar (OUTBOUND_PROXY_VIA).
const socksSeen = [];
const socks = net.createServer((c) => {
  c.once("data", () => {
    c.write(Buffer.from([5, 0]));
    c.once("data", (req) => {
      let host, off;
      if (req[3] === 1) { host = [...req.subarray(4, 8)].join("."); off = 8; }
      else { const n = req[4]; host = req.subarray(5, 5 + n).toString(); off = 5 + n; }
      const port = req.readUInt16BE(off);
      socksSeen.push(`${host}:${port}`);
      const up = net.connect(port, host, () => {
        c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        up.pipe(c);
        c.pipe(up);
      });
      up.on("error", () => c.destroy());
      c.on("error", () => up.destroy());
    });
  });
});
await new Promise((r) => socks.listen(0, "127.0.0.1", r));
const SOCKS_PORT = socks.address().port;
const BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), "floorbroker-smoke-"));
const env = {
  ...process.env,
  PORT: String(PORT),
  PUBLIC_URL: BASE,
  DATA_DIR: dataDir,
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "smoke-test-password-123",
  LOG_LEVEL: "warn",
  OUTBOUND_PROXY: `http://127.0.0.1:${PROXY_PORT}`,
  OUTBOUND_PROXY_PLATFORMS: "bybit",
  OUTBOUND_PROXY_VIA: `socks5://127.0.0.1:${SOCKS_PORT}`,
};

let failures = 0;
const check = (cond, label, extra) => {
  console.log(`${cond ? "✓" : "✗"} ${label}${extra !== undefined ? ` — ${typeof extra === "string" ? extra : JSON.stringify(extra).slice(0, 300)}` : ""}`);
  if (!cond) failures++;
};

const server = spawn(process.execPath, ["dist/index.js"], { env, stdio: ["ignore", "inherit", "inherit"] });
const stop = () => {
  server.kill("SIGTERM");
  proxy.close();
  socks.close();
  rmSync(dataDir, { recursive: true, force: true });
};

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}

let cookies = {};
const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
function keepCookies(res) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    const v = pair.slice(i + 1);
    if (v === "") delete cookies[pair.slice(0, i)];
    else cookies[pair.slice(0, i)] = v;
  }
}
async function web(pathname, init = {}) {
  const res = await fetch(BASE + pathname, { redirect: "manual", ...init, headers: { cookie: cookieHeader(), ...(init.headers ?? {}) } });
  keepCookies(res);
  return res;
}
const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
const form = (obj) => new URLSearchParams(obj).toString();

try {
  await waitUp();
  check(true, "server started");

  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  check(prm.resource === `${BASE}/mcp`, "protected resource metadata", prm.resource);
  const asm = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  check(asm.registration_endpoint === `${BASE}/oauth/register`, "authorization server metadata");

  const unauth = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check(unauth.status === 401 && (unauth.headers.get("www-authenticate") ?? "").includes("resource_metadata"), "MCP without token → 401 + WWW-Authenticate");

  // Dynamic client registration
  const redirect = "http://127.0.0.1:9999/callback";
  const reg = await (await fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Smoke Agent", redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
  })).json();
  check(typeof reg.client_id === "string", "dynamic client registration", reg.client_id);

  // Sign in
  let res = await web("/login");
  let page = await res.text();
  res = await web("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ _csrf: csrfOf(page), username: "admin", password: env.ADMIN_PASSWORD, next: "/" }) });
  check(res.status === 302 && Object.keys(cookies).some((k) => k.includes("fb_session")), "web sign-in");

  // Add a Bybit account directly (public market data works with dummy keys).
  const { loadConfig } = await import(path.resolve("dist/config.js"));
  const { openAppDb } = await import(path.resolve("dist/db/app.js"));
  const { AccountRepo } = await import(path.resolve("dist/repos/accounts.js"));
  const { UserRepo } = await import(path.resolve("dist/repos/users.js"));
  Object.assign(process.env, env);
  const cfg = loadConfig();
  const db = openAppDb(cfg.appDbPath);
  const admin = new UserRepo(db).findByUsername("admin");
  const acct = new AccountRepo(db, cfg.encryptionKey).create({
    userId: admin.id, platform: "bybit", label: "Smoke Bybit", environment: "live", agentEnvironment: "demo",
    credentials: { apiKey: "dummy", apiSecret: "dummy", region: "global" }, meta: {}, externalId: null, description: "smoke", currency: "USD", canTrade: true,
  });
  // A second account in EUR plus balance snapshots, so the dashboard shows two currency groups and a total.
  const { PnlRepo } = await import(path.resolve("dist/repos/pnl.js"));
  const accounts = new AccountRepo(db, cfg.encryptionKey);
  const acct2 = accounts.create({
    userId: admin.id, platform: "bybit", label: "Smoke EUR", environment: "demo", agentEnvironment: "demo",
    credentials: { apiKey: "dummy2", apiSecret: "dummy2", region: "global" }, meta: {}, externalId: null, description: "smoke", currency: "EUR", canTrade: false,
  });
  const pnlRepo = new PnlRepo(db);
  const now = Date.now();
  pnlRepo.addSnapshot({ account_id: acct.id, ts: now - 3600_000, currency: "USD", equity: 110, balance: 110, unrealized_pnl: 0, positions: 0 });
  pnlRepo.addSnapshot({ account_id: acct.id, ts: now, currency: "USD", equity: 109, balance: 108, unrealized_pnl: 1, positions: 1 });
  pnlRepo.addSnapshot({ account_id: acct2.id, ts: now - 3600_000, currency: "EUR", equity: 500, balance: 500, unrealized_pnl: 0, positions: 0 });
  pnlRepo.addSnapshot({ account_id: acct2.id, ts: now, currency: "EUR", equity: 505, balance: 503, unrealized_pnl: 2, positions: 1 });
  db.close();
  check(!!acct.id && !!acct2.id, "account rows and snapshots created");

  // Authorization code + PKCE
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: `${BASE}/mcp` });
  res = await web(`/oauth/authorize?${q}`);
  page = await res.text();
  check(res.status === 200 && page.includes("Smoke Agent") && page.includes("Smoke Bybit"), "consent page shows client and account");
  res = await web("/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ _csrf: csrfOf(page), client_id: reg.client_id, redirect_uri: redirect, scope: "", state: "xyz", code_challenge: challenge, resource: `${BASE}/mcp`, decision: "approve", name: "Smoke Agent", accounts: acct.id, can_trade: "0" }),
  });
  const loc = new URL(res.headers.get("location") ?? "http://x/");
  const code = loc.searchParams.get("code");
  check(res.status === 302 && !!code && loc.searchParams.get("state") === "xyz", "consent approve → code");

  let tok = await (await fetch(`${BASE}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier }),
  })).json();
  check(typeof tok.access_token === "string" && typeof tok.refresh_token === "string" && tok.scope === "trading:read", "token exchange", tok.scope);

  const replay = await fetch(`${BASE}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier }) });
  check(replay.status === 400, "auth code replay rejected");
  // The replay revoked that connection; authorize again to continue.
  res = await web(`/oauth/authorize?${q}`);
  page = await res.text();
  res = await web("/oauth/authorize", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ _csrf: csrfOf(page), client_id: reg.client_id, redirect_uri: redirect, scope: "", state: "xyz", code_challenge: challenge, resource: `${BASE}/mcp`, decision: "approve", name: "Smoke Agent", accounts: acct.id, can_trade: "0" }),
  });
  const code2 = new URL(res.headers.get("location")).searchParams.get("code");
  tok = await (await fetch(`${BASE}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ grant_type: "authorization_code", code: code2, redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier }) })).json();

  const refreshed = await (await fetch(`${BASE}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id }) })).json();
  check(typeof refreshed.access_token === "string", "refresh token grant");
  const access = refreshed.access_token;

  let rpcId = 0;
  async function rpc(method, params) {
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${access}`, "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    return r.json();
  }
  async function call(name, args) {
    const r = await rpc("tools/call", { name, arguments: args });
    const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.error);
    return { isError: !!r.result?.isError || !!r.error, data: JSON.parse(text) };
  }

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  check(init.result?.serverInfo?.name === "floorbroker" && init.result?.instructions?.includes("real money"), "MCP initialize");
  const tools = (await rpc("tools/list", {})).result?.tools?.map((t) => t.name) ?? [];
  check(tools.includes("get_candles") && !tools.includes("place_order"), "read-only connection lists no trading tools", tools.join(","));

  const la = await call("list_accounts", {});
  check(!la.isError && la.data.accounts?.[0]?.environment === "demo", "list_accounts shows agent environment (demo) for a live account", la.data.accounts?.[0]);

  const s = await call("search_instruments", { account_id: acct.id, query: "BTCUSDT", limit: 5 });
  check(!s.isError && s.data.instruments?.length > 0, "search_instruments", s.data.instruments?.map((i) => i.id));

  const inst = await call("get_instrument", { account_id: acct.id, instrument_id: "linear:BTCUSDT" });
  check(!inst.isError && inst.data.instrument?.size_unit, "get_instrument", inst.data.instrument?.size_unit);

  const qt = await call("get_quotes", { account_id: acct.id, instrument_ids: ["linear:BTCUSDT", "spot:ETHUSDT"] });
  check(!qt.isError && qt.data.quotes?.length === 2, "get_quotes", qt.data.quotes?.map((x) => x.bid));

  const c1 = await call("get_candles", { account_id: acct.id, instrument_id: "linear:BTCUSDT", resolution: "1h", limit: 100 });
  check(!c1.isError && c1.data.count >= 99 && c1.data.fetched_from_platform > 0, "get_candles first call fetches", { count: c1.data.count, fetched: c1.data.fetched_from_platform });
  const c2 = await call("get_candles", { account_id: acct.id, instrument_id: "linear:BTCUSDT", resolution: "1h", limit: 100 });
  check(!c2.isError && c2.data.count >= 99 && c2.data.fetched_from_platform <= 2, "get_candles second call served from cache", { count: c2.data.count, fetched: c2.data.fetched_from_platform });
  const c3 = await call("get_candles", { account_id: acct.id, instrument_id: "linear:BTCUSDT", resolution: "1h", limit: 100, cache_only: true });
  check(!c3.isError && c3.data.fetched_from_platform === 0 && c3.data.count >= 98, "get_candles cache_only", c3.data.count);

  check(proxySeen.includes("api.bybit.com"), "Bybit requests go through OUTBOUND_PROXY", [...new Set(proxySeen)]);
  check(socksSeen.includes(`127.0.0.1:${PROXY_PORT}`), "OUTBOUND_PROXY is reached through OUTBOUND_PROXY_VIA (SOCKS5)", [...new Set(socksSeen)]);

  const cov = await call("list_cached_candles", { account_id: acct.id });
  check(!cov.isError && cov.data.ranges?.length === 1, "list_cached_candles", cov.data.ranges);

  const bad = await call("get_candles", { account_id: "nope", instrument_id: "x", resolution: "1h" });
  check(bad.isError && bad.data.error === "not_found", "unknown account rejected");

  const pos = await call("get_positions", { account_id: acct.id });
  check(pos.isError && pos.data.error === "auth_failed", "authenticated call with dummy key → auth_failed", pos.data.message);

  // Strategies: save, backtest on real Bybit history, paper run on the live stream, stop.
  const guide = await call("get_strategy_guide", {});
  check(!guide.isError && guide.data.guide.includes("ctx.order"), "get_strategy_guide");
  const broken = await call("save_strategy", { name: "Broken", code: "const strategy = { data: [ };" });
  check(broken.isError && /does not load/.test(broken.data.message), "save_strategy rejects code that does not load", broken.data.message);
  const stratCode = `const strategy = {
    name: "smoke ema",
    params: { fast: 5, slow: 20 },
    data: [{ instrument: "linear:BTCUSDT", resolution: "1h", history: 50 }],
    ticks: ["linear:BTCUSDT"],
    onStart(ctx) { ctx.log("start", ctx.params.fast, ctx.params.slow); },
    onTick(ctx, q) { if (!ctx.state.ticked) { ctx.state.ticked = true; ctx.log("first tick", q.bid, q.ask); } },
    onCandle(ctx, bar) {
      const c = ta.closes(ctx.candles(bar.instrument, "1h", 60));
      const f = ta.ema(c, ctx.params.fast), s = ta.ema(c, ctx.params.slow);
      const pos = ctx.position(bar.instrument);
      const size = ctx.roundSize(bar.instrument, ctx.account().equity * 0.5 / bar.c);
      if (ta.crossOver(f, s) && (!pos || pos.side === "short")) { if (pos) ctx.close(bar.instrument); ctx.buy(bar.instrument, size, { stopLoss: ctx.roundPrice(bar.instrument, bar.c * 0.97), tag: "long" }); }
      if (ta.crossUnder(f, s) && (!pos || pos.side === "long")) { if (pos) ctx.close(bar.instrument); ctx.sell(bar.instrument, size, { stopLoss: ctx.roundPrice(bar.instrument, bar.c * 1.03), tag: "short" }); }
    },
  };`;
  const saved = await call("save_strategy", { name: "Smoke EMA", code: stratCode, note: "first" });
  check(!saved.isError && saved.data.version === 1 && saved.data.declaration?.handlers?.includes("onCandle"), "save_strategy", saved.data);
  const sid = saved.data.strategy_id;
  const bt = await call("backtest_strategy", { strategy_id: sid, account_id: acct.id, from: new Date(Date.now() - 20 * 86400_000).toISOString(), initial_equity: 1000 });
  check(!bt.isError && bt.data.bars_processed > 400 && typeof bt.data.check?.return_pct === "number" && bt.data.total?.closed_trades > 0, "backtest_strategy on Bybit history",
    bt.isError ? bt.data : { bars: bt.data.bars_processed, total: bt.data.total, check: bt.data.check?.return_pct, stopped: bt.data.stopped_early });
  const started = await call("start_strategy", { strategy_id: sid, account_id: acct.id, mode: "paper", paper_equity: 1000 });
  check(!started.isError && started.data.status === "running", "start_strategy paper (read-only connection)", started.data);
  const liveDenied = await call("start_strategy", { strategy_id: sid, account_id: acct.id, mode: "live" });
  check(liveDenied.isError && liveDenied.data.error === "permission_denied", "start_strategy live denied on a read-only connection", liveDenied.data.message);
  let runInfo = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    runInfo = await call("get_strategy_run", { run_id: started.data.run_id });
    if (runInfo.data.logs?.some((l) => l.includes("first tick"))) break;
  }
  check(!runInfo.isError && runInfo.data.logs?.some((l) => l.includes("first tick")) && runInfo.data.stream === "connected", "paper run receives live ticks", { stream: runInfo.data.stream, logs: runInfo.data.logs });
  for (const p of ["/strategies", `/strategies/${sid}`, `/strategies/runs/${started.data.run_id}`]) {
    const r = await web(p);
    check(r.status === 200, `GET ${p}`, r.status);
  }
  const stopped = await call("stop_strategy", { run_id: started.data.run_id });
  check(!stopped.isError && stopped.data.status === "stopped", "stop_strategy", stopped.data);
  const listed = await call("list_strategies", {});
  check(!listed.isError && listed.data.strategies?.length === 1 && listed.data.runs?.length === 1, "list_strategies", listed.data.runs);

  // UI pages render
  for (const p of ["/", `/accounts/${acct.id}`, "/accounts", "/accounts/new", "/accounts/new?platform=bybit", "/accounts/new?platform=ig", "/activity", "/connections", "/admin", "/account"]) {
    const r = await web(p);
    check(r.status === 200, `GET ${p}`, r.status);
  }
  const addPage = await (await web("/accounts/new?platform=bybit")).text();
  check(/sees this server as <code>[0-9a-f.:]+<\/code> \(via outbound proxy/.test(addPage), "Bybit add page shows egress IP via proxy");
  const dash = await (await web("/")).text();
  const totalEq = /Total · 2 accounts · in EUR[\s\S]*?Equity<\/span><strong>([0-9.,]+) EUR/.exec(dash)?.[1];
  const totalVal = totalEq ? Number(totalEq.replace(/,/g, "")) : NaN;
  check(totalVal > 590 && totalVal < 620 && dash.includes("ECB reference rates"), "dashboard total converts USD + EUR into EUR", totalEq);
  const act = await (await web("/activity")).text();
  check(act.includes("get_candles"), "activity log records tool calls");
} catch (err) {
  console.error(err);
  failures++;
} finally {
  stop();
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

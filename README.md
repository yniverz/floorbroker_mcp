# floorbroker

A self-hosted **MCP server that lets AI agents trade** on several platforms through one generic tool
interface, plus a small web UI to track what the agents do and how your accounts perform.

- **One interface, many platforms.** Agents see the same tools (`get_positions`, `place_order`, `get_candles`, …)
  whether the account is on Bybit or IG. Platforms are adapters behind a single TypeScript interface, so
  Binance or others can be added later without touching the MCP side.
- **OAuth 2.1 for cloud agents.** Add it as a custom connector in Claude or ChatGPT by pasting a URL. On the
  consent screen you choose which accounts the agent may use, read-only or trading, and optional risk limits.
- **Multi-user.** Every user (you, a friend) has their own platform accounts and agents and only sees their own data.
- **Tracking UI.** Equity curves, daily realized PnL, open positions/orders, and a full log of every agent tool call.
- **Historic data cache.** Finished candles are stored once and served from the local cache forever, which
  matters for platforms with data allowances (IG: 10,000 points per week).

Supported platforms: **Bybit** (spot, perpetuals, futures, options; live, demo trading, testnet; all regional
hosts) and **IG** (CFD and spread-bet accounts; live and demo).

> ⚠️ AI agents can lose real money quickly. Start with demo or testnet accounts, use read-only connections
> until you trust an agent, and consider the per-connection risk limits.

---

## How it works

```
Claude / ChatGPT / any MCP client
        │  Streamable HTTP + OAuth 2.1 (or a personal token)
        ▼
  /mcp  ── generic tools ── risk checks ── activity log
        │
        ├── Bybit adapter ── Bybit v5 REST
        └── IG adapter ───── IG REST (session-based)

  Web UI (accounts, agents, activity, PnL)      SQLite: app.db + marketdata.db
```

1. Create an API key on your platform (or a sub-account and a key for it). **Never enable withdrawals**,
   keys that can withdraw are refused.
2. In the web UI, **Accounts → Add account**, choose the platform and paste the credentials. They are
   verified and stored encrypted.
3. Connect your agent to `https://<your-host>/mcp`. Sign in when asked, pick the accounts, the permission
   (read only / trade) and optional risk limits.
4. The agent can now read prices, history, balances, positions and orders, and trade if allowed.

### Live vs. demo, for you and for the agent

Each account has two independent settings:

| Setting | Meaning | Where it shows |
| --- | --- | --- |
| **Environment** | The real platform system the key belongs to (Bybit live / demo trading / testnet, IG live / demo). | UI badges, PnL totals (demo never mixes into live totals) |
| **What agents are told** | `live` or `demo`, reported to the agent in every account, position and order result. | MCP |

So you can, for example, let an agent believe a demo account is live. The UI then shows `DEMO` plus
`agent sees LIVE`. Agents are always instructed to treat every account as real money.

---

## MCP tools

Read tools are always available. Trading tools are only listed for connections with the *trade* permission.

| Tool | Purpose |
| --- | --- |
| `list_accounts` | Accounts available to this agent, with environment, capabilities, platform notes and risk limits. |
| `get_account` | Equity, balance, available funds, unrealized PnL, margin, per-asset balances. |
| `search_instruments` | Find instruments by name/symbol; returns the platform instrument ids. |
| `get_instrument` | Trading rules: size unit, min/max size, steps, tick, contract size, leverage, expiry/strike, min stop distance, market status. |
| `get_quotes` | Bid/ask/last, 24h stats, funding (perps), greeks/IV (options). |
| `get_order_book` | Level-2 book (Bybit). |
| `get_candles` | Historic OHLC(V) through the cache; reports the platform's data quota. |
| `list_cached_candles` | Which ranges are already stored locally (free to read). |
| `get_positions` | Open positions with PnL, leverage, liquidation price, SL/TP. |
| `get_orders` | Open orders or order history. |
| `get_fills` | Executions with fees. |
| `get_closed_pnl` | Closed positions with realized PnL. |
| `place_order` | market / limit / stop / stop_limit, TIF, reduce-only, attached SL/TP, trailing and guaranteed stops where supported. |
| `amend_order` | Change price, trigger, size, SL/TP. |
| `cancel_order` / `cancel_all_orders` | Cancel one or all open orders. |
| `close_position` | Close fully or partially, market or limit. |
| `set_position_protection` | Set or remove SL / TP / trailing stop on a position. |
| `set_leverage` | Per-instrument leverage (Bybit). |

Capabilities differ per platform (e.g. IG has no order book or leverage setting), and `list_accounts` tells the
agent which apply. Unsupported calls return a clear `unsupported` error.

### Risk limits (optional, per connection)

- max order notional and max position notional per instrument (in the instrument's quote currency)
- max leverage (applies to `set_leverage`)
- allowed instruments (ids, trailing `*` matches a prefix, e.g. `linear:BTC*`)

Closing and reduce-only orders are always allowed, so an agent can always exit.

---

## Deploy with Portainer

The GitHub Actions workflow publishes `ghcr.io/yniverz/floorbroker_mcp:latest` (amd64 + arm64) on every push to `main`.
New GHCR packages are private: either make the package public (GitHub → Packages → floorbroker_mcp → settings)
or add ghcr.io registry credentials in Portainer.

1. **Stacks → Add stack → Repository**, URL of this repo, compose path `docker-compose.yml`
   (or paste the compose file into the web editor).
2. Set the environment variables:

| Variable | Example | Notes |
| --- | --- | --- |
| `PUBLIC_URL` | `https://trade.example.com` | External origin, no path. |
| `ENCRYPTION_KEY` | *(random)* | `openssl rand -base64 32`. **Back it up**; without it stored API keys are unreadable. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / *(≥12 chars)* | Only used to create the first account on first start. |
| `BIND_HOST` / `HOST_PORT` | `127.0.0.1` / `8080` | Published address; keep on loopback behind the proxy, or use your proxy network. |
| `TRUST_PROXY` | `1` | Proxy hops whose `X-Forwarded-For` is trusted. |
| `ALLOWED_HOSTS` | | Extra `Host` values if your proxy rewrites `Host`. |
| `OAUTH_ALLOWED_REDIRECT_HOSTS` | `claude.ai,chatgpt.com` | Optional: only these clients may register. |
| `SNAPSHOT_INTERVAL_MIN` / `PNL_SYNC_INTERVAL_MIN` | `5` / `15` | Equity snapshot and realized-PnL sync intervals. |
| `OUTBOUND_PROXY` | `http://10.0.0.5:8888` | Optional HTTP proxy for platform API calls (static egress IP, see below). |
| `OUTBOUND_PROXY_PLATFORMS` | `bybit` | Platforms routed through `OUTBOUND_PROXY` (`*` = all). |
| `OUTBOUND_PROXY_VIA` | `socks5://netbird:1080` | Optional SOCKS5 hop used to reach `OUTBOUND_PROXY` (e.g. a VPN sidecar). |

See [.env.example](.env.example) for everything else.

3. Deploy, then point your reverse proxy at the container.

### Reverse proxy / NetBird

Cloud agents (Claude, ChatGPT) call the server **from their own infrastructure**, so these paths must be
reachable from the public internet:

| Path | Who calls it |
| --- | --- |
| `/mcp` | the agent platform (bearer token) |
| `/.well-known/oauth-protected-resource*`, `/.well-known/oauth-authorization-server*`, `/.well-known/openid-configuration` | the agent platform |
| `/oauth/register`, `/oauth/token`, `/oauth/revoke` | the agent platform |
| `/oauth/authorize` | **your browser** (consent screen) |

Everything else (`/`, `/login`, `/accounts`, `/assets`, …) is the web UI and can stay behind NetBird SSO.
`/oauth/authorize` and `/login` only need to be reachable from your browser, so behind NetBird is fine as long
as you're on NetBird while connecting an agent. Note that the consent screen loads `/assets/style.css` and posts
to `/login`; keep those reachable from the same browser.

Also: terminate TLS at the proxy, forward the original `Host` (or set `ALLOWED_HOSTS`), set `X-Forwarded-For`,
and don't add a path prefix.

### Static egress IP (Bybit IP binding)

Bybit keys should be bound to fixed IPs (unbound keys expire). If floorbroker runs behind a dynamic IP, run a
small forward proxy on a host with a static IP (e.g. tinyproxy on a VPS, reachable only over your VPN, allowing
`CONNECT` to port 443 for the Bybit API hosts only) and set `OUTBOUND_PROXY`. TLS stays end to end; the proxy
never sees API secrets. The Bybit "add account" page shows the IP Bybit will see, so you know what to bind.

If the proxy is only reachable over a mesh VPN and the Docker host can't run a kernel VPN client (no
`/dev/net/tun`, e.g. inside an LXC), add a VPN sidecar in userspace mode and point `OUTBOUND_PROXY_VIA` at its
SOCKS5 port. NetBird example:

```yaml
  netbird:
    image: netbirdio/netbird:0.83.1
    environment:
      NB_SETUP_KEY: ${NB_SETUP_KEY}
      NB_MANAGEMENT_URL: https://netbird.example.com
      NB_HOSTNAME: floorbroker
      NB_USE_NETSTACK_MODE: "true"
      NB_SOCKS5_LISTENER_ADDRESS: 0.0.0.0
      NB_SOCKS5_LISTENER_PORT: "1080"
      NB_DISABLE_DNS: "true"
      NB_DISABLE_CLIENT_ROUTES: "true"
      NB_BLOCK_INBOUND: "true"
    volumes: [netbird-state:/var/lib/netbird]
  floorbroker:
    environment:
      OUTBOUND_PROXY: http://<proxy mesh IP>:8888
      OUTBOUND_PROXY_VIA: socks5://netbird:1080
```

### Data

The volume `/data` holds two SQLite files:

- `app.db`: users, encrypted credentials, agent connections, OAuth state, activity log, equity snapshots, closed PnL. **Back this up.**
- `marketdata.db`: the shared historic candle cache. Can grow large; safe to delete, it refills on demand.

---

## Connecting agents

**Claude** (claude.ai, Desktop, mobile): Settings → Connectors → *Add custom connector* → `https://<host>/mcp`.

**ChatGPT**: Settings → Apps & Connectors → enable Developer mode → *Create* → URL `https://<host>/mcp`, authentication OAuth.

**Claude Code / other clients**: OAuth works too, or create a personal token under **Agents** and use

```bash
claude mcp add --transport http floorbroker https://<host>/mcp --header "Authorization: Bearer fb_pat_..."
```

Re-connecting the same client updates its existing connection instead of creating a new one. Connections can
be edited (accounts, permission, limits) or revoked at any time under **Agents**; changes apply to the next request.

---

## Platform notes

### Bybit
- Create a **system-generated (HMAC)** API key: Read-Write, with Orders + Positions (Unified Trading / Contract),
  Spot and Options trade as needed. **No withdrawal or transfer permissions.** Binding an IP is recommended.
- Environments: *Live* (pick your region host: global, EU, NL, TR, KZ, GE, AE, HK, ID), *Demo trading*
  (keys created in Bybit's demo mode), *Testnet*.
- Bind the key to the IP shown on the add-account page (set `OUTBOUND_PROXY` if your server has no static IP).
- Sizes are in base coin for spot/linear/options and in USD contracts for inverse. Spot holdings appear as
  balances, not positions. Options have no candle history on Bybit.

### IG
- Needs your **username, password and API key** (My IG → Settings → API keys). Demo accounts need a separate
  demo login and demo API key.
- One IG login can hold several accounts (CFD, spread bet). Leave *Account ID* empty for the preferred account.
- Sizes are contracts (CFD) or stake per point (spread bet). Positions net by default. Markets have trading
  hours and minimum stop distances (see `get_instrument`).
- Historic prices cost allowance (10,000 points/week). The cache and the `quota` field help the agent stay within it.

---

## Live data streams

Adapters can offer a live stream (`PlatformClient.stream()`), used through floorbroker's
`StreamService`. It is the foundation for server-side strategies (in progress) and needs no
configuration: a stream connects on the first subscription and closes when nothing is subscribed.

| | Bybit | IG |
|---|---|---|
| Transport | WebSockets (`stream.bybit.com`, one per category) | Lightstreamer text protocol over HTTP streaming |
| Prices | `tickers.<symbol>` (bid/ask/last) | `PRICE:<accountId>:<epic>` via the `Pricing` adapter |
| Candles | `kline.<interval>.<symbol>`, all intervals | `CHART:<epic>:1MINUTE / 5MINUTE / HOUR` |
| Own orders, fills, positions | private WebSocket (`order`, `execution`, `position`) | `TRADE:<accountId>` (OPU / WOU / CONFIRMS) |

- **Shared subscriptions:** several subscribers to the same topic share one platform subscription.
- **Reconnects:** with backoff and full resubscription. IG rebinds on `LOOP` and logs in again when the session tokens expire.
- **Completed candles go into the candle cache,** so live history is free (IG's weekly price allowance is not touched).
- **Aggregation:** resolutions a platform does not stream natively are built from smaller candles in UTC buckets (e.g. IG 15m from 5m, 4h from 1h; up to 12h).
- **Account switches:** when an account's credentials or settings change, its subscriptions move to the new client automatically.
- **Status:** the account page shows a "Live stream" line while something is subscribed.
- **Check tool:** `node dist/tools/streamCheck.js <account-id> <instrument-id> [resolution] [seconds] [--account-events]` is a read-only check that subscribes and prints what arrives.
- **Proxy:** Bybit's private stream uses the IP-bound API key, so it leaves through `OUTBOUND_PROXY` like REST calls. The proxy must allow the stream hosts (`stream.bybit.com`, `stream-demo.bybit.com`, `stream-testnet.bybit.com`). Public market data connects directly.

## Adding a platform

1. Create `src/platforms/<name>/` exporting a `PlatformDefinition` (see [src/platforms/types.ts](src/platforms/types.ts)):
   credential fields (the UI builds its form from them), environments, capabilities, setup help, and a
   `createClient()` returning a `PlatformClient`.
2. Implement the client methods using the generic types; throw `PlatformError` with actionable messages;
   refuse credentials that can withdraw funds in `validate()`.
3. Register it in [src/platforms/registry.ts](src/platforms/registry.ts).

The MCP tools, risk checks, candle cache, PnL tracking and UI pick it up automatically.

---

## Development

```bash
npm install
npm run build
ENCRYPTION_KEY=$(openssl rand -base64 32) ADMIN_PASSWORD=change-me-please PUBLIC_URL=http://localhost:8080 npm start
```

`npm test` builds and runs [scripts/smoke-test.mjs](scripts/smoke-test.mjs): it starts a throwaway server and
walks through OAuth (registration, PKCE, refresh, code replay), MCP initialize/tools, and Bybit public market
data through the candle cache.

### Status

The OAuth flow, MCP layer, UI and Bybit public market data are tested end to end. **Authenticated platform
calls (balances, orders, trading) have not been exercised against real accounts yet.** Verify each platform
on demo/testnet before giving an agent a live account.

## Security

- Platform credentials are encrypted with AES-256-GCM, bound to their account row.
- Keys with withdrawal permission are refused (Bybit); IG's API cannot withdraw.
- Passwords: scrypt; account lockout; rate-limited login; `HttpOnly`/`Secure`/`SameSite` cookies; CSRF tokens.
- OAuth 2.1: PKCE (S256) required, exact redirect URI matching, rotating refresh tokens, code replay revokes the
  grant, RFC 8707 resource binding, Client ID Metadata Documents with SSRF guards.
- The UI uses no JavaScript and a strict CSP. MCP requests are checked for `Origin` and `Host`.

## License

[Non-Commercial Public Use License (NCPUL) v1.3](LICENSE.md)

import { getPlatform } from "../platforms/registry.js";
import type { PlatformAccountRow } from "../repos/accounts.js";
import type { RiskLimits } from "../repos/connections.js";
import { envBadges } from "./layout.js";
import { html, type Html } from "./html.js";

export interface ConnectionFormValues {
  name: string;
  canTrade: boolean;
  accountIds: string[];
  risk: RiskLimits;
}

/** Shared fields for the OAuth consent page and the connection edit page. */
export function connectionFields(accounts: PlatformAccountRow[], v: ConnectionFormValues): Html {
  const r = v.risk;
  const numVal = (n: number | undefined) => (n === undefined ? "" : String(n));
  return html`
    <label>Name
      <input type="text" name="name" maxlength="120" required value="${v.name}" />
    </label>

    <fieldset>
      <legend>Accounts this agent may use</legend>
      ${accounts.length === 0
        ? html`<p class="muted">You have no platform accounts yet. You can approve now and add accounts to this connection later under <a href="/accounts">Accounts</a>.</p>`
        : accounts.map(
            (a) => html`<label class="check">
              <input type="checkbox" name="accounts" value="${a.id}" ${v.accountIds.includes(a.id) ? "checked" : ""} />
              <span><strong>${a.label}</strong> · ${getPlatform(a.platform)?.name ?? a.platform} ${envBadges(a)}
              ${a.is_active !== 1 ? html`<span class="badge muted">disabled</span>` : ""}
              ${a.can_trade !== 1 ? html`<span class="badge muted">read-only key</span>` : ""}</span>
            </label>`,
          )}
    </fieldset>

    <fieldset>
      <legend>Permission</legend>
      <label class="check"><input type="radio" name="can_trade" value="0" ${!v.canTrade ? "checked" : ""} /> <span><strong>Read only</strong> – balances, positions, orders, prices, history</span></label>
      <label class="check"><input type="radio" name="can_trade" value="1" ${v.canTrade ? "checked" : ""} /> <span><strong>Trade</strong> – also place, change and cancel orders and close positions</span></label>
    </fieldset>

    <details ${r.maxOrderNotional !== undefined || r.maxPositionNotional !== undefined || r.maxLeverage !== undefined || (r.allowedInstruments?.length ?? 0) > 0 ? "open" : ""}>
      <summary>Risk limits (optional)</summary>
      <p class="muted small">Leave empty for no limit. Notional values are in each instrument's quote currency (e.g. USDT for BTCUSDT, EUR for a EUR-quoted CFD). Closing and reduce-only orders are always allowed.</p>
      <div class="grid2">
        <label>Max order notional <input type="number" step="any" min="0" name="max_order_notional" value="${numVal(r.maxOrderNotional)}" /></label>
        <label>Max position notional per instrument <input type="number" step="any" min="0" name="max_position_notional" value="${numVal(r.maxPositionNotional)}" /></label>
        <label>Max leverage <input type="number" step="any" min="1" name="max_leverage" value="${numVal(r.maxLeverage)}" /></label>
      </div>
      <label>Allowed instruments <span class="muted small">(one id per line, trailing * matches a prefix, e.g. <code>linear:BTC*</code>; empty = all)</span>
        <textarea name="allowed_instruments" rows="3">${(r.allowedInstruments ?? []).join("\n")}</textarea>
      </label>
    </details>`;
}

function optNum(v: unknown): number | undefined {
  if (typeof v !== "string" || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function parseConnectionForm(body: Record<string, unknown>, ownedAccountIds: Set<string>, fallbackName: string): ConnectionFormValues {
  const raw = body.accounts;
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const accountIds = list.filter((x): x is string => typeof x === "string" && ownedAccountIds.has(x));
  const risk: RiskLimits = {};
  const maxOrder = optNum(body.max_order_notional);
  const maxPos = optNum(body.max_position_notional);
  const maxLev = optNum(body.max_leverage);
  if (maxOrder !== undefined) risk.maxOrderNotional = maxOrder;
  if (maxPos !== undefined) risk.maxPositionNotional = maxPos;
  if (maxLev !== undefined) risk.maxLeverage = maxLev;
  const allowed =
    typeof body.allowed_instruments === "string"
      ? body.allowed_instruments
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 200)
      : [];
  if (allowed.length > 0) risk.allowedInstruments = allowed;
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : fallbackName;
  return { name, canTrade: body.can_trade === "1", accountIds, risk };
}

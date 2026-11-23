/** Minimal auto-escaping HTML templating: html`<p>${userValue}</p>` escapes, raw() and nested html`` do not. */
export class Html {
  constructor(public readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function raw(value: string): Html {
  return new Html(value);
}

export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  return esc(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) out += render(values[i]) + (strings[i + 1] ?? "");
  return new Html(out);
}

// --- formatting ---------------------------------------------------------------

export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtSmart(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
  return v.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function fmtMoney(v: number | null | undefined, ccy?: string | null): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  return `${fmtNum(v, 2)}${ccy ? " " + ccy : ""}`;
}

export function fmtSigned(v: number | null | undefined, ccy?: string | null): Html {
  if (v === null || v === undefined || !Number.isFinite(v)) return html`<span class="muted">–</span>`;
  const cls = v > 0 ? "pos" : v < 0 ? "neg" : "";
  return html`<span class="${cls}">${v > 0 ? "+" : ""}${fmtNum(v, 2)}${ccy ? " " + ccy : ""}</span>`;
}

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return "–";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function fmtAgo(ms: number | null | undefined): string {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

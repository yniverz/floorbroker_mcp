import { esc, fmtNum, raw, type Html } from "./html.js";

export interface Point {
  t: number;
  v: number;
}

const W = 760;
const H = 220;
const PAD = { l: 64, r: 12, t: 12, b: 26 };

function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) {
    const d = Math.abs(min) * 0.01 || 1;
    min -= d;
    max += d;
  }
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

/** Horizontal position in the outer (unscaled) SVG, as a percentage of the chart width. */
function pct(x: number): string {
  return `${((x / W) * 100).toFixed(3)}%`;
}

/** Extends ticks by whole steps until they cover [lo, hi] (niceTicks only returns ticks inside the range). */
function coveringTicks(lo: number, hi: number): number[] {
  const ticks = niceTicks(lo, hi);
  const step = ticks.length > 1 ? ticks[1]! - ticks[0]! : Math.abs(hi - lo) || Math.abs(lo) * 0.01 || 1;
  while (ticks[0]! > lo) ticks.unshift(Number((ticks[0]! - step).toPrecision(12)));
  while (ticks[ticks.length - 1]! < hi) ticks.push(Number((ticks[ticks.length - 1]! + step).toPrecision(12)));
  return ticks;
}

/**
 * Shapes (grid, area, line, bars) live in an inner SVG that stretches with the
 * container (viewBox + preserveAspectRatio="none"); text and hover dots live in the
 * outer SVG with percentage x positions, so they are never distorted.
 */
function frame(cls: string, shapes: string, overlay: string): Html {
  return raw(
    `<svg class="${cls}" width="100%" height="${H}" role="img">` +
      `<svg x="0" y="0" width="100%" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" overflow="visible">${shapes}</svg>` +
      `${overlay}</svg>`,
  );
}

function timeLabel(t: number, span: number): string {
  const d = new Date(t);
  if (span <= 2 * 86_400_000) return d.toISOString().slice(11, 16);
  if (span <= 120 * 86_400_000) return d.toISOString().slice(5, 10);
  return d.toISOString().slice(0, 7);
}

function empty(message: string): Html {
  return raw(
    `<svg class="chart" width="100%" height="${H}" role="img"><text x="50%" y="${H / 2}" text-anchor="middle" class="axis">${esc(message)}</text></svg>`,
  );
}

/** Server-rendered line/area chart (no client JavaScript). Hover a point for its value. */
export function lineChart(points: Point[], opts: { unit?: string; emptyText?: string; baseline?: number } = {}): Html {
  if (points.length < 2) return empty(opts.emptyText ?? "Not enough data yet");
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const values = points.map((p) => p.v);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (opts.baseline !== undefined) {
    min = Math.min(min, opts.baseline);
    max = Math.max(max, opts.baseline);
  }
  const ticks = niceTicks(min, max);
  min = Math.min(min, ticks[0]!);
  max = Math.max(max, ticks[ticks.length - 1]!);
  const x = (t: number) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - min) / Math.max(1e-12, max - min)) * (H - PAD.t - PAD.b);

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area = `${line}L${x(t1).toFixed(1)},${(H - PAD.b).toFixed(1)}L${x(t0).toFixed(1)},${(H - PAD.b).toFixed(1)}Z`;
  const rising = points[points.length - 1]!.v >= points[0]!.v;
  const grid = ticks
    .map((v) => `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/>`)
    .join("");
  const yLabels = ticks
    .map((v) => `<text x="${pct(PAD.l - 6)}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="axis">${esc(fmtNum(v, Math.abs(max - min) < 10 ? 2 : 0))}</text>`)
    .join("");
  const xt = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const t = t0 + f * (t1 - t0);
      return `<text x="${pct(x(t))}" y="${H - 6}" text-anchor="${f === 0 ? "start" : f === 1 ? "end" : "middle"}" class="axis">${esc(timeLabel(t, t1 - t0))}</text>`;
    })
    .join("");
  const step = Math.max(1, Math.floor(points.length / 120));
  const dots = points
    .filter((_, i) => i % step === 0 || i === points.length - 1)
    .map(
      (p) =>
        `<circle cx="${pct(x(p.t))}" cy="${y(p.v).toFixed(1)}" r="5" class="hit"><title>${esc(new Date(p.t).toISOString().slice(0, 16).replace("T", " "))}  ${esc(fmtNum(p.v, 2))}${opts.unit ? " " + esc(opts.unit) : ""}</title></circle>`,
    )
    .join("");
  const baseline =
    opts.baseline !== undefined
      ? `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(opts.baseline).toFixed(1)}" y2="${y(opts.baseline).toFixed(1)}" class="baseline"/>`
      : "";
  return frame(
    `chart ${rising ? "up" : "down"}`,
    `${grid}${baseline}<path d="${area}" class="area"/><path d="${line}" class="line"/>`,
    `${yLabels}${dots}${xt}`,
  );
}

/** Bars around zero, green/red. Used for daily realized PnL. */
export function barChart(points: Point[], opts: { unit?: string; emptyText?: string } = {}): Html {
  if (points.length === 0) return empty(opts.emptyText ?? "No closed trades in this range");
  const values = points.map((p) => p.v);
  const ticks = coveringTicks(Math.min(0, ...values), Math.max(0, ...values));
  const min = ticks[0]!;
  const max = ticks[ticks.length - 1]!;
  const y = (v: number) => PAD.t + (1 - (v - min) / Math.max(1e-12, max - min)) * (H - PAD.t - PAD.b);
  const n = points.length;
  const slot = (W - PAD.l - PAD.r) / n;
  const bw = Math.max(2, Math.min(28, slot * 0.7));
  const grid = ticks
    .map((v) => `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/>`)
    .join("");
  const yLabels = ticks
    .map((v) => `<text x="${pct(PAD.l - 6)}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="axis">${esc(fmtNum(v, Math.abs(max - min) < 10 ? 2 : 0))}</text>`)
    .join("");
  const bars = points
    .map((p, i) => {
      const cx = PAD.l + slot * i + slot / 2;
      const y0 = y(0);
      const y1 = y(p.v);
      return `<rect x="${(cx - bw / 2).toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(y1 - y0)).toFixed(1)}" class="${p.v >= 0 ? "bar-pos" : "bar-neg"}"><title>${esc(new Date(p.t).toISOString().slice(0, 10))}  ${esc(fmtNum(p.v, 2))}${opts.unit ? " " + esc(opts.unit) : ""}</title></rect>`;
    })
    .join("");
  const labelEvery = Math.max(1, Math.ceil(n / 6));
  const xt = points
    .map((p, i) =>
      i % labelEvery === 0 ? `<text x="${pct(PAD.l + slot * i + slot / 2)}" y="${H - 6}" text-anchor="middle" class="axis">${esc(new Date(p.t).toISOString().slice(5, 10))}</text>` : "",
    )
    .join("");
  return frame("chart", `${grid}${bars}`, `${yLabels}${xt}`);
}

/** Tiny inline trend line for account cards. */
export function sparkline(points: Point[]): Html {
  if (points.length < 2) return raw("");
  const w = 120;
  const h = 32;
  const vs = points.map((p) => p.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const d = points
    .map((p, i) => `${i ? "L" : "M"}${(((p.t - t0) / Math.max(1, t1 - t0)) * w).toFixed(1)},${(h - 2 - ((p.v - min) / Math.max(1e-12, max - min)) * (h - 4)).toFixed(1)}`)
    .join("");
  const up = vs[vs.length - 1]! >= vs[0]!;
  return raw(`<svg class="spark ${up ? "up" : "down"}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${d}"/></svg>`);
}

/**
 * Compact area chart without axes (e.g. next to summary numbers). Same split as the
 * big charts: shapes stretch in an inner SVG, hover dots stay round in the outer one.
 */
export function miniChart(points: Point[], opts: { unit?: string } = {}): Html {
  if (points.length < 2) return raw("");
  const MW = 400;
  const MH = 96;
  const pad = 4;
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const vs = points.map((p) => p.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * MW;
  const y = (v: number) => pad + (1 - (v - min) / Math.max(1e-12, max - min)) * (MH - 2 * pad);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area = `${line}L${MW},${MH}L0,${MH}Z`;
  const up = vs[vs.length - 1]! >= vs[0]!;
  const step = Math.max(1, Math.floor(points.length / 60));
  const dots = points
    .filter((_, i) => i % step === 0 || i === points.length - 1)
    .map(
      (p) =>
        `<circle cx="${((x(p.t) / MW) * 100).toFixed(3)}%" cy="${y(p.v).toFixed(1)}" r="4" class="hit"><title>${esc(new Date(p.t).toISOString().slice(0, 16).replace("T", " "))}  ${esc(fmtNum(p.v, 2))}${opts.unit ? " " + esc(opts.unit) : ""}</title></circle>`,
    )
    .join("");
  return raw(
    `<svg class="chart mini-chart ${up ? "up" : "down"}" width="100%" height="${MH}" role="img">` +
      `<svg x="0" y="0" width="100%" height="${MH}" viewBox="0 0 ${MW} ${MH}" preserveAspectRatio="none" overflow="visible"><path d="${area}" class="area"/><path d="${line}" class="line"/></svg>` +
      `${dots}</svg>`,
  );
}

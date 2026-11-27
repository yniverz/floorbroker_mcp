/**
 * JavaScript evaluated inside every strategy sandbox before the strategy code.
 * It provides `ctx` (the strategy API) and `ta` (indicators). The sandbox has no
 * network, files or timers; the only bridge to floorbroker is `__host(op, json)`,
 * which answers synchronously with JSON. Order actions are only recorded as intents
 * and executed by floorbroker after the handler returns.
 *
 * Must not contain backticks or template placeholders (it is embedded as a string).
 */
export const PRELUDE = String.raw`
"use strict";
var __now = 0;
var __intents = [];
var __seq = 0;
var __logs = [];
var __state = {};
var __params = {};

Date.now = function () { return __now; };

function __call(op, args) {
  var out = __host(op, JSON.stringify(args === undefined ? null : args));
  return out === "" ? null : JSON.parse(out);
}
function __fmt(v) {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}
function __intent(kind, payload) {
  __seq += 1;
  var id = "s" + __now.toString(36) + "-" + __seq;
  payload.kind = kind;
  payload.localId = id;
  __intents.push(payload);
  return id;
}

var ctx = {
  get now() { return __now; },
  get params() { return __params; },
  get state() { return __state; },
  set state(v) { __state = v && typeof v === "object" ? v : {}; },

  candles: function (instrument, resolution, count) { return __call("candles", [instrument, resolution, count || 100]) || []; },
  lastPrice: function (instrument) { return __call("lastPrice", [instrument]); },
  position: function (instrument) { return __call("position", [instrument]); },
  orders: function (instrument) { return __call("orders", [instrument || null]) || []; },
  account: function () { return __call("account", []); },
  instrument: function (instrument) { return __call("instrument", [instrument]); },

  roundSize: function (instrument, size) {
    var r = ctx.instrument(instrument);
    if (!r || !(size > 0)) return 0;
    var step = r.sizeStep || r.minSize || 0;
    var s = step > 0 ? Math.floor(size / step + 1e-9) * step : size;
    s = Number(s.toFixed(10));
    return r.minSize && s < r.minSize ? 0 : s;
  },
  roundPrice: function (instrument, price) {
    var r = ctx.instrument(instrument);
    if (!r || !r.priceTick) return price;
    return Number((Math.round(price / r.priceTick) * r.priceTick).toFixed(10));
  },

  order: function (o) {
    if (!o || typeof o !== "object") throw new Error("ctx.order needs an object");
    return __intent("order", {
      instrument: o.instrument, side: o.side, type: o.type || "market", size: o.size,
      price: o.price, triggerPrice: o.triggerPrice, stopLoss: o.stopLoss, takeProfit: o.takeProfit,
      reduceOnly: !!o.reduceOnly, tag: o.tag || null
    });
  },
  buy: function (instrument, size, opts) {
    var o = Object.assign({}, opts || {}, { instrument: instrument, side: "buy", size: size });
    return ctx.order(o);
  },
  sell: function (instrument, size, opts) {
    var o = Object.assign({}, opts || {}, { instrument: instrument, side: "sell", size: size });
    return ctx.order(o);
  },
  cancel: function (idOrTag) { return __intent("cancel", { target: idOrTag }); },
  cancelAll: function (instrument) { return __intent("cancelAll", { instrument: instrument || null }); },
  close: function (instrument, size) { return __intent("close", { instrument: instrument, size: size || null }); },
  protect: function (instrument, p) {
    p = p || {};
    return __intent("protect", { instrument: instrument, stopLoss: p.stopLoss, takeProfit: p.takeProfit });
  },
  log: function () {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(__fmt(arguments[i]));
    __logs.push({ t: __now, msg: parts.join(" ").slice(0, 2000) });
    if (__logs.length > 200) __logs.shift();
  }
};

// ---- indicators: arrays in, arrays out (same length, null where undefined) ----
var ta = {
  closes: function (bars) { return bars.map(function (b) { return b.c; }); },
  highs: function (bars) { return bars.map(function (b) { return b.h; }); },
  lows: function (bars) { return bars.map(function (b) { return b.l; }); },
  last: function (arr, back) { back = back || 0; var v = arr[arr.length - 1 - back]; return v === undefined ? null : v; },
  sma: function (v, n) {
    var out = new Array(v.length).fill(null), sum = 0;
    for (var i = 0; i < v.length; i++) { sum += v[i]; if (i >= n) sum -= v[i - n]; if (i >= n - 1) out[i] = sum / n; }
    return out;
  },
  ema: function (v, n) {
    var out = new Array(v.length).fill(null), k = 2 / (n + 1), prev = null, sum = 0;
    for (var i = 0; i < v.length; i++) {
      if (i < n) { sum += v[i]; if (i === n - 1) { prev = sum / n; out[i] = prev; } continue; }
      prev = v[i] * k + prev * (1 - k); out[i] = prev;
    }
    return out;
  },
  stdev: function (v, n) {
    var out = new Array(v.length).fill(null);
    for (var i = n - 1; i < v.length; i++) {
      var s = 0, q = 0;
      for (var j = i - n + 1; j <= i; j++) { s += v[j]; q += v[j] * v[j]; }
      var m = s / n; out[i] = Math.sqrt(Math.max(0, q / n - m * m));
    }
    return out;
  },
  rsi: function (v, n) {
    var out = new Array(v.length).fill(null), g = 0, l = 0;
    for (var i = 1; i < v.length; i++) {
      var d = v[i] - v[i - 1], up = d > 0 ? d : 0, dn = d < 0 ? -d : 0;
      if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } continue; }
      g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  },
  atr: function (bars, n) {
    var out = new Array(bars.length).fill(null), prev = null, sum = 0;
    for (var i = 0; i < bars.length; i++) {
      var b = bars[i], pc = i > 0 ? bars[i - 1].c : b.c;
      var tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
      if (i < n) { sum += tr; if (i === n - 1) { prev = sum / n; out[i] = prev; } continue; }
      prev = (prev * (n - 1) + tr) / n; out[i] = prev;
    }
    return out;
  },
  bollinger: function (v, n, k) {
    k = k === undefined ? 2 : k;
    var mid = ta.sma(v, n), sd = ta.stdev(v, n);
    return {
      mid: mid,
      upper: mid.map(function (m, i) { return m === null ? null : m + k * sd[i]; }),
      lower: mid.map(function (m, i) { return m === null ? null : m - k * sd[i]; })
    };
  },
  highest: function (v, n) {
    var out = new Array(v.length).fill(null);
    for (var i = n - 1; i < v.length; i++) { var m = -Infinity; for (var j = i - n + 1; j <= i; j++) if (v[j] > m) m = v[j]; out[i] = m; }
    return out;
  },
  lowest: function (v, n) {
    var out = new Array(v.length).fill(null);
    for (var i = n - 1; i < v.length; i++) { var m = Infinity; for (var j = i - n + 1; j <= i; j++) if (v[j] < m) m = v[j]; out[i] = m; }
    return out;
  },
  crossOver: function (a, b) {
    var n = a.length, bv = Array.isArray(b) ? b : null;
    if (n < 2) return false;
    var a1 = a[n - 2], a2 = a[n - 1], b1 = bv ? bv[n - 2] : b, b2 = bv ? bv[n - 1] : b;
    return a1 !== null && b1 !== null && a2 !== null && b2 !== null && a1 <= b1 && a2 > b2;
  },
  crossUnder: function (a, b) {
    var n = a.length, bv = Array.isArray(b) ? b : null;
    if (n < 2) return false;
    var a1 = a[n - 2], a2 = a[n - 1], b1 = bv ? bv[n - 2] : b, b2 = bv ? bv[n - 1] : b;
    return a1 !== null && b1 !== null && a2 !== null && b2 !== null && a1 >= b1 && a2 < b2;
  }
};

function __describe() {
  if (typeof strategy !== "object" || strategy === null) throw new Error("The code must define a global object named strategy (const strategy = { ... }).");
  var data = Array.isArray(strategy.data) ? strategy.data : [];
  if (data.length === 0) throw new Error("strategy.data must list at least one candle feed: [{ instrument, resolution, history }].");
  var handlers = ["onStart", "onCandle", "onTick", "onFill", "onOrder", "onStop"].filter(function (h) { return typeof strategy[h] === "function"; });
  return JSON.stringify({
    name: typeof strategy.name === "string" ? strategy.name : null,
    params: strategy.params && typeof strategy.params === "object" ? strategy.params : {},
    data: data,
    ticks: Array.isArray(strategy.ticks) ? strategy.ticks : [],
    handlers: handlers
  });
}

function __init(paramsJson, stateJson) {
  __params = Object.assign({}, strategy.params || {}, JSON.parse(paramsJson) || {});
  __state = JSON.parse(stateJson) || {};
}

/** After a handler threw: drop its order intents (never half-execute), keep its logs. */
function __abort() {
  var out = JSON.stringify({ logs: __logs });
  __intents = [];
  __logs = [];
  return out;
}

function __dispatch(handler, now, payloadJson) {
  __now = now;
  var fn = strategy[handler];
  if (typeof fn === "function") fn.call(strategy, ctx, payloadJson ? JSON.parse(payloadJson) : undefined);
  var out = JSON.stringify({ intents: __intents, logs: __logs, state: __state });
  __intents = [];
  __logs = [];
  return out;
}
`;

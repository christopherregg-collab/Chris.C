// Indicators for the momentum backtester. Pure functions over arrays; a value is
// null until there is enough history. Candles are oldest-first:
// { time (ms, bar open), open, high, low, close, volume }.

import { ema } from "../indicators.js";

export { sma, ema } from "../indicators.js";

function trueRange(c, prev) {
  if (!prev) return c.high - c.low;
  return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
}

/** Wilder's ATR, seeded with the simple average of the first `period` true ranges. */
export function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trueRange(candles[i], candles[i - 1]);
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + trueRange(candles[i], candles[i - 1])) / period;
    out[i] = prev;
  }
  return out;
}

/** Wilder's ADX. The first value appears at index 2 * period - 1. */
export function adx(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < 2 * period) return out;
  let sTr = 0, sPlus = 0, sMinus = 0;
  const dx = [];
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const up = c.high - p.high;
    const down = p.low - c.low;
    const plusDm = up > down && up > 0 ? up : 0;
    const minusDm = down > up && down > 0 ? down : 0;
    const tr = trueRange(c, p);
    if (i <= period) {
      sTr += tr; sPlus += plusDm; sMinus += minusDm;
      if (i < period) continue;
    } else {
      sTr = sTr - sTr / period + tr;
      sPlus = sPlus - sPlus / period + plusDm;
      sMinus = sMinus - sMinus / period + minusDm;
    }
    const pdi = sTr === 0 ? 0 : (100 * sPlus) / sTr;
    const mdi = sTr === 0 ? 0 : (100 * sMinus) / sTr;
    const sum = pdi + mdi;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum;
  }
  // First ADX = mean of DX over indices period .. 2*period-1, then Wilder smoothing.
  let first = 0;
  for (let i = period; i < 2 * period; i++) first += dx[i];
  let prev = first / period;
  out[2 * period - 1] = prev;
  for (let i = 2 * period; i < n; i++) {
    prev = (prev * (period - 1) + dx[i]) / period;
    out[i] = prev;
  }
  return out;
}

/**
 * Donchian channel of the `period` bars BEFORE each bar (the current bar is
 * excluded, so "close above the upper band" is a real breakout).
 */
export function donchian(candles, period) {
  const n = candles.length;
  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period; j < i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    upper[i] = hi;
    lower[i] = lo;
  }
  return { upper, lower };
}

/** Average of the `period` values BEFORE each index (current excluded). */
export function trailingMean(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i >= period) out[i] = sum / period;
    sum += values[i];
    if (i >= period) sum -= values[i - period];
  }
  return out;
}

/**
 * Groups candles into a higher timeframe (`ms` long, aligned to UTC).
 * Each output bar has `end` (exclusive) and `complete` (all source bars present).
 */
export function resample(candles, ms, sourceMs) {
  const out = [];
  let cur = null;
  for (const c of candles) {
    const start = Math.floor(c.time / ms) * ms;
    if (!cur || cur.time !== start) {
      cur = { time: start, end: start + ms, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, bars: 0 };
      out.push(cur);
    }
    cur.high = Math.max(cur.high, c.high);
    cur.low = Math.min(cur.low, c.low);
    cur.close = c.close;
    cur.volume += c.volume;
    cur.bars++;
  }
  const expected = Math.round(ms / sourceMs);
  for (const b of out) { b.complete = b.bars === expected; delete b.bars; }
  return out;
}

/**
 * Higher-timeframe trend for every source bar, using only HTF bars that had
 * closed by the time the source bar closed (no lookahead).
 * Returns +1 (close above EMA), -1 (below) or 0 (not enough history).
 */
export function htfTrend(candles, sourceMs, htfMs, emaPeriod) {
  const htf = resample(candles, htfMs, sourceMs).filter((b) => b.complete);
  const closes = htf.map((b) => b.close);
  const line = ema(closes, emaPeriod);
  const out = new Array(candles.length).fill(0);
  let k = -1;
  for (let i = 0; i < candles.length; i++) {
    const closeTime = candles[i].time + sourceMs;
    while (k + 1 < htf.length && htf[k + 1].end <= closeTime) k++;
    if (k >= 0 && line[k] !== null) out[i] = closes[k] > line[k] ? 1 : closes[k] < line[k] ? -1 : 0;
  }
  return out;
}


/**
 * Annualized volatility: standard deviation of log returns over the last `period` bars
 * (up to and including each bar), scaled by sqrt(periodsPerYear).
 */
export function realizedVol(candles, period, periodsPerYear) {
  const out = new Array(candles.length).fill(null);
  const r = candles.map((c, i) => (i === 0 ? 0 : Math.log(c.close / candles[i - 1].close)));
  for (let i = period; i < candles.length; i++) {
    let sum = 0, sq = 0;
    for (let j = i - period + 1; j <= i; j++) { sum += r[j]; sq += r[j] * r[j]; }
    const mean = sum / period;
    const variance = Math.max(0, sq / period - mean * mean);
    out[i] = Math.sqrt(variance) * Math.sqrt(periodsPerYear);
  }
  return out;
}

// Technical indicators and signal scoring. Pure functions, shared by the
// browser (signals panel) and Node (tests). Candles are oldest-first:
// { time, open, high, low, close, volume }.

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// Seeded with the SMA of the first `period` values, as most charting tools do.
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's RSI.
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = toRsi(gain, loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = toRsi(gain, loss);
  }
  return out;
}

function toRsi(gain, loss) {
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const line = values.map((_, i) =>
    fastEma[i] === null || slowEma[i] === null ? null : fastEma[i] - slowEma[i]);
  const start = line.findIndex((v) => v !== null);
  const signal = new Array(values.length).fill(null);
  if (start !== -1) {
    ema(line.slice(start), signalPeriod).forEach((v, i) => { signal[start + i] = v; });
  }
  const histogram = line.map((v, i) => (v === null || signal[i] === null ? null : v - signal[i]));
  return { line, signal, histogram };
}

// True when `series` changed sign (negative -> positive for "up") within the last `lookback` bars.
function crossedWithin(series, lookback, direction) {
  const n = series.length;
  for (let i = n - 1; i > n - 1 - lookback && i > 0; i--) {
    const a = series[i - 1];
    const b = series[i];
    if (a === null || b === null) continue;
    if (direction === "up" && a <= 0 && b > 0) return true;
    if (direction === "down" && a >= 0 && b < 0) return true;
  }
  return false;
}

export const MIN_CANDLES = 60;

const LABELS = [
  [3, "Strong buy"],
  [1, "Buy"],
  [0, "Neutral"],
  [-2, "Sell"],
  [-Infinity, "Strong sell"],
];

// Scores three independent checks (trend, momentum, RSI) from -1 to +1 each,
// sums them into -3..+3 and maps the total to a label.
export function evaluate(candles, opts = {}) {
  const { rsiPeriod = 14, fastEma = 20, slowEma = 50, crossLookback = 3 } = opts;
  if (!Array.isArray(candles) || candles.length < MIN_CANDLES) {
    throw new Error(`need at least ${MIN_CANDLES} candles, got ${candles ? candles.length : 0}`);
  }
  const closes = candles.map((c) => c.close);
  const last = closes.length - 1;

  const emaFast = ema(closes, fastEma);
  const emaSlow = ema(closes, slowEma);
  const spread = closes.map((_, i) =>
    emaFast[i] === null || emaSlow[i] === null ? null : emaFast[i] - emaSlow[i]);
  const rsiSeries = rsi(closes, rsiPeriod);
  const m = macd(closes);

  const checks = [];

  const up = spread[last] > 0;
  checks.push({
    id: "trend",
    name: `EMA ${fastEma}/${slowEma}`,
    score: up ? 1 : -1,
    note: crossedWithin(spread, crossLookback, up ? "up" : "down")
      ? (up ? "Golden cross" : "Death cross")
      : (up ? "Uptrend" : "Downtrend"),
  });

  const hist = m.histogram[last];
  const bull = hist > 0;
  checks.push({
    id: "macd",
    name: "MACD",
    score: bull ? 1 : -1,
    note: crossedWithin(m.histogram, crossLookback, bull ? "up" : "down")
      ? (bull ? "Bullish cross" : "Bearish cross")
      : (bull ? "Above signal" : "Below signal"),
  });

  const r = rsiSeries[last];
  checks.push({
    id: "rsi",
    name: `RSI ${rsiPeriod}`,
    score: r < 30 ? 1 : r > 70 ? -1 : 0,
    note: r < 30 ? "Oversold" : r > 70 ? "Overbought" : "Neutral",
  });

  const score = checks.reduce((s, c) => s + c.score, 0);
  const label = LABELS.find(([min]) => score >= min)[1];

  return {
    time: candles[last].time,
    price: closes[last],
    changePct: ((closes[last] - closes[0]) / closes[0]) * 100,
    rsi: r,
    macd: { line: m.line[last], signal: m.signal[last], histogram: hist },
    ema: { fast: emaFast[last], slow: emaSlow[last] },
    checks,
    score,
    label,
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { sma, ema, rsi, macd, evaluate, MIN_CANDLES } from "../lib/indicators.js";

const close = (n) => Math.round(n * 1e6) / 1e6;
const candlesFrom = (closes) => closes.map((c, i) => ({ time: i * 3600, open: c, high: c, low: c, close: c, volume: 1 }));

test("sma averages a sliding window", () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test("ema seeds with the sma, then smooths", () => {
  const out = ema([1, 2, 3, 4, 5], 3);
  assert.deepEqual(out.slice(0, 2), [null, null]);
  assert.equal(out[2], 2);
  assert.equal(out[3], 3); // 4*0.5 + 2*0.5
  assert.equal(out[4], 4);
});

test("rsi matches Wilder's reference values", () => {
  // Classic Wilder / StockCharts example. Exact first RSI(14) is 70.46 (avg gain 0.2386,
  // avg loss 0.1); StockCharts shows 70.53 because it rounds the averages.
  const prices = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
    45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64];
  const out = rsi(prices, 14);
  assert.equal(out[13], null);
  assert.ok(Math.abs(out[14] - 70.46) < 0.01, `got ${out[14]}`);
});

test("rsi is 100 for only gains and 50 for a flat line", () => {
  assert.equal(rsi([1, 2, 3, 4, 5, 6], 3)[5], 100);
  assert.equal(rsi([5, 5, 5, 5, 5], 3)[4], 50);
});

test("macd histogram is line minus signal", () => {
  const values = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 10);
  const m = macd(values);
  assert.equal(m.line[24], null);
  assert.notEqual(m.line[25], null);
  assert.equal(m.signal[32], null);
  assert.notEqual(m.signal[33], null);
  assert.equal(close(m.histogram[79]), close(m.line[79] - m.signal[79]));
});

test("evaluate rejects short histories", () => {
  assert.throws(() => evaluate(candlesFrom(new Array(MIN_CANDLES - 1).fill(1))), /at least/);
});

test("a steady uptrend scores bullish trend and momentum, overbought RSI", () => {
  const closes = Array.from({ length: 120 }, (_, i) => 100 * 1.01 ** i);
  const s = evaluate(candlesFrom(closes));
  const byId = Object.fromEntries(s.checks.map((c) => [c.id, c]));
  assert.equal(byId.trend.score, 1);
  assert.equal(byId.macd.score, 1);
  assert.equal(byId.rsi.note, "Overbought");
  assert.equal(s.score, 1);
  assert.equal(s.label, "Buy");
  assert.ok(s.changePct > 0);
});

test("an accelerating decline is a sell despite oversold RSI", () => {
  const closes = Array.from({ length: 120 }, (_, i) => 300 - i * i * 0.02);
  const s = evaluate(candlesFrom(closes));
  const byId = Object.fromEntries(s.checks.map((c) => [c.id, c]));
  assert.equal(byId.trend.score, -1);
  assert.equal(byId.macd.score, -1);
  assert.equal(byId.rsi.note, "Oversold");
  assert.equal(s.score, -1);
  assert.equal(s.label, "Sell");
});

test("a fresh reversal is reported as a cross", () => {
  // Long decline, then a sharp rally: fast EMA crosses above slow near the end.
  const closes = [
    ...Array.from({ length: 100 }, (_, i) => 200 - i),
    ...Array.from({ length: 30 }, (_, i) => 100 + i * 4),
  ];
  let crossedAt = -1;
  for (let n = 101; n <= closes.length; n++) {
    const trend = evaluate(candlesFrom(closes.slice(0, n))).checks.find((c) => c.id === "trend");
    if (trend.note === "Golden cross") { crossedAt = n; break; }
  }
  assert.ok(crossedAt > 100, "expected a golden cross during the rally");
});

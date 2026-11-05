import test from "node:test";
import assert from "node:assert/strict";
import { atr, adx, donchian, trailingMean, resample, htfTrend } from "../lib/backtest/ta.js";
import { createLadder } from "../lib/backtest/ladder.js";
import { runBacktest, signalAt } from "../lib/backtest/engine.js";
import { summarize, monteCarlo, maxDrawdown } from "../lib/backtest/stats.js";
import { syntheticMarket } from "../lib/backtest/synthetic.js";
import { parseCandle, fetchCandles, fetchSpecs, fetchFunding, barLabel } from "../lib/backtest/blofin-data.js";
import { COSTS, LADDER, LEVELS, LIMITS, STRATEGIES, DEFAULT_SPECS } from "../lib/backtest/settings.js";

const HOUR = 3_600_000;
const T0 = Date.UTC(2025, 0, 1);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

/** Candles from [open, high, low, close] tuples, one per hour. */
const bars = (rows, start = T0) => rows.map(([open, high, low, close], i) => ({ time: start + i * HOUR, open, high, low, close, volume: 1 }));
/** `n` quiet bars around `price`, each with a high-low range of 2. */
const flat = (n, price = 100) => Array.from({ length: n }, () => [price, price + 1, price - 1, price]);

// Simple test strategy: 3-bar breakout, no trend/ADX/volume filters, 2 ATR stop.
const TEST_STRATEGY = {
  label: "Test", symbols: ["X"], barMs: HOUR, breakout: 3, exitChannel: 3, trendFilters: [],
  adxMin: 0, volumeMult: 0, stopAtr: 2, trailAtr: 100, pyramid: null,
};
const NO_COSTS = { ...COSTS, takerFee: 0, slippage: 0, defaultFundingRate: 0 };
const LEVEL = { label: "L", baseRisk: 0.01, step: 0.005, ceiling: 0.03, leverageCap: 100 };
const LIM = { dailyLossCap: 0.5, killSwitch: null, maxOpenPositions: 3 };
const SPECS = { X: { qtyStep: 1e-6, minQty: 1e-6 } };

function bt(rows, over = {}) {
  return runBacktest({
    strategy: TEST_STRATEGY, level: LEVEL, ladder: LADDER, limits: LIM, costs: NO_COSTS, specs: SPECS,
    data: { X: bars(rows) }, startEquity: 1000, ...over,
  });
}

// --- indicators -------------------------------------------------------------

test("atr of constant-range bars equals the range", () => {
  const a = atr(bars(flat(30)), 14);
  assert.equal(a[13], null);
  near(a[14], 2);
  near(a[29], 2);
});

test("adx is high in a steady trend and starts at 2*period-1", () => {
  const rows = Array.from({ length: 60 }, (_, i) => [100 + i, 101 + i, 99.5 + i, 100.8 + i]);
  const a = adx(bars(rows), 14);
  assert.equal(a[26], null);
  assert.notEqual(a[27], null);
  assert.ok(a[59] > 50, `adx ${a[59]}`);
});

test("donchian excludes the current bar", () => {
  const d = donchian(bars([[1, 5, 1, 1], [1, 3, 0, 1], [1, 9, 1, 1]]), 2);
  assert.equal(d.upper[1], null);
  assert.equal(d.upper[2], 5);
  assert.equal(d.lower[2], 0);
});

test("trailingMean averages the previous values only", () => {
  assert.deepEqual(trailingMean([1, 2, 3, 10], 2), [null, null, 1.5, 2.5]);
});

test("resample builds 4h bars and marks incomplete ones", () => {
  const out = resample(bars(flat(6)), 4 * HOUR, HOUR);
  assert.equal(out.length, 2);
  assert.equal(out[0].complete, true);
  assert.equal(out[1].complete, false);
});

test("htfTrend only uses higher-timeframe bars that have already closed", () => {
  // 2 complete 4h bars rising, so EMA(1) == close: trend is +1 only once a 4h bar closed.
  const rows = Array.from({ length: 8 }, (_, i) => [100 + i, 101 + i, 99 + i, 100 + i]);
  const tr = htfTrend(bars(rows), HOUR, 4 * HOUR, 2);
  // EMA(2) needs 2 closed 4h bars: available from the bar that closes the second 4h bar (index 7).
  assert.deepEqual(tr.slice(0, 7), [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(tr[7], 1);
});

// --- risk ladder ------------------------------------------------------------

test("ladder steps up on win streaks, resets on a loss, halves after two losses", () => {
  const l = createLadder({ baseRisk: 0.01, step: 0.005, ceiling: 0.02 }, LADDER);
  assert.equal(l.current(100, 100), 0.01);
  l.record(1);
  assert.equal(l.current(100, 100), 0.01);
  l.record(1);
  assert.equal(l.current(100, 100), 0.015);
  l.record(1);
  assert.equal(l.current(100, 100), 0.02);
  l.record(1);
  assert.equal(l.current(100, 100), 0.02, "capped at the ceiling");
  l.record(-1);
  assert.equal(l.current(100, 100), 0.01);
  l.record(-1);
  assert.equal(l.current(100, 100), 0.005);
  l.record(1);
  assert.equal(l.current(100, 100), 0.01, "a win restores base risk");
});

test("ladder caps risk at base while equity is >10% below its peak", () => {
  const l = createLadder({ baseRisk: 0.01, step: 0.01, ceiling: 0.05 }, LADDER);
  l.record(1); l.record(1); l.record(1);
  assert.equal(l.current(100, 100), 0.03);
  assert.equal(l.current(85, 100), 0.01);
});

// --- engine -----------------------------------------------------------------

test("breakout enters at the next open, sized so the stop risks 1% of equity", () => {
  const rows = [...flat(30), [100, 106, 100, 105], [106, 107, 105, 106], ...flat(3, 106)];
  const r = bt(rows);
  const t = r.trades[0];
  assert.equal(t.side, "long");
  assert.equal(t.openTime, T0 + 31 * HOUR, "filled on the bar after the signal");
  near(t.entryPrice, 106);
  // ATR at the signal bar: Wilder smoothing of 2s and the breakout bar's range of 6.
  const a = atr(bars(rows), 14)[30];
  near(t.qty, (1000 * 0.01) / (2 * a), 1e-6);
});

test("a gap through the stop fills at the open, not the stop", () => {
  const rows = [...flat(30), [100, 106, 100, 105], [106, 107, 105, 106], [90, 91, 85, 88], ...flat(2, 88)];
  const r = bt(rows);
  const t = r.trades[0];
  assert.equal(t.reason, "stop");
  near(t.exitPrice, 90);
  assert.ok(t.r < -1, "gap loss is bigger than 1R");
});

test("fees and slippage are charged on both fills", () => {
  const rows = [...flat(30), [100, 106, 100, 105], [106, 107, 105, 106], ...flat(3, 106)];
  const costs = { ...NO_COSTS, takerFee: 0.001, slippage: 0.001 };
  const r = bt(rows, { costs });
  const t = r.trades[0];
  near(t.entryPrice, 106 * 1.001);
  assert.ok(r.fees > 0);
  near(r.endEquity, 1000 + t.pnl, 1e-6);
});

test("short breakouts work the same way down", () => {
  const rows = [...flat(30), [100, 100, 94, 95], [94, 95, 93, 94], ...flat(3, 94)];
  const t = bt(rows).trades[0];
  assert.equal(t.side, "short");
  near(t.entryPrice, 94);
});

test("leverage cap limits position size", () => {
  const rows = [...flat(30), [100, 106, 100, 105], [106, 107, 105, 106], ...flat(3, 106)];
  const level = { ...LEVEL, baseRisk: 0.5, leverageCap: 2 };
  const t = bt(rows, { level }).trades[0];
  assert.ok(t.qty * 106 <= 2000 + 1e-6, `notional ${t.qty * 106}`);
});

test("orders below the minimum size are skipped", () => {
  const rows = [...flat(30), [100, 106, 100, 105], [106, 107, 105, 106], ...flat(3, 106)];
  const r = bt(rows, { specs: { X: { qtyStep: 1, minQty: 100 } } });
  assert.equal(r.trades.length, 0);
  assert.equal(r.skippedMinSize, 1);
});

test("a huge gap with high leverage liquidates the account", () => {
  const rows = [...flat(30), [100, 106, 100, 105], [106, 107, 105, 106], [40, 41, 30, 35], ...flat(2, 35)];
  const level = { ...LEVEL, baseRisk: 1, leverageCap: 20 };
  const r = bt(rows, { level });
  assert.equal(r.liquidations, 1);
  assert.equal(r.trades[0].reason, "liquidation");
  assert.equal(r.endEquity, 0, "the whole pot is lost, never below zero");
  near(r.trades[0].pnl, -1000, 1e-6);
});

test("pyramiding adds units as price moves and raises the stop", () => {
  const up = Array.from({ length: 12 }, (_, i) => {
    const p = 106 + i * 3;
    return [p, p + 3.5, p - 0.5, p + 3];
  });
  const rows = [...flat(30), [100, 106, 100, 105], ...up];
  const strategy = { ...TEST_STRATEGY, exitChannel: 50, pyramid: { maxAdds: 3, everyAtr: 1 } };
  const r = bt(rows, { strategy });
  const t = r.trades[0];
  assert.equal(t.adds, 3);
  assert.equal(t.reason, "end of test");
  assert.ok(t.r > 3, `pyramided trade R ${t.r}`);
});

test("daily loss cap flattens and blocks new entries for the day", () => {
  const rows = [...flat(30), [100, 106, 100, 105], [106, 107, 105, 106], [100, 101, 99, 100], ...flat(3, 100)];
  const r = bt(rows, { level: { ...LEVEL, baseRisk: 0.2 }, limits: { ...LIM, dailyLossCap: 0.05 } });
  assert.ok(r.events.some((e) => e.type === "daily loss cap"));
});

test("kill switch stops trading for good", () => {
  const rows = [...flat(30), [100, 106, 100, 105], [106, 107, 105, 106], [80, 81, 79, 80], ...flat(30, 80), [80, 90, 80, 89], ...flat(3, 89)];
  const r = bt(rows, { level: { ...LEVEL, baseRisk: 0.5 }, limits: { ...LIM, killSwitch: 0.25 } });
  assert.equal(r.killed, true);
  assert.equal(r.trades.length, 1, "no trades after the kill switch");
});

test("signals respect the higher-timeframe trend filter", () => {
  const strategy = { ...TEST_STRATEGY, trendFilters: [{ ms: 4 * HOUR, ema: 3 }] };
  // Downtrend for 40 bars, then one upside breakout: the 4h trend is still down, so no long.
  const rows = [...Array.from({ length: 40 }, (_, i) => [200 - i, 201 - i, 199 - i, 200 - i]), [161, 175, 161, 174]];
  const r = bt(rows, { strategy });
  assert.equal(r.trades.filter((t) => t.side === "long").length, 0);
});

test("the real strategies run on simulated data without errors", () => {
  for (const strategy of Object.values(STRATEGIES)) {
    const s = { ...strategy, symbols: strategy.symbols.slice(0, 3) };
    const hourly = syntheticMarket({ symbols: s.symbols, hours: 120 * 24 });
    const data = Object.fromEntries(Object.entries(hourly).map(([sym, c]) =>
      [sym, resample(c, s.barMs, HOUR).filter((x) => x.complete).map(({ end, complete, ...x }) => x)]));
    const specs = Object.fromEntries(s.symbols.map((sym) => [sym, DEFAULT_SPECS[sym] ?? { qtyStep: 1e-6, minQty: 1e-6 }]));
    for (const level of Object.values(LEVELS)) {
      const r = runBacktest({ strategy: s, level, ladder: LADDER, limits: LIMITS, costs: COSTS, specs, data, startEquity: 100 });
      const m = summarize(r);
      assert.ok(Number.isFinite(m.endEquity) && m.endEquity >= 0);
      for (const t of r.trades) assert.ok(Number.isFinite(t.pnl));
    }
  }
});

test("signalAt never fires before indicators are ready", () => {
  const data = syntheticMarket({ hours: 10 });
  const s = STRATEGIES.core;
  const r = runBacktest({ strategy: s, level: LEVELS.max, ladder: LADDER, limits: LIMITS, costs: COSTS, specs: DEFAULT_SPECS, data, startEquity: 100 });
  assert.equal(r.trades.length, 0);
  assert.equal(typeof signalAt, "function");
});

// --- stats ------------------------------------------------------------------

test("maxDrawdown measures the deepest fall from a peak", () => {
  near(maxDrawdown([100, 120, 90, 130, 117]), 0.25);
});

test("monteCarlo is reproducible and shows no drawdown when every trade wins", () => {
  const trades = [{ r: 2 }, { r: 1 }];
  const a = monteCarlo(trades, LEVELS.max, LADDER, { runs: 200, tradesPerYear: 20 });
  const b = monteCarlo(trades, LEVELS.max, LADDER, { runs: 200, tradesPerYear: 20 });
  assert.deepEqual(a, b);
  assert.equal(a.probDrawdown25, 0);
  assert.ok(a.medianReturn > 0);
  assert.equal(monteCarlo([], LEVELS.max, LADDER), null);
});

test("monteCarlo shows ruin risk for a losing strategy at high risk", () => {
  const trades = [{ r: -1 }, { r: -1 }, { r: 1.5 }];
  const mc = monteCarlo(trades, { baseRisk: 0.2, step: 0.1, ceiling: 0.5 }, LADDER, { runs: 500, tradesPerYear: 100 });
  assert.ok(mc.probDrawdown90 > 0.5);
});

// --- BloFin data ------------------------------------------------------------

test("parseCandle reads BloFin's row format", () => {
  assert.deepEqual(parseCandle(["1700000000000", "1", "2", "0.5", "1.5", "10", "0", "0", "1"]),
    { time: 1700000000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, confirmed: true });
});

test("fetchCandles pages backwards and drops unconfirmed bars", async () => {
  const all = Array.from({ length: 10 }, (_, i) => [String(T0 + i * HOUR), "1", "2", "0", "1", "5", "0", "0", i === 9 ? "0" : "1"]);
  const calls = [];
  const get = async (path, params) => {
    calls.push(params.after);
    const older = all.filter((r) => params.after === undefined || Number(r[0]) < params.after).reverse();
    return older.slice(0, 4); // newest first, like BloFin
  };
  const out = await fetchCandles(get, "BTC-USDT", T0 + 2 * HOUR, { limit: 4 });
  assert.deepEqual(out.map((c) => (c.time - T0) / HOUR), [2, 3, 4, 5, 6, 7, 8]);
  assert.ok(calls.length >= 2);
});

test("fetchFunding pages backwards", async () => {
  const all = Array.from({ length: 5 }, (_, i) => ({ fundingTime: String(T0 + i * 8 * HOUR), fundingRate: "0.0001" }));
  const get = async (_, { after }) => all.filter((r) => after === undefined || Number(r.fundingTime) < after).reverse().slice(0, 2);
  const out = await fetchFunding(get, "BTC-USDT", T0);
  assert.equal(out.length, 5);
  assert.equal(out[0].time, T0);
});

test("fetchSpecs converts contracts to base units", async () => {
  const get = async () => [{ instId: "BTC-USDT", contractValue: "0.001", lotSize: "0.1", minSize: "0.1", maxLeverage: "150" }, { instId: "DOGE-USDT" }];
  const specs = await fetchSpecs(get, ["BTC-USDT"]);
  near(specs["BTC-USDT"].qtyStep, 0.0001);
  near(specs["BTC-USDT"].minQty, 0.0001);
  assert.equal(specs["DOGE-USDT"], undefined);
});

// --- limit entries, mixed histories, candle lengths --------------------------

test("a limit entry fills at the signal close when price comes back, with maker fee and no slippage", () => {
  const rows = [...flat(30), [100, 106, 100, 105], [105.5, 107, 104, 106], ...flat(3, 106)];
  const strategy = { ...TEST_STRATEGY, entry: { type: "limit", waitBars: 1 } };
  const costs = { ...NO_COSTS, makerFee: 0.001, takerFee: 0.01, slippage: 0.01 };
  const r = bt(rows, { strategy, costs });
  const t = r.trades[0];
  near(t.entryPrice, 105, 1e-9);
  assert.equal(r.missedLimits, 0);
});

test("a limit entry that price never comes back to is cancelled", () => {
  const rows = [...flat(30), [100, 106, 100, 105], [107, 110, 106, 109], [109, 112, 108, 111], ...flat(3, 111)];
  const strategy = { ...TEST_STRATEGY, entry: { type: "limit", waitBars: 1 } };
  const r = bt(rows, { strategy });
  assert.equal(r.missedLimits, 1);
  // The next candle is a new breakout, so a fresh order at its close (111) fills later.
  assert.ok(r.trades.every((t) => t.entryPrice > 105));
});

test("a coin whose history starts later joins the test when its data begins", () => {
  const strategy = { ...TEST_STRATEGY, symbols: ["X", "Y"] };
  const x = bars([...flat(60), [100, 106, 100, 105], [106, 107, 105, 106], ...flat(3, 106)]);
  const y = bars([...flat(30, 50), [50, 56, 50, 55], [56, 57, 55, 56], ...flat(3, 56)], T0 + 30 * HOUR);
  const r = runBacktest({
    strategy, level: LEVEL, ladder: LADDER, limits: LIM, costs: NO_COSTS,
    specs: { X: SPECS.X, Y: SPECS.X }, data: { X: x, Y: y }, startEquity: 1000,
  });
  assert.deepEqual(r.trades.map((t) => t.symbol).sort(), ["X", "Y"]);
  assert.equal(r.start, T0);
});

test("barLabel maps candle lengths to BloFin's names", () => {
  assert.equal(barLabel(HOUR), "1H");
  assert.equal(barLabel(4 * HOUR), "4H");
  assert.throws(() => barLabel(7));
});

test("funding is charged for every funding time inside a long bar", () => {
  const DAYMS = 24 * HOUR;
  const strategy = { ...TEST_STRATEGY, barMs: DAYMS };
  const rows = [...flat(30), [100, 106, 100, 105], [106, 107, 105, 106], [106, 107, 105, 106], ...flat(2, 106)];
  const costs = { ...NO_COSTS, defaultFundingRate: 0.001 };
  const r = runBacktest({
    strategy, level: LEVEL, ladder: LADDER, limits: LIM, costs, specs: SPECS,
    data: { X: rows.map(([open, high, low, close], i) => ({ time: T0 + i * DAYMS, open, high, low, close, volume: 1 })) },
    startEquity: 1000,
  });
  const t = r.trades[0];
  const days = (t.closeTime - t.openTime) / DAYMS;
  near(r.funding, t.qty * 106 * 0.001 * 3 * days, 1e-6);
});

test("long-only strategies never short, and the trend signal follows a rising EMA", () => {
  const down = Array.from({ length: 60 }, (_, i) => [200 - i, 201 - i, 199 - i, 200 - i]);
  const both = bt([...flat(30), [100, 100, 94, 95], [94, 95, 93, 94], ...flat(3, 94)]);
  assert.equal(both.trades[0].side, "short");
  const longOnly = bt([...flat(30), [100, 100, 94, 95], [94, 95, 93, 94], ...flat(3, 94)], { strategy: { ...TEST_STRATEGY, sides: "long" } });
  assert.equal(longOnly.trades.length, 0);
  const trend = { ...TEST_STRATEGY, signal: "trend", trendEma: 10, breakout: null, exitChannel: null, exitEma: true, sides: "long" };
  const up = Array.from({ length: 60 }, (_, i) => [100 + i, 101 + i, 99 + i, 100 + i]);
  const r = bt([...down, ...up, ...down.slice(0, 20).map(([o, h, l, c]) => [o - 41, h - 41, l - 41, c - 41])], { strategy: trend });
  assert.ok(r.trades.length >= 1);
  assert.ok(r.trades.every((x) => x.side === "long"));
  assert.ok(r.trades.some((x) => x.reason === "trend lost" || x.reason === "stop"));
});

// --- walk-forward -----------------------------------------------------------

import { combinations, scoreTrades, walkForward } from "../lib/backtest/walkforward.js";

test("combinations expands a parameter grid", () => {
  assert.deepEqual(combinations({ a: [1, 2], b: [3] }), [{ a: 1, b: 3 }, { a: 2, b: 3 }]);
  assert.deepEqual(combinations(undefined), [{}]);
});

test("scoreTrades is the profit factor in R, and needs enough trades", () => {
  assert.equal(scoreTrades([{ r: 2 }, { r: -1 }], 2), 2);
  assert.equal(scoreTrades([{ r: 2 }], 2), -Infinity);
});

test("walkForward only trades windows after the training period and carries equity", () => {
  const data = syntheticMarket({ hours: 300 * 24 });
  const s = { ...STRATEGIES.swing, symbols: ["BTC-USDT", "ETH-USDT"], barMs: HOUR };
  const base = { level: LEVELS.conservative, ladder: LADDER, limits: { ...LIMITS, killSwitch: null }, costs: COSTS, specs: DEFAULT_SPECS, data };
  const from = data["BTC-USDT"][0].time;
  const DAYMS = 24 * HOUR;
  const r = walkForward({ strategy: s, grid: { trailAtr: [3, 4] }, base, from, to: from + 300 * DAYMS, trainMs: 120 * DAYMS, testMs: 60 * DAYMS, startEquity: 100, minTrades: 1 });
  assert.equal(r.windows.length, 3);
  assert.ok(r.trades.every((t) => t.openTime >= from + 120 * DAYMS));
  for (let i = 1; i < r.windows.length; i++) assert.equal(r.windows[i].startEquity, r.windows[i - 1].endEquity);
  assert.equal(r.endEquity, r.windows.at(-1).endEquity);
});

// --- momentum signal and volatility sizing -----------------------------------

import { sizeQty } from "../lib/backtest/engine.js";
import { realizedVol } from "../lib/backtest/ta.js";

test("realizedVol annualizes the standard deviation of log returns", () => {
  const c = [100, 110, 100, 110, 100].map((close, i) => ({ time: i, open: close, high: close, low: close, close, volume: 1 }));
  const v = realizedVol(c, 2, 365);
  assert.equal(v[1], null);
  // two returns +ln(1.1), -ln(1.1): mean 0, std ln(1.1)
  near(v[2], Math.log(1.1) * Math.sqrt(365), 1e-9);
});

test("volatility sizing gives calmer coins bigger positions and follows the risk ladder", () => {
  const s = { symbols: ["A", "B"], sizing: { type: "volatility", targetVol: 0.6, maxWeight: 0.5 } };
  const calm = sizeQty(s, { equity: 1000, riskPct: 0.01, price: 10, vol: 0.3 });
  const wild = sizeQty(s, { equity: 1000, riskPct: 0.01, price: 10, vol: 1.2 });
  near(calm, (1000 * 0.5) / 10, 1e-9, "capped at maxWeight");
  near(wild, (1000 * (0.6 / 1.2) / 2) / 10, 1e-9);
  near(sizeQty(s, { equity: 1000, riskPct: 0.02, price: 10, vol: 1.2 }), wild * 2, 1e-9);
  assert.equal(sizeQty(s, { equity: 1000, riskPct: 0.01, price: 10, vol: null }), 0);
  near(sizeQty({}, { equity: 1000, riskPct: 0.01, price: 10, stopDist: 2 }), 5, 1e-9, "risk sizing unchanged");
});

test("momentum holds while price is above its level `lookback` candles ago", () => {
  const strategy = { ...TEST_STRATEGY, signal: "momentum", lookback: 10, breakout: null, exitChannel: null, sides: "long", trailAtr: 100, stopAtr: 50 };
  const up = Array.from({ length: 40 }, (_, i) => [100 + i, 101 + i, 99 + i, 100 + i]);
  const down = Array.from({ length: 30 }, (_, i) => [139 - i * 2, 140 - i * 2, 137 - i * 2, 138 - i * 2]);
  const r = bt([...up, ...down], { strategy });
  assert.ok(r.trades.length >= 1);
  assert.equal(r.trades[0].reason, "trend lost");
  assert.ok(r.trades.every((t) => t.side === "long"));
});

test("a strategy can turn off the daily loss cap", () => {
  const rows = [...flat(30), [100, 106, 100, 105], [106, 107, 105, 106], [100, 101, 99, 100], ...flat(3, 100)];
  const capped = bt(rows, { level: { ...LEVEL, baseRisk: 0.2 }, limits: { ...LIM, dailyLossCap: 0.05 } });
  const uncapped = bt(rows, { level: { ...LEVEL, baseRisk: 0.2 }, limits: { ...LIM, dailyLossCap: 0.05 }, strategy: { ...TEST_STRATEGY, dailyLossCap: null } });
  assert.ok(capped.events.some((e) => e.type === "daily loss cap"));
  assert.ok(!uncapped.events.some((e) => e.type === "daily loss cap"));
});

test("funding uses the coin's real payment times, including 4-hourly ones", () => {
  const rows = [...flat(30), [100, 106, 100, 105], [106, 107, 105, 106], [106, 107, 105, 106], [106, 107, 105, 106], ...flat(2, 106)];
  // Payments every 2 hours at 0.1% over the whole test.
  const funding = { X: new Map(Array.from({ length: 40 }, (_, k) => [T0 + k * 2 * HOUR, 0.001])) };
  const r = bt(rows, { funding, costs: { ...NO_COSTS, defaultFundingRate: 0 } });
  const t = r.trades[0];
  let payments = 0;
  for (let f = t.openTime; f < t.closeTime; f += HOUR) if ((f - T0) % (2 * HOUR) === 0) payments++;
  assert.ok(payments >= 2);
  near(r.funding, t.qty * 106 * 0.001 * payments, 1e-6);
});

// --- mean reversion, take-profit, time stop ----------------------------------

import { bollinger } from "../lib/backtest/ta.js";

test("bollinger bands are the moving average ± width standard deviations", () => {
  const b = bollinger([1, 3, 1, 3], 2, 2);
  assert.equal(b.mid[0], null);
  near(b.mid[1], 2);
  near(b.upper[1], 4);
  near(b.lower[1], 0);
});

const MR = {
  ...TEST_STRATEGY, signal: "meanReversion", breakout: null, exitChannel: null, rsiPeriod: 2, rsiLow: 10,
  bandBars: 20, bandWidth: 2, takeProfit: "mid", stopAtr: 10, trailAtr: 100, entry: { type: "limit", waitBars: 1 },
};
// Gentle zig-zag around 100, then a sharp two-candle drop, then a bounce.
const zig = Array.from({ length: 40 }, (_, i) => { const c = 100 + (i % 2 ? 0.5 : -0.5); return [c, c + 0.6, c - 0.6, c]; });

test("mean reversion buys a sharp dip and takes profit at the middle band with a maker fill", () => {
  const rows = [...zig, [100, 100.2, 96, 96.5], [96.5, 96.6, 93, 93.2], [93.2, 96, 93.1, 95.8], [95.8, 101, 95.5, 100.5], ...zig.slice(0, 5)];
  const costs = { ...NO_COSTS, makerFee: 0.0002, takerFee: 0.01, slippage: 0.01 };
  const r = bt(rows, { strategy: MR, costs });
  const t = r.trades[0];
  assert.ok(t, "a trade was made");
  assert.equal(t.side, "long");
  assert.equal(t.reason, "target");
  assert.ok(t.pnl > 0);
  // Both fills were maker: fees are 0.02% of each side, far below the 1% taker rate.
  assert.ok(r.fees < t.qty * (t.entryPrice + t.exitPrice) * 0.001);
});

test("a time stop closes a trade that hasn't bounced", () => {
  const rows = [...zig, [100, 100.2, 96, 96.5], [96.5, 96.6, 93, 93.2], ...Array.from({ length: 10 }, () => [93, 93.4, 92.6, 93])];
  const r = bt(rows, { strategy: { ...MR, maxBars: 3 } });
  assert.equal(r.trades[0].reason, "time stop");
});

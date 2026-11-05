import test from "node:test";
import assert from "node:assert/strict";
import { assessCoin, scanSetups, setupScannerSettings } from "../server/setup-scanner.js";
import { PAPER, STRATEGIES, WATCHLIST } from "../lib/backtest/settings.js";

const H = 3_600_000;
const BAR = 4 * H;
const NOW = Date.UTC(2026, 10, 5, 12);
const strategy = { ...STRATEGIES.swing, ...PAPER.overrides };

// 4h candles ending at NOW, built from a close-price function of the candle index.
function candles(n, close, { volume = () => 10 } = {}) {
  const start = NOW - n * BAR;
  return Array.from({ length: n }, (_, i) => {
    const c = close(i);
    const prev = i ? close(i - 1) : c;
    return { time: start + i * BAR, open: prev, high: Math.max(prev, c) * 1.002, low: Math.min(prev, c) * 0.998, close: c, volume: volume(i) };
  });
}

test("assessCoin flags a breakout in a strong uptrend as a BUY signal", () => {
  const n = 450;
  const series = candles(n, (i) => (i < n - 1 ? 100 + i * 0.5 + Math.sin(i / 3) * 2 : 100 + i * 0.5 + 8), { volume: (i) => (i === n - 1 ? 40 : 10) });
  const a = assessCoin(series, strategy);
  assert.equal(a.rank, 0, a.text);
  assert.match(a.text, /BUY signal/);
  assert.match(a.text, /30d momentum \+\d+%/);
});

test("assessCoin marks downtrends and computes 30-day momentum", () => {
  const a = assessCoin(candles(450, (i) => 500 - i * 0.5), strategy);
  assert.equal(a.rank, 3);
  const expected = (500 - 449 * 0.5) / (500 - (449 - 180) * 0.5) - 1;
  assert.ok(Math.abs(a.momentum - expected) < 1e-9);
});

test("scanSetups lists signals and setups first, hides downtrends, notes skipped coins", async () => {
  const series = {
    "UP-USDT": candles(450, (i) => 100 + i * 0.5 + Math.sin(i / 3) * 2),
    "DOWN-USDT": candles(450, (i) => 500 - i * 0.5),
  };
  const get = async (_path, { instId, after }) => {
    if (!series[instId]) throw new Error("unknown");
    const rows = series[instId].filter((c) => after === undefined || c.time < after).reverse();
    return rows.slice(0, 1440).map((c) => [String(c.time), c.open, c.high, c.low, c.close, c.volume, 0, 0, "1"]);
  };
  const d = await scanSetups({ symbols: ["UP-USDT", "DOWN-USDT", "GONE-USDT"] }, { get, nowMs: NOW });
  assert.deepEqual(d.candidates.map((c) => c.symbol), ["UP-USDT"]);
  assert.match(d.criteria, /1 of 2 coins are in a downtrend/);
  assert.match(d.criteria, /Not scanned this time: GONE-USDT/);
  assert.equal(d.candidates[0].updatedAt, new Date(NOW).toISOString());
});

test("setupScannerSettings defaults to the watchlist and reads SCANNER_SYMBOLS safely", () => {
  assert.deepEqual(setupScannerSettings({}).symbols, WATCHLIST);
  assert.deepEqual(setupScannerSettings({ SCANNER_SYMBOLS: "btc, pepe,../x" }).symbols, ["BTC-USDT", "PEPE-USDT"]);
});

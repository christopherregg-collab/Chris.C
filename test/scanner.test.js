import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SYMBOLS, scan, scannerSettings } from "../server/scanner.js";

const HOUR = 3600;
const NOW_SEC = 1_800_000_000; // an exact hour boundary

// Coinbase-style rows [time, low, high, open, close, volume], newest first,
// for 120 hourly candles following `closes(i)`, plus one in-progress candle.
function rows(closes) {
  const out = [];
  for (let i = 0; i <= 120; i++) {
    const t = NOW_SEC - (120 - i) * HOUR; // i = 120 is the current, unfinished hour
    const c = closes(i);
    out.push([t, c * 0.99, c * 1.01, c, c, 10]);
  }
  return out.reverse();
}

function fakeFetch(series) {
  return async (url) => {
    const base = /products\/(\w+)-USD/.exec(url)[1];
    if (!series[base]) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => rows(series[base]) };
  };
}

// Checked against lib/indicators.js: accelerating rise scores Buy (+1),
// accelerating fall scores Sell (−1), and a rise with a pullback scores Neutral (0).
const up = (i) => 100 + (i * i) / 50;
const down = (i) => 400 - (i * i) / 50;
const flat = (i) => 100 + i - (i > 110 ? (i - 110) * 3 : 0);

test("scan lists non-neutral coins, strongest first, from finished candles", async () => {
  const d = await scan(
    { symbols: ["AAA", "BBB", "CCC", "ZZZ"], interval: "1h" },
    { fetchImpl: fakeFetch({ AAA: up, BBB: down, CCC: flat }), nowMs: (NOW_SEC + 60) * 1000 },
  );
  const symbols = d.candidates.map((c) => c.symbol);
  assert.ok(symbols.includes("AAA-USD") && symbols.includes("BBB-USD"));
  assert.ok(!symbols.includes("CCC-USD"), "neutral coins are left out");
  for (const c of d.candidates) {
    assert.match(c.signal, /^(Strong buy|Buy|Sell|Strong sell) · /);
    // The newest finished candle opened one hour before NOW_SEC and closed at NOW_SEC.
    assert.equal(c.updatedAt, new Date(NOW_SEC * 1000).toISOString());
  }
  const scores = d.candidates.map((c) => Math.abs(c.score));
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.match(d.criteria, /finished 1h/);
  assert.match(d.criteria, /Not scanned this time: ZZZ/);
});

test("scan throws when no coin loads", async () => {
  await assert.rejects(scan({ symbols: ["ZZZ"], interval: "1h" }, { fetchImpl: fakeFetch({}) }), /no coin could be scanned/);
});

test("scannerSettings reads env with safe fallbacks", () => {
  assert.deepEqual(scannerSettings({}), { symbols: DEFAULT_SYMBOLS, interval: "1h" });
  assert.deepEqual(scannerSettings({ SCANNER_SYMBOLS: " btc, eth ,../x", SCANNER_INTERVAL: "6h" }), { symbols: ["BTC", "ETH"], interval: "6h" });
  assert.equal(scannerSettings({ SCANNER_INTERVAL: "4h" }).interval, "1h");
});

// Simulated hourly candles for testing the engine when no real data is available.
// Regime-switching random walk: trending-up, trending-down and choppy periods, with
// a second symbol correlated to the first. NOT real market data: results on it say
// nothing about real-world profit.

import { mulberry32 } from "./stats.js";

const HOUR = 3_600_000;

function gauss(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function syntheticMarket({ symbols = ["BTC-USDT", "ETH-USDT"], hours = 2 * 365 * 24, start = Date.UTC(2024, 0, 1), seed = 42, startPrices = [60000, 3000] } = {}) {
  const rand = mulberry32(seed);
  const regimes = [
    { drift: 0.0004, vol: 0.006 },   // up-trend
    { drift: -0.0004, vol: 0.007 },  // down-trend
    { drift: 0, vol: 0.005 },        // chop
  ];
  let regime = 2;
  const out = Object.fromEntries(symbols.map((s) => [s, []]));
  const price = symbols.map((_, k) => startPrices[k] ?? 100);
  for (let h = 0; h < hours; h++) {
    if (rand() < 1 / 300) regime = Math.floor(rand() * 3); // regimes last ~12 days on average
    const { drift, vol } = regimes[regime];
    const common = gauss(rand);
    symbols.forEach((sym, k) => {
      const beta = k === 0 ? 1 : 1.2;
      const ret = drift * beta + vol * beta * (0.8 * common + 0.6 * gauss(rand));
      const open = price[k];
      const close = open * Math.exp(ret);
      const wick = Math.abs(gauss(rand)) * vol * 0.6;
      const high = Math.max(open, close) * (1 + wick);
      const low = Math.min(open, close) * (1 - Math.abs(gauss(rand)) * vol * 0.6);
      const volume = (1 + Math.abs(ret) / vol) * (0.5 + rand());
      out[sym].push({ time: start + h * HOUR, open, high, low, close, volume });
      price[k] = close;
    });
  }
  return out;
}

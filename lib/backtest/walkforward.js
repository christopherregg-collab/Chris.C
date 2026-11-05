// Rolling walk-forward test.
//
// For each window: try every combination of the strategy's parameter grid on the previous
// `trainMs` of data, keep the best, then trade it on the next `testMs`, data it has never
// seen. The test windows are stitched together, carrying equity forward. The result is how
// the whole "pick settings from recent history, then trade them" process would have done.

import { runBacktest } from "./engine.js";

/** Every combination of a grid like { breakout: [20, 40], trailAtr: [3, 4] }. */
export function combinations(grid) {
  let out = [{}];
  for (const [key, values] of Object.entries(grid ?? {})) {
    out = out.flatMap((base) => values.map((v) => ({ ...base, [key]: v })));
  }
  return out;
}

/**
 * How good a training run was: profit factor in R (result per unit of risk), so position
 * sizing doesn't sway the choice. Runs with fewer than `minTrades` trades score -Infinity.
 */
export function scoreTrades(trades, minTrades) {
  if (trades.length < minTrades) return -Infinity;
  const win = trades.filter((t) => t.r > 0).reduce((a, t) => a + t.r, 0);
  const loss = -trades.filter((t) => t.r <= 0).reduce((a, t) => a + t.r, 0);
  return loss > 0 ? win / loss : win > 0 ? 100 : 0;
}

/**
 * @param {object} o
 * @param {object} o.strategy    base strategy settings
 * @param {object} o.grid        parameter grid to choose from in each training window
 * @param {object} o.base        everything else runBacktest needs (level, ladder, limits, costs, specs, data, funding)
 * @param {number} o.from        first test window starts at from + trainMs
 * @param {number} o.to
 * @param {number} o.trainMs
 * @param {number} o.testMs
 * @param {number} o.startEquity
 * @param {number} [o.minTrades] minimum training trades for a combination to be eligible (default 10)
 */
export function walkForward(o) {
  const combos = combinations(o.grid);
  const minTrades = o.minTrades ?? 10;
  const windows = [];
  const trades = [];
  const equityCurve = [];
  let equity = o.startEquity;
  let fees = 0;
  for (let start = o.from + o.trainMs; start < o.to; start += o.testMs) {
    const end = Math.min(start + o.testMs, o.to);
    let best = null;
    for (const params of combos) {
      const strategy = { ...o.strategy, ...params };
      const train = runBacktest({ ...o.base, strategy, startEquity: 1000, from: start - o.trainMs, to: start });
      const score = scoreTrades(train.trades, minTrades);
      if (!best || score > best.score) best = { params, score, trainTrades: train.trades.length };
    }
    // No combination had enough training trades to judge: fall back to the defaults.
    if (best.score === -Infinity) best = { params: {}, score: null, trainTrades: 0 };
    const test = equity > 0
      ? runBacktest({ ...o.base, strategy: { ...o.strategy, ...best.params }, startEquity: equity, from: start, to: end })
      : null;
    const endEquity = test ? test.endEquity : 0;
    windows.push({ start, end, params: best.params, trainScore: best.score, trainTrades: best.trainTrades, startEquity: equity, endEquity, trades: test ? test.trades.length : 0 });
    if (test) {
      trades.push(...test.trades);
      equityCurve.push(...test.equityCurve);
      fees += test.fees;
    }
    equity = endEquity;
  }
  return { windows, trades, equityCurve, startEquity: o.startEquity, endEquity: equity, fees, start: o.from + o.trainMs, end: o.to };
}

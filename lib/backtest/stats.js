// Performance metrics and Monte Carlo risk of ruin.

import { createLadder } from "./ladder.js";

const DAY = 86_400_000;

/** Last equity of each UTC day. */
export function dailyEquity(curve) {
  const out = [];
  for (const p of curve) {
    const d = Math.floor((p.time - 1) / DAY);
    if (out.length && out[out.length - 1].day === d) out[out.length - 1].equity = p.equity;
    else out.push({ day: d, equity: p.equity });
  }
  return out;
}

export function maxDrawdown(values) {
  let peak = -Infinity, dd = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) dd = Math.max(dd, (peak - v) / peak);
  }
  return dd;
}

export function summarize(result) {
  const { trades, equityCurve, startEquity, endEquity } = result;
  const days = Math.max(1, (result.end - result.start) / DAY);
  const daily = dailyEquity(equityCurve);
  const rets = [];
  let prev = startEquity;
  for (const d of daily) { rets.push(prev > 0 ? d.equity / prev - 1 : 0); prev = d.equity; }
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1));
  const downside = Math.sqrt(rets.reduce((a, b) => a + Math.min(b, 0) ** 2, 0) / (rets.length || 1));
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  let streak = 0, worstStreak = 0;
  for (const t of trades) { streak = t.pnl > 0 ? 0 : streak + 1; worstStreak = Math.max(worstStreak, streak); }
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const totalReturn = endEquity / startEquity - 1;
  return {
    days: Math.round(days),
    startEquity, endEquity, totalReturn,
    cagr: endEquity > 0 ? (endEquity / startEquity) ** (365 / days) - 1 : -1,
    maxDrawdown: maxDrawdown([startEquity, ...equityCurve.map((p) => p.equity)]),
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : 0,
    sortino: downside > 0 ? (mean / downside) * Math.sqrt(365) : 0,
    bestDay: rets.length ? Math.max(...rets) : 0,
    worstDay: rets.length ? Math.min(...rets) : 0,
    trades: trades.length,
    tradesPerYear: (trades.length / days) * 365,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgWinR: avg(wins.map((t) => t.r)),
    avgLossR: avg(losses.map((t) => t.r)),
    bestTradeR: trades.length ? Math.max(...trades.map((t) => t.r)) : 0,
    worstLosingStreak: worstStreak,
    fees: result.fees,
    funding: result.funding,
    skippedMinSize: result.skippedMinSize,
    liquidations: result.liquidations,
    killSwitchHit: result.killed,
  };
}

/** Small seeded PRNG so reports are reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Re-orders the backtest's trade results at random (with replacement) to see how
 * bad one year could get. Each simulated year replays the risk ladder: a trade of
 * R multiples changes equity by R * (risk fraction the ladder gives at that point).
 * The kill switch is ignored here on purpose, to show the raw risk of the settings.
 */
export function monteCarlo(trades, level, ladderRules, { runs = 5000, tradesPerYear, seed = 7 } = {}) {
  const rs = trades.map((t) => t.r).filter(Number.isFinite);
  const n = Math.max(1, Math.round(tradesPerYear ?? rs.length));
  if (!rs.length) return null;
  const rand = mulberry32(seed);
  const ends = [];
  const dds = [];
  for (let k = 0; k < runs; k++) {
    const ladder = createLadder(level, ladderRules);
    let eq = 1, peak = 1, dd = 0;
    for (let j = 0; j < n && eq > 0; j++) {
      const r = rs[Math.floor(rand() * rs.length)];
      const risk = ladder.current(eq, peak);
      const pnl = eq * risk * r;
      eq = Math.max(0, eq + pnl);
      ladder.record(pnl);
      peak = Math.max(peak, eq);
      dd = Math.max(dd, (peak - eq) / peak);
    }
    ends.push(eq);
    dds.push(dd);
  }
  ends.sort((a, b) => a - b);
  dds.sort((a, b) => a - b);
  const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
  const share = (pred) => dds.filter(pred).length / runs;
  return {
    runs, tradesPerYear: n,
    medianReturn: pct(ends, 0.5) - 1,
    p5Return: pct(ends, 0.05) - 1,
    p95Return: pct(ends, 0.95) - 1,
    drawdown95: pct(dds, 0.95),
    probDrawdown25: share((d) => d >= 0.25),
    probDrawdown50: share((d) => d >= 0.5),
    probDrawdown90: share((d) => d >= 0.9),
    probLoss: ends.filter((e) => e < 1).length / runs,
  };
}

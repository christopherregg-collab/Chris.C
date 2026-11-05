// Strategy, risk-level and exchange settings for the backtester.
// Everything here is a setting: change it and re-run. Nothing is tuned.

const HOUR = 3_600_000;

/** Exchange costs. Check BloFin's current fee page and set these to your tier. */
export const COSTS = {
  takerFee: 0.0006,     // 0.06% per market fill: stops, exits, adds, and entries when entry.type is "market".
  makerFee: 0.0002,     // 0.02% per limit fill: entries when entry.type is "limit". No slippage on those.
  slippage: 0.0005,     // 0.05% per market fill, against you.
  maintenanceMargin: 0.005, // 0.5% of notional; equity below this at the worst intrabar price = liquidated.
  // Used only when no funding history file is present: +0.01% per 8h, longs pay, shorts receive.
  defaultFundingRate: 0.0001,
  fundingEveryMs: 8 * HOUR,
};

/**
 * Order size limits per symbol, in base units (BTC, ETH). Replaced by real values
 * from BloFin's instruments endpoint when `npm run backtest:fetch` has been run.
 * qtyStep = contractValue * lotSize, minQty = contractValue * minSize.
 */
export const DEFAULT_SPECS = {
  "BTC-USDT": { qtyStep: 0.0001, minQty: 0.0001, maxLeverage: 150 },
  "ETH-USDT": { qtyStep: 0.001, minQty: 0.001, maxLeverage: 150 },
};

/** Coins both strategies trade. Liquid BloFin USDT perpetuals. */
export const SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "BNB-USDT", "DOGE-USDT"];

/**
 * Win-streak risk ladder ("learning" position sizing, anti-martingale):
 * - start at baseRisk
 * - from the `winsToStep`-th win in a row onward, each win raises risk by `step` (up to `ceiling`)
 * - any loss: back to baseRisk; `lossesToHalve` losses in a row: half of baseRisk until a win
 * - equity more than `drawdownCapAt` below its peak: risk capped at baseRisk until a new high
 */
export const LEVELS = {
  conservative: { label: "Conservative", baseRisk: 0.01, step: 0.0025, ceiling: 0.02, leverageCap: 3 },
  aggressive:   { label: "Aggressive",   baseRisk: 0.02, step: 0.005, ceiling: 0.04, leverageCap: 5 },
  max:          { label: "Max",          baseRisk: 0.03, step: 0.01, ceiling: 0.06, leverageCap: 10 },
};

export const LADDER = { winsToStep: 2, lossesToHalve: 2, drawdownCapAt: 0.10 };

/** Hard limits that apply at every level. Set killSwitch to null to disable it. */
export const LIMITS = { dailyLossCap: 0.05, killSwitch: 0.25, maxOpenPositions: 3 };

// Entries are limit orders at the signal candle's close (maker fee, no slippage), valid for
// `waitBars` candles. A signal that runs away without coming back is a missed trade.
const LIMIT_ENTRY = { type: "limit", offsetAtr: 0, waitBars: 1 };

// History of decisions (Nov 2026 backtests, see ROADMAP.md):
// - 1h breakouts: an edge before costs, but ~300 trades a year paid more in costs than it made.
// - 4h breakouts, both directions: Core had no edge; Big Swing's longs did, its shorts lost.
// So Core became a long-only daily trend-holder and Big Swing long-only.
// - Daily EMA trend-holder: whipsawed in 2024-2026 (walk-forward -9% to -12%), so Core is now
//   time-series momentum with volatility-based sizing (walk-forward +5%, fixed 20-30d better).
//
// `walkForward.grid` lists the settings the walk-forward test may choose between in each
// training window. The values above it are the defaults used everywhere else.

export const STRATEGIES = {
  core: {
    label: "Core Momentum",
    symbols: SYMBOLS,
    barMs: 24 * HOUR,
    // Time-series momentum: hold a coin while its close is above its close `lookback` days
    // ago; exit when it isn't. Crypto research finds momentum over 1-4 week horizons.
    signal: "momentum",
    lookback: 30,
    sides: "long",
    trendFilters: [],
    breakout: null,
    exitChannel: null,
    stopAtr: 3,            // protective stop only; the momentum exit does the work
    trailAtr: 100,         // effectively no trailing stop
    // Each coin gets equity / 6, scaled by 60% / its 30-day annualized volatility (max half
    // the account per coin); the risk ladder scales that up or down (1% risk = 1x).
    sizing: { type: "volatility", targetVol: 0.6, volBars: 30, maxWeight: 0.5 },
    dailyLossCap: null,    // a trend-holder rides through -5% days; the kill switch still applies
    maxOpenPositions: 6,
    entry: LIMIT_ENTRY,
    pyramid: null,
    walkForward: { grid: { lookback: [20, 30, 60, 90, 120], trailAtr: [8, 100] } },
  },
  swing: {
    label: "Big Swing",
    symbols: SYMBOLS,
    barMs: 4 * HOUR,
    breakout: 20,          // enter on a close above the 20-candle high
    exitChannel: 10,       // exit on a close below the 10-candle low
    sides: "long",
    trendFilters: [{ ms: 24 * HOUR, ema: 50 }],   // daily close above its EMA(50)
    adxMin: 30,            // only strong trends
    volumeMult: 1.5,       // volume spike: 1.5x its 20-candle average
    stopAtr: 2,
    trailAtr: 3,
    entry: LIMIT_ENTRY,
    // Add the same size again each time price moves `everyAtr` ATR past the last add,
    // up to `maxAdds` times; the stop moves to `stopAtr` ATR behind the latest add.
    pyramid: { maxAdds: 3, everyAtr: 1 },
    walkForward: { grid: { breakout: [20, 40], adxMin: [25, 30], trailAtr: [3, 4] } },
  },
};

/** Walk-forward windows: choose settings on 12 months, trade them for the next 3. */
export const WALK_FORWARD = { trainDays: 365, testDays: 91 };

/** Default money split: 80% Core Momentum, 20% Big Swing. */
export const DEFAULT_ALLOCATION = { core: 240, swing: 60 };

/**
 * Paper trading on BloFin's demo account (scripts/paper-trader.js).
 * `overrides` are the settings the latest walk-forward window chose for this strategy
 * (Sep 2026). Re-check them each quarter in the backtest report's walk-forward table.
 */
export const PAPER = {
  strategy: "swing",
  level: "conservative",
  pot: 60,
  overrides: { breakout: 40, adxMin: 30, trailAtr: 3 },
};

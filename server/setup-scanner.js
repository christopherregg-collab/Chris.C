// Scanner for the dashboard's Scanner card: where each watchlist coin stands against the
// Big Swing rules, plus its 30-day momentum, from BloFin's own 4h candles. It uses the same
// signal code as the backtester and the paper trader (lib/backtest/engine.js), with the
// paper trader's settings, so "BUY signal" here means the paper trader acts on that coin
// (if it trades it) at the next run.
//
// Settings (optional, in .env):
//   SCANNER_SYMBOLS=BTC,ETH,...      coins to scan (default: WATCHLIST in lib/backtest/settings.js)
//   SCANNER_MODE=indicators          use the older EMA/MACD/RSI scanner on Coinbase candles instead

import { prepare, signalAt } from "../lib/backtest/engine.js";
import { createPublicClient, fetchCandles } from "../lib/backtest/blofin-data.js";
import { PAPER, STRATEGIES, WATCHLIST } from "../lib/backtest/settings.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BAR = 4 * HOUR;
const CACHE_MS = 10 * 60_000;
const MOMENTUM_DAYS = 30;

export function setupScannerSettings(env = process.env) {
  const symbols = (env.SCANNER_SYMBOLS || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z0-9]{2,12}$/.test(s))
    .map((s) => `${s}-USDT`);
  return { symbols: symbols.length ? symbols : WATCHLIST };
}

const pctText = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`;

/** Where one coin stands. rank: 0 signal, 1 setup, 2 weak uptrend, 3 downtrend. */
export function assessCoin(candles, strategy) {
  const i = candles.length - 1;
  const p = prepare(candles, strategy);
  const c = candles[i];
  const back = Math.round((MOMENTUM_DAYS * DAY) / BAR);
  const momentum = i >= back ? c.close / candles[i - back].close - 1 : null;
  const adx = p.adx14[i];
  const high = p.entry.upper[i];
  const trendUp = p.trends.length > 0 && p.trends.every((t) => t[i] === 1);
  const volRatio = p.volMean[i] ? c.volume / p.volMean[i] : null;
  const side = signalAt(p, strategy, i);
  let rank;
  let text;
  if (side === 1) {
    rank = 0;
    text = `Big Swing BUY signal: closed above the ${strategy.breakout}-candle high (ADX ${adx.toFixed(0)}, volume ${volRatio.toFixed(1)}× average)`;
  } else if (trendUp && adx !== null && adx >= strategy.adxMin && high !== null) {
    rank = 1;
    const dist = high / c.close - 1;
    text = dist > 0
      ? `Setup: ${(dist * 100).toFixed(1)}% below the ${strategy.breakout}-candle high, strong uptrend (ADX ${adx.toFixed(0)})`
      : `Setup: at the ${strategy.breakout}-candle high, waiting for volume ${strategy.volumeMult}× average (now ${volRatio?.toFixed(1) ?? "?"}×)`;
  } else if (trendUp) {
    rank = 2;
    text = `Uptrend, not strong enough yet (ADX ${adx?.toFixed(0) ?? "?"}, needs ${strategy.adxMin})`;
  } else {
    rank = 3;
    text = "Downtrend: Big Swing doesn't buy";
  }
  if (momentum !== null) text += ` · ${MOMENTUM_DAYS}d momentum ${pctText(momentum)}`;
  return { rank, text, momentum, dist: high !== null ? high / c.close - 1 : null, closedAt: c.time + BAR };
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const k = next++;
      try { out[k] = { ok: true, value: await fn(items[k]) }; } catch (err) { out[k] = { ok: false, err }; }
    }
  }));
  return out;
}

/** One scan. Coins that fail to load are skipped; throws only if every coin fails. */
export async function scanSetups({ symbols }, { get = createPublicClient({ pauseMs: 0 }), nowMs = Date.now() } = {}) {
  const strategy = { ...STRATEGIES.swing, ...PAPER.overrides };
  const traded = new Set(STRATEGIES[PAPER.strategy]?.symbols ?? []);
  const since = nowMs - 75 * DAY; // enough for the daily EMA 50 trend filter and 30-day momentum
  const results = await pool(symbols, 5, async (sym) => {
    const candles = await fetchCandles(get, sym, since, { bar: "4H" });
    if (candles.length < 60) throw new Error(`${sym}: only ${candles.length} candles`);
    return { sym, ...assessCoin(candles, strategy) };
  });
  const ok = results.filter((r) => r.ok).map((r) => r.value);
  if (!ok.length) throw new Error(`no coin could be scanned (${results.find((r) => !r.ok)?.err?.message ?? "unknown error"})`);
  const skipped = symbols.filter((s) => !ok.some((o) => o.sym === s));

  const downtrend = ok.filter((o) => o.rank === 3).length;
  const candidates = ok
    .filter((o) => o.rank < 3)
    .sort((a, b) => a.rank - b.rank || (a.rank === 1 ? a.dist - b.dist : (b.momentum ?? -1) - (a.momentum ?? -1)))
    .map((o) => ({
      symbol: o.sym,
      signal: `${o.text}${traded.has(o.sym) ? " · paper-traded" : ""}`,
      updatedAt: new Date(o.closedAt).toISOString(),
    }));

  return {
    asOf: new Date(nowMs).toISOString(),
    criteria:
      `Big Swing rules on finished BloFin 4h candles (breakout above the ${strategy.breakout}-candle high, daily close above its EMA 50, ` +
      `ADX at least ${strategy.adxMin}, volume ${strategy.volumeMult}× average), with ${MOMENTUM_DAYS}-day momentum. ` +
      `Signals first, then setups closest to a breakout, then weaker uptrends by momentum. ` +
      `${downtrend} of ${ok.length} coins are in a downtrend and not listed. ` +
      `The paper trader trades ${[...traded].map((s) => s.replace("-USDT", "")).join(", ")}; the rest are watch-only.` +
      (skipped.length ? ` Not scanned this time: ${skipped.join(", ")}.` : ""),
    candidates,
  };
}

let cache = { at: 0, data: null };

/** Cached scan for the dashboard. On failure it returns the last good result, marked with an error. */
export async function getSetupScanner(nowMs = Date.now()) {
  if (cache.data && nowMs - cache.at < CACHE_MS) return cache.data;
  try {
    const data = await scanSetups(setupScannerSettings(), { nowMs });
    cache = { at: nowMs, data };
    return data;
  } catch (err) {
    console.error(`setup scanner: ${err.message}`);
    const last = cache.data;
    return last
      ? { ...last, error: `Scanner update failed: ${err.message}` }
      : { asOf: new Date(nowMs).toISOString(), candidates: [], error: `Scanner unavailable: ${err.message}` };
  }
}

export function resetSetupScannerCache() {
  cache = { at: 0, data: null };
}

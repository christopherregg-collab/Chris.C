// Server-side scanner for the dashboard's Scanner card. Runs the same EMA/MACD/RSI
// scoring as the markets page (lib/indicators.js) on finished Coinbase candles and
// reports every watchlist coin whose signal isn't Neutral, strongest first.
//
// Settings (optional, in .env):
//   SCANNER_SYMBOLS=BTC,ETH,SOL,...   (default: the markets page's coin list)
//   SCANNER_INTERVAL=1h               (15m, 1h, 6h or 1d)

import { evaluate } from "../lib/indicators.js";
import { INTERVALS, fetchCandles, splitClosed } from "../api/candles.js";

export const DEFAULT_SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "LINK", "DOT"];
const CACHE_MS = 5 * 60_000;

export function scannerSettings(env = process.env) {
  const symbols = (env.SCANNER_SYMBOLS || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z0-9]{2,10}$/.test(s));
  const interval = INTERVALS[env.SCANNER_INTERVAL] ? env.SCANNER_INTERVAL : "1h";
  return { symbols: symbols.length ? symbols : DEFAULT_SYMBOLS, interval };
}

/** One scan. Coins that fail to load are skipped; throws only if every coin fails. */
export async function scan({ symbols, interval }, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const gran = INTERVALS[interval];
  const results = await Promise.allSettled(
    symbols.map(async (base) => {
      const { closed } = splitClosed(await fetchCandles(base, interval, fetchImpl), gran, nowMs / 1000);
      return { base, closedAt: (closed[closed.length - 1].time + gran) * 1000, s: evaluate(closed) };
    }),
  );
  const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (ok.length === 0) {
    const first = results.find((r) => r.status === "rejected");
    throw new Error(`no coin could be scanned (${first?.reason?.message ?? "unknown error"})`);
  }
  const skipped = symbols.filter((b) => !ok.some((o) => o.base === b));

  const candidates = ok
    .filter((o) => o.s.label !== "Neutral")
    .sort((a, b) => Math.abs(b.s.score) - Math.abs(a.s.score) || b.s.score - a.s.score)
    .map(({ base, closedAt, s }) => {
      const note = (id) => s.checks.find((c) => c.id === id).note;
      return {
        symbol: `${base}-USD`,
        signal: `${s.label} · ${note("trend")}, MACD ${note("macd").toLowerCase()}, RSI ${s.rsi.toFixed(0)}`,
        score: s.score,
        updatedAt: new Date(closedAt).toISOString(),
      };
    });

  return {
    asOf: new Date(nowMs).toISOString(),
    criteria:
      `EMA 20/50 trend, MACD and RSI 14 on finished ${interval} Coinbase USD candles, scored −3 to +3. ` +
      `Lists coins rated Buy or Sell or stronger, strongest first. Watchlist: ${symbols.join(", ")}.` +
      (skipped.length ? ` Not scanned this time: ${skipped.join(", ")}.` : ""),
    candidates,
  };
}

let cache = { at: 0, data: null };

/**
 * Cached scan for the dashboard. On failure it returns the last good result,
 * whose old `asOf` makes the card show as stale, plus an error message.
 */
export async function getScanner(nowMs = Date.now()) {
  if (cache.data && nowMs - cache.at < CACHE_MS) return cache.data;
  try {
    const data = await scan(scannerSettings(), { nowMs });
    cache = { at: nowMs, data };
    return data;
  } catch (err) {
    console.error(`scanner: ${err.message}`);
    const last = cache.data;
    return last
      ? { ...last, error: `Scanner update failed: ${err.message}` }
      : { asOf: new Date(nowMs).toISOString(), candidates: [], error: `Scanner unavailable: ${err.message}` };
  }
}

export function resetScannerCache() {
  cache = { at: 0, data: null };
}

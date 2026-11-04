// Vercel serverless function: GET /api/candles?base=BTC&interval=1h
// Fetches public OHLC candles from Coinbase Exchange (no API key needed) and
// returns them oldest-first as
//   { base, interval, candles: [...finished candles], current: candle | null }
// where each candle is { time, open, high, low, close, volume }. `candles` holds
// only periods that have ended, so signals computed from it don't change while
// a period is still forming; `current` is the in-progress candle (live price).

const COINBASE = "https://api.exchange.coinbase.com";

// Coinbase supports only these granularities (seconds).
export const INTERVALS = { "15m": 900, "1h": 3600, "6h": 21600, "1d": 86400 };

export function parseCoinbase(rows) {
  if (!Array.isArray(rows)) throw new Error("unexpected response from Coinbase");
  // Each row is [time, low, high, open, close, volume], newest first.
  return rows
    .map(([time, low, high, open, close, volume]) => ({ time, open, high, low, close, volume }))
    .sort((a, b) => a.time - b.time);
}

/** Split oldest-first candles into finished ones and the one still in progress (if any). */
export function splitClosed(candles, granularitySec, nowSec = Date.now() / 1000) {
  const last = candles[candles.length - 1];
  if (last && last.time + granularitySec > nowSec) return { closed: candles.slice(0, -1), current: last };
  return { closed: candles, current: null };
}

export async function fetchCandles(base, interval, fetchImpl = fetch) {
  const granularity = INTERVALS[interval];
  const url = `${COINBASE}/products/${base}-USD/candles?granularity=${granularity}`;
  const res = await fetchImpl(url, { headers: { "User-Agent": "crypto-dashboard", Accept: "application/json" } });
  if (res.status === 404) {
    const err = new Error(`${base}-USD is not listed on Coinbase`);
    err.status = 404;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Coinbase returned HTTP ${res.status}`);
    err.status = 502;
    throw err;
  }
  return parseCoinbase(await res.json());
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const base = (url.searchParams.get("base") || "").toUpperCase();
  const interval = url.searchParams.get("interval") || "1h";

  if (!/^[A-Z0-9]{2,10}$/.test(base)) return send(res, 400, { error: "invalid base symbol" });
  if (!INTERVALS[interval]) {
    return send(res, 400, { error: `interval must be one of ${Object.keys(INTERVALS).join(", ")}` });
  }

  try {
    const { closed, current } = splitClosed(await fetchCandles(base, interval), INTERVALS[interval]);
    // Browser-only cache. Not "public": the dashboard sits behind a password, and a
    // shared cache (such as Vercel in front of the server) would otherwise hand
    // this response to visitors who haven't logged in.
    res.setHeader("Cache-Control", "private, max-age=60");
    return send(res, 200, { base, interval, candles: closed, current });
  } catch (err) {
    return send(res, err.status || 502, { error: err.message });
  }
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

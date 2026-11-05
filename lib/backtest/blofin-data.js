// Downloads and loads BloFin public market data for the backtester.
// Public endpoints only: no API key is used or needed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BLOFIN_BASE, buildPath } from "../../server/blofin.js";

const HOUR = 3_600_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createPublicClient({ fetchImpl = fetch, base = BLOFIN_BASE, pauseMs = 250 } = {}) {
  return async function get(path, params) {
    const url = base + buildPath(path, params);
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
        const body = await res.json().catch(() => null);
        if (res.status === 429 || (body && String(body.code) === "429")) throw Object.assign(new Error("rate limited"), { retry: true });
        if (!res.ok || !body || String(body.code) !== "0") {
          throw Object.assign(new Error(`BloFin ${path}: ${body?.msg || `HTTP ${res.status}`}`), { retry: res.status >= 500 });
        }
        if (pauseMs) await sleep(pauseMs);
        return body.data;
      } catch (err) {
        const retryable = err.retry || err.name === "TypeError"; // TypeError = network failure in fetch
        if (!retryable || attempt >= 4) throw err;
        await sleep(1000 * 2 ** attempt);
      }
    }
  };
}

/** BloFin candle row -> candle. Rows: [ts, open, high, low, close, vol, volCurrency, volCurrencyQuote, confirm]. */
export function parseCandle(row) {
  return { time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]), confirmed: String(row[8] ?? "1") === "1" };
}

/** Hourly candles from `sinceMs` to now, oldest first, closed bars only. Pages backwards with `after`. */
export async function fetchCandles(get, instId, sinceMs, { bar = "1H", limit = 1440, log = () => {} } = {}) {
  const byTime = new Map();
  let after;
  for (let page = 0; page < 1000; page++) {
    const rows = await get("/api/v1/market/candles", { instId, bar, after, limit });
    if (!Array.isArray(rows) || rows.length === 0) break;
    const candles = rows.map(parseCandle);
    for (const c of candles) if (c.confirmed) byTime.set(c.time, c);
    const oldest = Math.min(...candles.map((c) => c.time));
    log(`${instId}: ${byTime.size} candles, back to ${new Date(oldest).toISOString().slice(0, 10)}`);
    if (oldest <= sinceMs || oldest === after) break;
    after = oldest;
  }
  return [...byTime.values()]
    .filter((c) => c.time >= sinceMs)
    .sort((a, b) => a.time - b.time)
    .map(({ confirmed, ...c }) => c);
}

/** Funding rate history from `sinceMs`, oldest first: [{ time, rate }]. */
export async function fetchFunding(get, instId, sinceMs) {
  const byTime = new Map();
  let after;
  for (let page = 0; page < 1000; page++) {
    const rows = await get("/api/v1/market/funding-rate-history", { instId, after, limit: 100 });
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) byTime.set(Number(r.fundingTime), Number(r.fundingRate));
    const oldest = Math.min(...rows.map((r) => Number(r.fundingTime)));
    if (oldest <= sinceMs || oldest === after) break;
    after = oldest;
  }
  return [...byTime].filter(([t]) => t >= sinceMs).sort((a, b) => a[0] - b[0]).map(([time, rate]) => ({ time, rate }));
}

/** Order size rules in base units, from the instruments endpoint. */
export async function fetchSpecs(get, instIds) {
  const rows = await get("/api/v1/market/instruments");
  const specs = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!instIds.includes(r.instId)) continue;
    const cv = Number(r.contractValue) || 1;
    specs[r.instId] = {
      contractValue: cv,
      qtyStep: cv * (Number(r.lotSize) || 1),
      minQty: cv * (Number(r.minSize) || 1),
      maxLeverage: Number(r.maxLeverage) || undefined,
    };
  }
  return specs;
}

export async function downloadAll({ symbols, days, dir, get = createPublicClient(), log = console.log }) {
  mkdirSync(dir, { recursive: true });
  const since = Math.floor((Date.now() - days * 24 * HOUR) / HOUR) * HOUR;
  const specs = await fetchSpecs(get, symbols);
  writeFileSync(join(dir, "specs.json"), JSON.stringify(specs, null, 2));
  for (const sym of symbols) {
    const candles = await fetchCandles(get, sym, since, { log });
    writeFileSync(join(dir, `${sym}-1H.json`), JSON.stringify(candles));
    const funding = await fetchFunding(get, sym, since);
    writeFileSync(join(dir, `${sym}-funding.json`), JSON.stringify(funding));
    const first = candles[0] ? new Date(candles[0].time).toISOString().slice(0, 10) : "none";
    log(`${sym}: saved ${candles.length} hourly candles from ${first}, ${funding.length} funding rates`);
  }
  return specs;
}

/** Loads what downloadAll saved. Missing funding or specs fall back to defaults in the engine. */
export function loadBlofin(dir, symbols) {
  const data = {}, funding = {};
  for (const sym of symbols) {
    const f = join(dir, `${sym}-1H.json`);
    if (!existsSync(f)) throw new Error(`missing ${f}. Run: npm run backtest:fetch`);
    data[sym] = JSON.parse(readFileSync(f, "utf8"));
    const ff = join(dir, `${sym}-funding.json`);
    if (existsSync(ff)) funding[sym] = new Map(JSON.parse(readFileSync(ff, "utf8")).map((x) => [x.time, x.rate]));
  }
  const sf = join(dir, "specs.json");
  const specs = existsSync(sf) ? JSON.parse(readFileSync(sf, "utf8")) : {};
  return { data, funding, specs };
}

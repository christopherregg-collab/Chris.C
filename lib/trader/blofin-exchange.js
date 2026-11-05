// BloFin exchange adapter for the paper trader. Every call the trader makes to BloFin goes
// through here, in BloFin's units (contracts), so this is the only file that depends on
// BloFin's order API.
//
// SAFETY: this adapter only talks to BloFin's DEMO trading environment. The base URL is
// fixed and cannot be changed by configuration.
//
// The request fields follow BloFin's REST API v1 as understood when this was written; the
// docs could not be checked from the environment it was built in. If BloFin rejects a
// request, the error message (with BloFin's code) says which call and field to fix.

import { randomUUID } from "node:crypto";
import { buildPath, sign } from "../../server/blofin.js";
import { fetchCandles, fetchSpecs, createPublicClient } from "../backtest/blofin-data.js";

export const DEMO_BASE = "https://demo-trading-openapi.blofin.com";

export function demoCredentialsFromEnv(env = process.env) {
  const key = env.BLOFIN_DEMO_API_KEY;
  const secret = env.BLOFIN_DEMO_API_SECRET;
  const passphrase = env.BLOFIN_DEMO_API_PASSPHRASE;
  if (!key || !secret || !passphrase) return null;
  return { key, secret, passphrase };
}

/** Signed GET/POST client for the demo environment. */
export function createDemoClient(creds, { fetchImpl = fetch, now = Date.now, nonce = randomUUID } = {}) {
  async function request(method, path, params, body) {
    const requestPath = method === "GET" ? buildPath(path, params) : path;
    const payload = body === undefined ? "" : JSON.stringify(body);
    const timestamp = String(now());
    const n = nonce();
    const headers = {
      "ACCESS-KEY": creds.key,
      "ACCESS-SIGN": sign(creds.secret, requestPath + method + timestamp + n + payload),
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-NONCE": n,
      "ACCESS-PASSPHRASE": creds.passphrase,
      Accept: "application/json",
      ...(payload ? { "Content-Type": "application/json" } : {}),
    };
    const res = await fetchImpl(DEMO_BASE + requestPath, { method, headers, ...(payload ? { body: payload } : {}) });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || String(json.code) !== "0") {
      const detail = Array.isArray(json?.data) && json.data[0]?.msg ? `: ${json.data[0].msg}` : "";
      throw new Error(`BloFin demo ${method} ${path}: ${json?.msg || `HTTP ${res.status}`}${json?.code ? ` (code ${json.code})` : ""}${detail}`);
    }
    return json.data;
  }
  return {
    get: (path, params) => request("GET", path, params),
    post: (path, body) => request("POST", path, undefined, body),
  };
}

const str = (x) => String(x);
const num = (v) => (v === undefined || v === null || v === "" ? undefined : Number(v));
const list = (x) => (Array.isArray(x) ? x : x ? [x] : []);

/**
 * The exchange interface the trader uses. Sizes are in contracts, prices in USDT.
 * marginMode is "isolated" so each position can only lose its own margin.
 */
export function createBlofinExchange(client, { marginMode = "isolated", publicGet = createPublicClient({ base: DEMO_BASE }) } = {}) {
  return {
    name: "BloFin demo",
    candles: (sym, barLabel, sinceMs) => fetchCandles(publicGet, sym, sinceMs, { bar: barLabel }),
    specs: (symbols) => fetchSpecs(publicGet, symbols),

    async equity() {
      const bal = await client.get("/api/v1/account/balance");
      return num(bal?.totalEquity) ?? 0;
    },

    async positions() {
      const rows = list(await client.get("/api/v1/account/positions"));
      return rows
        .filter((p) => Number(p.positions) !== 0)
        .map((p) => ({
          symbol: p.instId,
          contracts: Number(p.positions), // signed in net mode: + long, - short
          avgPrice: num(p.averagePrice) ?? 0,
          unrealizedPnl: num(p.unrealizedPnl) ?? 0,
        }));
    },

    async pendingOrders() {
      const rows = list(await client.get("/api/v1/trade/orders-pending", { limit: 100 }));
      return rows.map((o) => ({
        symbol: o.instId, orderId: str(o.orderId), side: o.side, price: num(o.price),
        contracts: num(o.size), filled: num(o.filledSize) ?? 0, state: o.state,
      }));
    },

    async pendingStops() {
      const rows = list(await client.get("/api/v1/trade/orders-tpsl-pending", { limit: 100 }));
      return rows.map((o) => ({ symbol: o.instId, stopId: str(o.tpslId), triggerPrice: num(o.slTriggerPrice) }));
    },

    async setLeverage(sym, leverage) {
      await client.post("/api/v1/account/set-leverage", { instId: sym, leverage: str(leverage), marginMode });
    },

    async placeLimit(sym, side, price, contracts) {
      const data = await client.post("/api/v1/trade/order", {
        instId: sym, marginMode, positionSide: "net", side, orderType: "limit",
        price: str(price), size: str(contracts), clientOrderId: `pt${Date.now()}`,
      });
      return str(list(data)[0]?.orderId);
    },

    async placeMarket(sym, side, contracts, reduceOnly = false) {
      const data = await client.post("/api/v1/trade/order", {
        instId: sym, marginMode, positionSide: "net", side, orderType: "market",
        size: str(contracts), reduceOnly: str(reduceOnly), clientOrderId: `pt${Date.now()}`,
      });
      return str(list(data)[0]?.orderId);
    },

    async cancelOrder(sym, orderId) {
      await client.post("/api/v1/trade/cancel-order", { instId: sym, orderId: str(orderId) });
    },

    /** Stop-loss for the whole position: market close when the trigger is hit. */
    async placeStop(sym, side, triggerPrice) {
      const data = await client.post("/api/v1/trade/order-tpsl", {
        instId: sym, marginMode, positionSide: "net", side,
        slTriggerPrice: str(triggerPrice), slOrderPrice: "-1", size: "-1", reduceOnly: "true",
        clientOrderId: `ps${Date.now()}`,
      });
      return str(list(data)[0]?.tpslId ?? data?.tpslId);
    },

    async cancelStop(sym, stopId) {
      await client.post("/api/v1/trade/cancel-tpsl", [{ instId: sym, tpslId: str(stopId) }]);
    },

    /** Net realized P&L (fees and funding included) of positions on `sym` closed after `sinceMs`; null if none yet. */
    async closedPnl(sym, sinceMs) {
      const rows = list(await client.get("/api/v1/account/positions-history", { instId: sym, begin: sinceMs, limit: 100 }));
      const mine = rows.filter((r) => r.instId === sym && Number(r.updateTime) >= sinceMs);
      if (!mine.length) return null;
      return mine.reduce((a, r) => a + (num(r.realizedPnl) ?? 0), 0);
    },
  };
}

/**
 * Dry-run exchange: real public candles and order rules from BloFin's live API, but an
 * empty account and no orders sent. Every order the trader would place is recorded in
 * `actions` instead.
 */
export function createDryRunExchange({ publicGet = createPublicClient(), equity = 60 } = {}) {
  const actions = [];
  let id = 0;
  const log = (a) => { actions.push(a); return String(++id); };
  return {
    name: "dry run (live prices, no orders)",
    actions,
    candles: (sym, barLabel, sinceMs) => fetchCandles(publicGet, sym, sinceMs, { bar: barLabel }),
    specs: (symbols) => fetchSpecs(publicGet, symbols),
    equity: async () => equity,
    positions: async () => [],
    pendingOrders: async () => [],
    pendingStops: async () => [],
    setLeverage: async (sym, leverage) => { log({ type: "set leverage", sym, leverage }); },
    placeLimit: async (sym, side, price, contracts) => log({ type: "limit", sym, side, price, contracts }),
    placeMarket: async (sym, side, contracts, reduceOnly) => log({ type: "market", sym, side, contracts, reduceOnly }),
    cancelOrder: async (sym, orderId) => { log({ type: "cancel", sym, orderId }); },
    placeStop: async (sym, side, triggerPrice) => log({ type: "stop", sym, side, triggerPrice }),
    cancelStop: async (sym, stopId) => { log({ type: "cancel stop", sym, stopId }); },
    closedPnl: async () => null,
  };
}

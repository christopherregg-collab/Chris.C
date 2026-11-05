// BloFin exchange adapter for the trader. Every call the trader makes to BloFin goes
// through here, in BloFin's units (contracts), so this is the only file that depends on
// BloFin's order API.
//
// SAFETY: a trading client talks to BloFin's DEMO environment unless it is created with
// { live: true }, which scripts only do behind an explicit --live flag plus LIVE_TRADING=on,
// with separate keys (BLOFIN_TRADE_*). The two base URLs are fixed, not configurable.
//
// Request paths and fields were checked (Nov 2026) against two independent BloFin clients:
// ccxt 4.5.92 (js/src/blofin.js) and the community "blofin" Python SDK 0.5.0. BloFin's own
// docs site blocks automated readers, so it could not be read directly. If BloFin rejects a
// request, the error message (with BloFin's code) says which call and field to fix.

import { randomUUID } from "node:crypto";
import { BLOFIN_BASE, buildPath, sign } from "../../server/blofin.js";
import { fetchCandles, fetchSpecs, createPublicClient } from "../backtest/blofin-data.js";

export const DEMO_BASE = "https://demo-trading-openapi.blofin.com";

export function demoCredentialsFromEnv(env = process.env) {
  const key = env.BLOFIN_DEMO_API_KEY;
  const secret = env.BLOFIN_DEMO_API_SECRET;
  const passphrase = env.BLOFIN_DEMO_API_PASSPHRASE;
  if (!key || !secret || !passphrase) return null;
  return { key, secret, passphrase };
}

/** Keys for real-money trading: a SEPARATE BloFin key with trade permission (never withdrawal). */
export function liveCredentialsFromEnv(env = process.env) {
  const key = env.BLOFIN_TRADE_API_KEY;
  const secret = env.BLOFIN_TRADE_API_SECRET;
  const passphrase = env.BLOFIN_TRADE_API_PASSPHRASE;
  if (!key || !secret || !passphrase) return null;
  return { key, secret, passphrase };
}

/** Signed GET/POST client for the demo environment. */
export function createDemoClient(creds, opts = {}) {
  return createTradingClient(creds, { ...opts, live: false });
}

/** Signed GET/POST client: demo by default, the real account only with { live: true }. */
export function createTradingClient(creds, { live = false, fetchImpl = fetch, now = Date.now, nonce = randomUUID } = {}) {
  const base = live === true ? BLOFIN_BASE : DEMO_BASE;
  const label = live === true ? "BloFin LIVE" : "BloFin demo";
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
    const res = await fetchImpl(base + requestPath, { method, headers, ...(payload ? { body: payload } : {}) });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || String(json.code) !== "0") {
      const detail = Array.isArray(json?.data) && json.data[0]?.msg ? `: ${json.data[0].msg}` : "";
      throw new Error(`${label} ${method} ${path}: ${json?.msg || `HTTP ${res.status}`}${json?.code ? ` (code ${json.code})` : ""}${detail}`);
    }
    return json.data;
  }
  return {
    live: live === true,
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
export function createBlofinExchange(client, { marginMode = "isolated", publicGet = createPublicClient({ base: client.live ? BLOFIN_BASE : DEMO_BASE }) } = {}) {
  return {
    name: client.live ? "BloFin LIVE (real money)" : "BloFin demo",
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
          markPrice: num(p.markPrice),
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

    /**
     * The trader's orders assume isolated margin and net position mode (one position per
     * coin). If the account is set differently, switch it while nothing is open, otherwise stop.
     */
    async prepareAccount(log = () => {}) {
      const [mm, pm] = await Promise.all([client.get("/api/v1/account/margin-mode"), client.get("/api/v1/account/position-mode")]);
      const wrongMargin = mm?.marginMode !== marginMode;
      const wrongPosition = pm?.positionMode !== "net_mode";
      if (!wrongMargin && !wrongPosition) return;
      const [positions, orders] = await Promise.all([this.positions(), this.pendingOrders()]);
      if (positions.length || orders.length) {
        throw new Error(`Account is in ${mm?.marginMode} margin / ${pm?.positionMode}, but the trader needs ${marginMode} / net_mode. Close all positions and orders on the account so it can switch.`);
      }
      if (wrongMargin) {
        await client.post("/api/v1/account/set-margin-mode", { marginMode });
        log("account set to isolated margin", { was: mm?.marginMode });
      }
      if (wrongPosition) {
        await client.post("/api/v1/account/set-position-mode", { positionMode: "net_mode" });
        log("account set to net position mode", { was: pm?.positionMode });
      }
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
    /**
     * `sinceMs` should be before the position opened (the trader passes the time it placed the
     * entry order). Position history is tried first; if it has nothing yet (it can lag, and was
     * empty on the demo account), the fills are summed: realized P&L of each fill minus its fee.
     */
    async closedPnl(sym, sinceMs) {
      const from = sinceMs - 5_000; // small allowance for clock differences
      const history = list(await client.get("/api/v1/account/positions-history", { instId: sym, limit: 100 }));
      const closedPositions = history.filter((r) => r.instId === sym && Number(r.createTime) >= from);
      if (closedPositions.length) return closedPositions.reduce((a, r) => a + (num(r.realizedPnl) ?? 0), 0);
      const fills = list(await client.get("/api/v1/trade/fills-history", { instId: sym, begin: from, limit: 100 }))
        .filter((f) => f.instId === sym && Number(f.ts) >= from);
      if (!fills.some((f) => Math.abs(num(f.fillPnl) ?? 0) > 0)) return null; // no closing fill yet
      return fills.reduce((a, f) => a + (num(f.fillPnl) ?? 0) - Math.abs(num(f.fee) ?? 0), 0);
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
    prepareAccount: async () => {},
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

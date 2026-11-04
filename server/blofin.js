// Read-only BloFin REST client. Runs only on the server: the key, secret and
// passphrase come from environment variables and never reach the browser.
//
// Signing (docs.blofin.com, "Authentication"):
//   prehash   = requestPath (with query string) + METHOD + timestamp(ms) + nonce + body
//   signature = base64( hex( HMAC-SHA256(secret, prehash) ) )   <- base64 of the hex *string*
// This client only sends GET requests, so the body is always empty.

import { createHmac, randomUUID } from "node:crypto";

export const BLOFIN_BASE = "https://openapi.blofin.com";

export function credentialsFromEnv(env = process.env) {
  const key = env.BLOFIN_API_KEY;
  const secret = env.BLOFIN_API_SECRET;
  const passphrase = env.BLOFIN_API_PASSPHRASE;
  if (!key || !secret || !passphrase) return null;
  return { key, secret, passphrase };
}

export function sign(secret, prehash) {
  const hex = createHmac("sha256", secret).update(prehash).digest("hex");
  return Buffer.from(hex, "utf8").toString("base64");
}

export function buildPath(path, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

export function createClient(creds, { fetchImpl = fetch, base = BLOFIN_BASE, now = Date.now, nonce = randomUUID } = {}) {
  async function get(path, params) {
    const requestPath = buildPath(path, params);
    const timestamp = String(now());
    const n = nonce();
    const headers = {
      "ACCESS-KEY": creds.key,
      "ACCESS-SIGN": sign(creds.secret, requestPath + "GET" + timestamp + n),
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-NONCE": n,
      "ACCESS-PASSPHRASE": creds.passphrase,
      Accept: "application/json",
    };
    const res = await fetchImpl(base + requestPath, { headers });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || String(body.code) !== "0") {
      const why = body?.msg || `HTTP ${res.status}`;
      const err = new Error(`BloFin ${path}: ${why}${body?.code ? ` (code ${body.code})` : ""}`);
      err.status = 502;
      throw err;
    }
    return body.data;
  }
  return { get };
}

const num = (v) => (v === undefined || v === null || v === "" ? undefined : Number(v));

/** Current equity and available balance of the futures (trading) account. */
export async function fetchAccount(client) {
  const bal = await client.get("/api/v1/account/balance");
  const details = Array.isArray(bal?.details) ? bal.details : [];
  const usdt = details.find((d) => d.currency === "USDT");
  return {
    equity: num(bal?.totalEquity) ?? 0,
    available: num(usdt?.available) ?? details.reduce((s, d) => s + (num(d.available) ?? 0), 0),
  };
}

/**
 * Net transfers into (+) and out of (−) the futures account after `sinceMs`.
 * Deposits land in the funding account, so for trading-return purposes the
 * cash flows that matter are transfers between funding and futures.
 */
export async function fetchCashFlowSince(client, sinceMs) {
  const [inbound, outbound] = await Promise.all([
    client.get("/api/v1/asset/bills", { toAccount: "futures", before: sinceMs, limit: 100 }),
    client.get("/api/v1/asset/bills", { fromAccount: "futures", before: sinceMs, limit: 100 }),
  ]);
  const usd = (rows) =>
    (Array.isArray(rows) ? rows : [])
      .filter((r) => Number(r.ts) > sinceMs && ["USDT", "USDC", "USD"].includes(r.currency))
      .reduce((s, r) => s + (num(r.amount) ?? 0), 0);
  return usd(inbound) - usd(outbound);
}

let instrumentCache = { at: 0, map: new Map() };

async function contractValues(client, nowMs) {
  if (nowMs - instrumentCache.at < 6 * 3_600_000 && instrumentCache.map.size) return instrumentCache.map;
  const rows = await client.get("/api/v1/market/instruments");
  const map = new Map((Array.isArray(rows) ? rows : []).map((r) => [r.instId, num(r.contractValue) ?? 1]));
  instrumentCache = { at: nowMs, map };
  return map;
}

function sideOf(positionSide, qty) {
  if (positionSide === "long" || positionSide === "short") return positionSide;
  return qty < 0 ? "short" : "long";
}

/** Open positions, in base units, with stop/target from pending TP/SL orders. */
export async function fetchPositions(client, nowMs = Date.now()) {
  const [rows, tpsl, cv] = await Promise.all([
    client.get("/api/v1/account/positions"),
    client.get("/api/v1/trade/orders-tpsl-pending", { limit: 100 }),
    contractValues(client, nowMs),
  ]);
  const orders = (Array.isArray(tpsl) ? tpsl : []).filter((o) => o.state === "live" || o.state === "effective" || !o.state);
  return (Array.isArray(rows) ? rows : [])
    .filter((p) => Number(p.positions) !== 0)
    .map((p) => {
      const qty = Number(p.positions);
      const side = sideOf(p.positionSide, qty);
      const match =
        orders.find((o) => o.positionId && o.positionId === p.positionId) ??
        orders.find((o) => o.instId === p.instId && o.positionSide === p.positionSide);
      return {
        id: String(p.positionId),
        symbol: p.instId,
        side,
        size: Math.abs(qty) * (cv.get(p.instId) ?? 1),
        entryPrice: num(p.averagePrice) ?? 0,
        markPrice: num(p.markPrice) ?? 0,
        leverage: num(p.leverage),
        stopPrice: num(match?.slTriggerPrice),
        targetPrice: num(match?.tpTriggerPrice),
        openedAt: new Date(Number(p.createTime)).toISOString(),
        unrealizedPnl: num(p.unrealizedPnl) ?? 0,
      };
    });
}

/** Closed (and partially closed) positions since `sinceMs`, newest first, up to 500. */
export async function fetchClosedTrades(client, sinceMs, nowMs = Date.now()) {
  const out = [];
  let after;
  for (let page = 0; page < 5; page++) {
    const rows = await client.get("/api/v1/account/positions-history", { begin: sinceMs, end: nowMs, after, limit: 100 });
    if (!Array.isArray(rows) || rows.length === 0) break;
    out.push(...rows);
    if (rows.length < 100) break;
    after = rows[rows.length - 1].historyId;
  }
  return out.map((r) => ({
    id: `ph-${r.historyId}`,
    symbol: r.instId,
    side: r.positionSide === "long" || r.positionSide === "short" ? r.positionSide : r.side === "sell" ? "short" : "long",
    openedAt: new Date(Number(r.createTime)).toISOString(),
    // BloFin has no explicit close time; updateTime is when the record last changed.
    closedAt: new Date(Number(r.updateTime)).toISOString(),
    realizedPnl: num(r.realizedPnl) ?? 0,
  }));
}

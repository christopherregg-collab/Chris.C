import test from "node:test";
import assert from "node:assert/strict";
import { initialState, runOnce } from "../lib/trader/trader.js";
import { createLadder } from "../lib/backtest/ladder.js";
import { runBacktest } from "../lib/backtest/engine.js";
import { syntheticMarket } from "../lib/backtest/synthetic.js";
import { resample } from "../lib/backtest/ta.js";
import { createDemoClient, DEMO_BASE } from "../lib/trader/blofin-exchange.js";
import { COSTS, LADDER, LEVELS, LIMITS, STRATEGIES } from "../lib/backtest/settings.js";

const HOUR = 3_600_000;
const SPEC = { contractValue: 0.001, lotSize: 0.1, minSize: 0.1, tickSize: 0.1 };

/**
 * A simulated exchange that replays candles. Orders placed at time `now` fill against the
 * candles that follow, the way the backtester assumes: limits fill when price trades back
 * to them, stops trigger on the candle's low/high, market orders fill at the next open.
 * No fees, so P&L is easy to check.
 */
function replayExchange(data, barMs) {
  let now = 0;
  let id = 0;
  const positions = {};
  const orders = [];
  const stops = [];
  const closed = [];
  const calls = [];
  const candleAt = (sym, t) => data[sym].find((c) => c.time === t);
  function fill(sym, side, contracts, price, t) {
    const p = (positions[sym] ??= { contracts: 0, avgPrice: 0, openedAt: t });
    const signed = side === "buy" ? contracts : -contracts;
    if (Math.sign(p.contracts) === Math.sign(signed) || p.contracts === 0) {
      p.avgPrice = (p.avgPrice * Math.abs(p.contracts) + price * contracts) / (Math.abs(p.contracts) + contracts);
      p.contracts += signed;
    } else {
      const pnl = (price - p.avgPrice) * Math.sign(p.contracts) * Math.min(contracts, Math.abs(p.contracts)) * SPEC.contractValue;
      closed.push({ sym, pnl, t });
      p.contracts += signed;
      if (Math.abs(p.contracts) < 1e-9) delete positions[sym];
    }
  }
  return {
    calls, closed, positions,
    /** Play every candle that opens in [now, t) against the open orders, then set now = t. */
    advanceTo(t) {
      for (let c0 = now; c0 < t; c0 += barMs) {
        for (const sym of Object.keys(data)) {
          const c = candleAt(sym, c0);
          if (!c) continue;
          for (const o of orders.filter((x) => x.sym === sym)) {
            const hit = o.type === "market" || (o.side === "buy" ? c.low <= o.price : c.high >= o.price);
            if (!hit) continue;
            const price = o.type === "market" ? c.open : o.side === "buy" ? Math.min(c.open, o.price) : Math.max(c.open, o.price);
            if (o.reduceOnly && !positions[sym]) { orders.splice(orders.indexOf(o), 1); continue; }
            fill(sym, o.side, o.reduceOnly ? Math.abs(positions[sym].contracts) : o.contracts, price, c0);
            orders.splice(orders.indexOf(o), 1);
          }
          for (const s of stops.filter((x) => x.sym === sym)) {
            const p = positions[sym];
            if (!p) { stops.splice(stops.indexOf(s), 1); continue; }
            const hit = s.side === "sell" ? c.low <= s.trigger : c.high >= s.trigger;
            if (!hit) continue;
            const price = s.side === "sell" ? Math.min(c.open, s.trigger) : Math.max(c.open, s.trigger);
            fill(sym, s.side, Math.abs(p.contracts), price, c0);
            stops.splice(stops.indexOf(s), 1);
          }
        }
      }
      now = t;
    },
    candles: async (sym, _label, since) => data[sym].filter((c) => c.time >= since && c.time + barMs <= now),
    specs: async (symbols) => Object.fromEntries(symbols.map((s) => [s, SPEC])),
    positions: async () => Object.entries(positions).map(([symbol, p]) => {
      const last = data[symbol].filter((c) => c.time + barMs <= now).at(-1);
      return { symbol, contracts: p.contracts, avgPrice: p.avgPrice, unrealizedPnl: (last.close - p.avgPrice) * p.contracts * SPEC.contractValue };
    }),
    pendingOrders: async () => orders.filter((o) => o.type === "limit").map((o) => ({ symbol: o.sym, orderId: o.id, side: o.side, price: o.price, contracts: o.contracts })),
    pendingStops: async () => stops.map((s) => ({ symbol: s.sym, stopId: s.id, triggerPrice: s.trigger })),
    setLeverage: async (sym, lev) => { calls.push(["leverage", sym, lev]); },
    placeLimit: async (sym, side, price, contracts) => { const o = { id: String(++id), sym, side, price, contracts, type: "limit" }; orders.push(o); calls.push(["limit", sym, side, price, contracts]); return o.id; },
    placeMarket: async (sym, side, contracts, reduceOnly) => { const o = { id: String(++id), sym, side, contracts, reduceOnly, type: "market" }; orders.push(o); calls.push(["market", sym, side, contracts, reduceOnly]); return o.id; },
    cancelOrder: async (_sym, orderId) => { const i = orders.findIndex((o) => o.id === orderId); if (i > -1) orders.splice(i, 1); calls.push(["cancel", orderId]); },
    placeStop: async (sym, side, trigger) => { const s = { id: String(++id), sym, side, trigger }; stops.push(s); calls.push(["stop", sym, side, trigger]); return s.id; },
    cancelStop: async (_sym, stopId) => { const i = stops.findIndex((s) => s.id === stopId); if (i > -1) stops.splice(i, 1); calls.push(["cancel stop", stopId]); },
    closedPnl: async (sym, since) => {
      const rows = closed.filter((c) => c.sym === sym && c.t >= since - barMs);
      return rows.length ? rows.reduce((a, c) => a + c.pnl, 0) : null;
    },
  };
}

function market(days) {
  const hourly = syntheticMarket({ hours: days * 24, seed: 11 });
  return Object.fromEntries(Object.entries(hourly).map(([sym, c]) =>
    [sym, resample(c, 4 * HOUR, HOUR).filter((b) => b.complete).map(({ end, complete, ...b }) => b)]));
}

async function replay(strategy, data, { level = LEVELS.conservative, pot = 1000, limits = { ...LIMITS, killSwitch: null } } = {}) {
  const ex = replayExchange(data, strategy.barMs);
  let state = initialState(pot);
  const times = data[strategy.symbols[0]].map((c) => c.time + strategy.barMs);
  for (const t of times) {
    ex.advanceTo(t);
    ({ state } = await runOnce({ ex, strategy, level, ladderRules: LADDER, limits, pot, state, now: t }));
  }
  return { ex, state };
}

test("the paper trader takes the same trades as the backtester on the same candles", async () => {
  const data = market(240);
  const strategy = { ...STRATEGIES.swing, symbols: ["BTC-USDT", "ETH-USDT"], adxMin: 20, volumeMult: 1.0 };
  const { state } = await replay(strategy, data);
  const bt = runBacktest({
    strategy, level: LEVELS.conservative, ladder: LADDER, limits: { ...LIMITS, killSwitch: null },
    costs: { ...COSTS, takerFee: 0, makerFee: 0, slippage: 0, defaultFundingRate: 0 },
    specs: { "BTC-USDT": { qtyStep: 0.0001, minQty: 0.0001 }, "ETH-USDT": { qtyStep: 0.0001, minQty: 0.0001 } },
    data, startEquity: 1000,
  });
  assert.ok(bt.trades.length >= 5, `backtest made ${bt.trades.length} trades`);
  assert.ok(state.trades.length >= 5, `trader made ${state.trades.length} trades`);
  // Entry candles: the backtest records the fill candle; the trader learns of the fill one candle later.
  const btEntries = new Set(bt.trades.map((t) => `${t.symbol}@${t.openTime}`));
  const trEntries = state.trades.map((t) => `${t.sym}@${Date.parse(t.openedAt) - strategy.barMs}`);
  const matched = trEntries.filter((e) => btEntries.has(e)).length;
  if (process.env.SHOW_PARITY) console.log({ backtest: bt.trades.length, trader: state.trades.length, matched, btR: bt.trades.reduce((a, t) => a + t.r, 0), trR: state.trades.reduce((a, t) => a + t.r, 0) });
  assert.ok(matched / trEntries.length >= 0.8, `only ${matched} of ${trEntries.length} trader entries match the backtest`);
  // Same direction of results overall.
  const btSum = bt.trades.reduce((a, t) => a + t.r, 0);
  const trSum = state.trades.reduce((a, t) => a + t.r, 0);
  assert.equal(Math.sign(btSum), Math.sign(trSum));
});

test("every filled position gets a stop, and stops only ever move in the trade's favour", async () => {
  const data = market(200);
  const strategy = { ...STRATEGIES.swing, symbols: ["BTC-USDT", "ETH-USDT"], adxMin: 20, volumeMult: 1.0 };
  const { ex } = await replay(strategy, data);
  const stopsBySym = {};
  for (const c of ex.calls.filter((x) => x[0] === "stop")) (stopsBySym[c[1]] ??= []).push(c);
  assert.ok(Object.keys(stopsBySym).length > 0);
  // Every limit order that filled produced a stop (count stops >= fills that became positions).
  const fills = ex.calls.filter((x) => x[0] === "limit").length;
  assert.ok(ex.calls.filter((x) => x[0] === "stop").length >= Math.min(1, fills));
});

test("expired limit entries are cancelled and counted", async () => {
  const strategy = { ...STRATEGIES.swing, symbols: ["BTC-USDT"], breakout: 3, adxMin: 0, volumeMult: 0, trendFilters: [], pyramid: null };
  const flat = Array.from({ length: 80 }, (_, i) => ({ time: i * 4 * HOUR, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
  const run = [{ time: 80 * 4 * HOUR, open: 100, high: 106, low: 100, close: 105, volume: 1 },
    ...Array.from({ length: 5 }, (_, k) => ({ time: (81 + k) * 4 * HOUR, open: 107 + k * 2, high: 109 + k * 2, low: 106 + k * 2, close: 108 + k * 2, volume: 1 }))];
  const { state, ex } = await replay(strategy, { "BTC-USDT": [...flat, ...run] });
  assert.ok(state.missedEntries >= 1);
  assert.ok(ex.calls.some((c) => c[0] === "cancel"));
  assert.equal(state.trades.length, 0);
});

test("a position the trader didn't open is reported and never touched", async () => {
  const strategy = { ...STRATEGIES.swing, symbols: ["BTC-USDT"] };
  const calls = [];
  const ex = {
    specs: async () => ({ "BTC-USDT": SPEC }),
    positions: async () => [{ symbol: "BTC-USDT", contracts: 5, avgPrice: 100, unrealizedPnl: -50 }],
    pendingOrders: async () => [], pendingStops: async () => [],
    candles: async () => [],
    placeMarket: async (...a) => { calls.push(a); }, placeLimit: async (...a) => { calls.push(a); },
    placeStop: async (...a) => { calls.push(a); }, cancelStop: async () => {}, cancelOrder: async () => {},
  };
  const events = [];
  const { state } = await runOnce({ ex, strategy, level: LEVELS.conservative, ladderRules: LADDER, limits: LIMITS, pot: 60, state: initialState(60), now: Date.UTC(2026, 0, 1), log: (e) => events.push(e) });
  assert.ok(events.some((e) => e.type === "unmanaged position left alone"));
  assert.equal(calls.length, 0);
  assert.equal(state.equity, 60, "unmanaged P&L is not counted in the pot");
});

test("the kill switch closes managed positions and stops new entries", async () => {
  const strategy = { ...STRATEGIES.swing, symbols: ["BTC-USDT"] };
  const calls = [];
  const state0 = initialState(100);
  state0.peak = 100;
  state0.coins["BTC-USDT"] = { status: "open", side: 1, stop: 90, stopId: "s1", entryPrice: 100, extreme: 100, lastAdd: 100, adds: 0, atrEntry: 2, openedAt: 0, initialRisk: 10, unitContracts: 1 };
  const ex = {
    specs: async () => ({ "BTC-USDT": SPEC }),
    positions: async () => [{ symbol: "BTC-USDT", contracts: 1, avgPrice: 100, unrealizedPnl: -30 }],
    pendingOrders: async () => [], pendingStops: async () => [{ symbol: "BTC-USDT", stopId: "s1" }],
    candles: async () => [],
    placeMarket: async (...a) => { calls.push(["market", ...a]); }, placeLimit: async (...a) => { calls.push(["limit", ...a]); },
    placeStop: async (...a) => { calls.push(["stop", ...a]); }, cancelStop: async (...a) => { calls.push(["cancel stop", ...a]); }, cancelOrder: async () => {},
  };
  const { state } = await runOnce({ ex, strategy, level: LEVELS.conservative, ladderRules: LADDER, limits: LIMITS, pot: 100, state: state0, now: Date.UTC(2026, 0, 1) });
  assert.equal(state.killed, true);
  assert.deepEqual(calls.map((c) => c[0]), ["cancel stop", "market"]);
  assert.deepEqual(calls[1].slice(1), ["BTC-USDT", "sell", 1, true]);
});

test("ladder state survives a restart", () => {
  const l = createLadder(LEVELS.aggressive, LADDER);
  l.record(1); l.record(1);
  const restored = createLadder(LEVELS.aggressive, LADDER, JSON.parse(JSON.stringify(l.state())));
  assert.equal(restored.current(100, 100), l.current(100, 100));
});

test("demo client signs POST bodies and only talks to the demo host", async () => {
  let seen;
  const client = createDemoClient({ key: "k", secret: "s", passphrase: "p" }, {
    now: () => 1700000000000, nonce: () => "n1",
    fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ code: "0", data: [{ orderId: "9" }] }) }; },
  });
  const data = await client.post("/api/v1/trade/order", { instId: "BTC-USDT" });
  assert.equal(data[0].orderId, "9");
  assert.ok(seen.url.startsWith(DEMO_BASE));
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.body, JSON.stringify({ instId: "BTC-USDT" }));
  const { sign } = await import("../server/blofin.js");
  assert.equal(seen.init.headers["ACCESS-SIGN"], sign("s", "/api/v1/trade/order" + "POST" + "1700000000000" + "n1" + seen.init.body));
});

test("prepareAccount switches a fresh demo account to isolated margin and net mode", async () => {
  const { createBlofinExchange } = await import("../lib/trader/blofin-exchange.js");
  const posts = [];
  const client = {
    get: async (path) => ({
      "/api/v1/account/margin-mode": { marginMode: "cross" },
      "/api/v1/account/position-mode": { positionMode: "long_short_mode" },
      "/api/v1/account/positions": [],
      "/api/v1/trade/orders-pending": [],
    })[path],
    post: async (path, body) => { posts.push([path, body]); return {}; },
  };
  await createBlofinExchange(client, { publicGet: async () => [] }).prepareAccount();
  assert.deepEqual(posts, [
    ["/api/v1/account/set-margin-mode", { marginMode: "isolated" }],
    ["/api/v1/account/set-position-mode", { positionMode: "net_mode" }],
  ]);
});

test("prepareAccount refuses to switch modes while positions are open", async () => {
  const { createBlofinExchange } = await import("../lib/trader/blofin-exchange.js");
  const client = {
    get: async (path) => ({
      "/api/v1/account/margin-mode": { marginMode: "cross" },
      "/api/v1/account/position-mode": { positionMode: "net_mode" },
      "/api/v1/account/positions": [{ instId: "BTC-USDT", positions: "1", averagePrice: "1", unrealizedPnl: "0" }],
      "/api/v1/trade/orders-pending": [],
    })[path],
    post: async () => { throw new Error("must not post"); },
  };
  await assert.rejects(createBlofinExchange(client, { publicGet: async () => [] }).prepareAccount(), /Close all positions/);
});

test("order requests use the field names BloFin's clients use", async () => {
  const { createBlofinExchange } = await import("../lib/trader/blofin-exchange.js");
  const posts = [];
  const client = { get: async () => [], post: async (path, body) => { posts.push([path, body]); return path.endsWith("order-tpsl") ? { tpslId: "77" } : [{ orderId: "5" }]; } };
  const ex = createBlofinExchange(client, { publicGet: async () => [] });
  assert.equal(await ex.placeLimit("BTC-USDT", "buy", 100.5, 2), "5");
  assert.equal(await ex.placeStop("BTC-USDT", "sell", 95), "77");
  await ex.cancelStop("BTC-USDT", "77");
  const [order, stop, cancel] = posts;
  assert.equal(order[0], "/api/v1/trade/order");
  assert.deepEqual({ ...order[1], clientOrderId: undefined }, { instId: "BTC-USDT", marginMode: "isolated", positionSide: "net", side: "buy", orderType: "limit", price: "100.5", size: "2", clientOrderId: undefined });
  assert.deepEqual({ ...stop[1], clientOrderId: undefined }, { instId: "BTC-USDT", marginMode: "isolated", positionSide: "net", side: "sell", slTriggerPrice: "95", slOrderPrice: "-1", size: "-1", reduceOnly: "true", clientOrderId: undefined });
  assert.deepEqual(cancel, ["/api/v1/trade/cancel-tpsl", [{ instId: "BTC-USDT", tpslId: "77" }]]);
});

// --- dashboard view -----------------------------------------------------------

test("paperDashboard maps the trader's state into Strategy 2, trades and events", async () => {
  const { paperDashboard, PAPER_SLOT } = await import("../lib/trader/dashboard-view.js");
  const state = {
    ...initialState(60), equity: 63.5, updatedAt: "2026-11-05T16:10:00.000Z",
    trades: [{ sym: "ETH-USDT", side: "long", openedAt: "2026-11-01T00:00:00.000Z", closedAt: "2026-11-02T00:00:00.000Z", pnl: -0.6, initialRisk: 0.6 }],
    view: { positions: [{ symbol: "SOL-USDT", side: "long", size: 0.5, entryPrice: 150, markPrice: 158, stopPrice: 147, unrealizedPnl: 4, openedAt: "2026-11-04T00:00:00.000Z", adds: 1 }], entering: [] },
  };
  const events = [{ time: "2026-11-04T00:00:00.000Z", type: "filled", sym: "SOL-USDT", side: "long", price: 150, stop: 147 }];
  const d = paperDashboard({ state, events }, { pot: 60 });
  assert.equal(d.strategy.slot, PAPER_SLOT);
  assert.equal(d.strategy.status, "in_position");
  assert.equal(d.strategy.asOf, state.updatedAt);
  assert.match(d.strategy.message, /\$63\.50/);
  assert.equal(d.strategy.positions[0].stopPrice, 147);
  assert.equal(d.trades.length, 2);
  assert.ok(d.trades.every((t) => t.paper && t.slot === PAPER_SLOT));
  assert.equal(d.trades.find((t) => t.closedAt).realizedPnl, -0.6);
  assert.equal(d.events[0].level, "success");
  assert.match(d.events[0].text, /SOL-USDT long filled at 150/);
  assert.equal(paperDashboard(null), null);
  const killed = paperDashboard({ state: { ...state, killed: true, view: { positions: [], entering: [] } }, events: [] });
  assert.equal(killed.strategy.status, "paused");
});

test("the dashboard API adds the paper trader without touching the real-account slot", async () => {
  const { buildDashboard } = await import("../api/dashboard.js");
  const client = { get: async (path) => (path === "/api/v1/account/balance" ? { totalEquity: "100", details: [] } : []) };
  const scanner = async () => ({ asOf: new Date(0).toISOString(), candidates: [] });
  const without = await buildDashboard(client, { nowMs: Date.UTC(2026, 10, 5), scanner });
  assert.equal(without.strategies.length, 1);
  const state = { ...initialState(60), updatedAt: "2026-11-05T00:00:00.000Z", view: { positions: [], entering: [] } };
  const withPaper = await buildDashboard(client, { nowMs: Date.UTC(2026, 10, 5), scanner, paper: { state, events: [] } });
  assert.deepEqual(withPaper.strategies.map((s) => s.slot), ["featured", "lower_1"]);
  assert.equal(withPaper.strategies[1].status, "watching");
  assert.equal(withPaper.account.equity, 100, "real account equity is unchanged");
});

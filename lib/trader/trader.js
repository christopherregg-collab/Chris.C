// Paper trader: runs one strategy against an exchange, one step at a time.
//
// Each call to runOnce():
//   1. reconciles the saved state with the exchange (fills, stops hit, closed positions),
//   2. updates equity and applies the daily loss cap and kill switch,
//   3. on each newly closed candle, uses the SAME signal code as the backtester to trail
//      stops, exit, add to winners, or place new limit entries.
// Call it every few minutes. It is safe to run again after a crash: everything it needs is
// in the saved state plus what the exchange reports.
//
// The trader only manages positions it opened itself. A position it doesn't know about
// is reported and left alone.

import { prepare, regimeByTime, signalAt, sizeQty } from "../backtest/engine.js";
import { createLadder } from "../backtest/ladder.js";
import { barLabel } from "../backtest/blofin-data.js";

const DAY = 86_400_000;

export function initialState(pot) {
  return { version: 1, realized: 0, peak: pot, dayKey: null, dayStart: pot, halted: false, killed: false, ladder: null, coins: {}, leverage: {}, trades: [], missedEntries: 0, warned: {} };
}

const floorTo = (x, step) => Math.floor(x / step + 1e-9) * step;
const roundTo = (x, step) => (step ? Math.round(x / step) * step : x);
const clean = (x) => Number(x.toPrecision(12));
const closeSide = (side) => (side > 0 ? "sell" : "buy");
const openSide = (side) => (side > 0 ? "buy" : "sell");

/**
 * @param {object} o
 * @param {object} o.ex          exchange adapter (see blofin-exchange.js)
 * @param {object} o.strategy    strategy settings (with any overrides applied)
 * @param {object} o.level       risk level
 * @param {object} o.ladderRules LADDER
 * @param {object} o.limits      LIMITS
 * @param {number} o.pot         money assigned to this strategy (USDT)
 * @param {object} o.state       saved state (initialState(pot) on the first run)
 * @param {number} [o.now]
 * @param {function} [o.log]     receives { time, type, ... } events
 * @returns {Promise<object>}    the new state, to save
 */
export async function runOnce(o) {
  const { ex, strategy: s, level, limits, pot } = o;
  const now = o.now ?? Date.now();
  const state = structuredClone(o.state);
  const events = [];
  const log = (type, data = {}) => {
    const e = { time: new Date(now).toISOString(), type, ...data };
    events.push(e);
    o.log?.(e);
  };
  const ladder = createLadder(level, o.ladderRules, state.ladder);
  const dailyCap = s.dailyLossCap !== undefined ? s.dailyLossCap : limits.dailyLossCap;
  await ex.prepareAccount?.((type, data) => log(type, data));
  const specs = await ex.specs(s.symbols);
  const [positions, orders, stops] = await Promise.all([ex.positions(), ex.pendingOrders(), ex.pendingStops()]);
  const posOf = (sym) => positions.find((p) => p.symbol === sym && p.contracts !== 0);
  const coin = (sym) => (state.coins[sym] ??= { status: "flat" });
  const cvOf = (sym) => specs[sym]?.contractValue ?? 1;

  // 1. Reconcile.
  for (const sym of s.symbols) {
    const c = coin(sym);
    const pos = posOf(sym);
    if (c.status === "entering") {
      const order = orders.find((x) => x.orderId === c.orderId);
      if (pos && Math.sign(pos.contracts) === c.side) {
        if (order) await ex.cancelOrder(sym, c.orderId); // cancel any unfilled remainder
        const entry = pos.avgPrice;
        const stopDist = s.stopAtr * c.atr;
        const stop = clean(roundTo(entry - c.side * stopDist, specs[sym]?.tickSize));
        const stopId = await ex.placeStop(sym, closeSide(c.side), stop);
        Object.assign(c, {
          status: "open", entryPrice: entry, stop, stopId, extreme: entry, lastAdd: entry, adds: 0,
          atrEntry: c.atr, openedAt: now, initialRisk: Math.abs(pos.contracts) * cvOf(sym) * stopDist,
        });
        log("filled", { sym, side: c.side > 0 ? "long" : "short", contracts: Math.abs(pos.contracts), price: entry, stop });
        // Take-profit (targetR / targetPct): a reduce-only limit order, so it fills as a maker.
        const targetDist = s.targetPct ? entry * s.targetPct : s.targetR ? stopDist * s.targetR : 0;
        if (targetDist) {
          const target = clean(roundTo(entry + c.side * targetDist, specs[sym]?.tickSize));
          try {
            c.tpId = await ex.placeLimit(sym, closeSide(c.side), target, Math.abs(pos.contracts), { reduceOnly: true });
            c.target = target;
            log("take-profit placed", { sym, target });
          } catch (err) {
            log("take-profit rejected", { sym, target, error: err.message });
          }
        }
      } else if (order) {
        if (now >= c.expiresAt) {
          await ex.cancelOrder(sym, c.orderId);
          state.missedEntries++;
          log("entry expired", { sym, price: c.limitPrice });
          state.coins[sym] = { status: "flat", lastCandle: c.lastCandle };
        }
      } else {
        log("entry gone without a fill", { sym });
        state.coins[sym] = { status: "flat", lastCandle: c.lastCandle };
      }
    } else if (c.status === "open") {
      if (!pos) {
        const pnl = await ex.closedPnl(sym, c.placedAt ?? c.openedAt);
        if (pnl === null) {
          log("waiting for closed P&L", { sym });
          continue;
        }
        if (c.stopId && stops.some((x) => x.stopId === c.stopId)) await ex.cancelStop(sym, c.stopId);
        const tpPending = c.tpId && orders.some((x) => x.orderId === c.tpId);
        if (tpPending) await ex.cancelOrder(sym, c.tpId);
        state.realized += pnl;
        ladder.record(pnl);
        // A profitable close with the take-profit no longer open means the target filled.
        const reason = c.exitReason ?? (c.tpId && !tpPending && pnl > 0 ? "target" : "stop");
        const trade = { sym, side: c.side > 0 ? "long" : "short", openedAt: new Date(c.openedAt).toISOString(), closedAt: new Date(now).toISOString(), entryPrice: c.entryPrice, adds: c.adds, pnl, initialRisk: c.initialRisk, r: c.initialRisk ? pnl / c.initialRisk : null, riskPct: c.riskPct, reason };
        state.trades.push(trade);
        log("closed", trade);
        state.coins[sym] = { status: "flat", lastCandle: c.lastCandle };
      } else if (!stops.some((x) => x.stopId === c.stopId) && !c.exitReason) {
        c.stopId = await ex.placeStop(sym, closeSide(c.side), c.stop);
        log("stop was missing, placed again", { sym, stop: c.stop });
      }
    }
  }
  for (const p of positions) {
    const c = state.coins[p.symbol];
    if (p.contracts !== 0 && (!c || c.status === "flat") && !state.warned[p.symbol]) {
      state.warned[p.symbol] = true;
      log("unmanaged position left alone", { sym: p.symbol, contracts: p.contracts });
    }
  }

  // 2. Equity, daily loss cap, kill switch.
  const managed = (sym) => state.coins[sym]?.status === "open" ? posOf(sym) : undefined;
  const equity = pot + state.realized + s.symbols.reduce((a, sym) => a + (managed(sym)?.unrealizedPnl ?? 0), 0);
  state.peak = Math.max(state.peak, equity);
  const dk = Math.floor(now / DAY);
  if (dk !== state.dayKey) {
    state.dayKey = dk;
    state.dayStart = equity;
    state.halted = false;
  }
  async function flattenAll(reason) {
    for (const sym of s.symbols) {
      const c = state.coins[sym];
      if (c?.status === "entering") {
        await ex.cancelOrder(sym, c.orderId);
        state.coins[sym] = { status: "flat", lastCandle: c.lastCandle };
      } else if (c?.status === "open" && !c.exitReason) {
        const pos = posOf(sym);
        if (c.stopId) await ex.cancelStop(sym, c.stopId);
        if (c.tpId && orders.some((x) => x.orderId === c.tpId)) await ex.cancelOrder(sym, c.tpId);
        if (pos) await ex.placeMarket(sym, closeSide(c.side), Math.abs(pos.contracts), true);
        c.exitReason = reason;
      }
    }
  }
  if (!state.killed && limits.killSwitch !== null && equity <= state.peak * (1 - limits.killSwitch)) {
    state.killed = true;
    log("KILL SWITCH: flattening and stopping", { equity, peak: state.peak });
    await flattenAll("kill switch");
  } else if (!state.halted && dailyCap !== null && equity <= state.dayStart * (1 - dailyCap)) {
    state.halted = true;
    log("daily loss cap: flattening until tomorrow (UTC)", { equity, dayStart: state.dayStart });
    await flattenAll("daily loss cap");
  }

  // 3. Act on newly closed candles.
  const lookback = Math.max(120 * DAY, ((s.trendEma ?? 0) * 2 + 30) * s.barMs, 400 * s.barMs);
  const notional = (prices) => s.symbols.reduce((a, sym) => {
    const p = managed(sym);
    return a + (p ? Math.abs(p.contracts) * cvOf(sym) * (prices[sym] ?? p.avgPrice) : 0);
  }, 0);
  const lastClose = {};
  // Market regime for shortRegime (e.g. BTC daily vs EMA 50). If it can't be loaded, no new
  // shorts are opened this run (the signal needs the regime to say "downtrend").
  let regime = null;
  if (s.shortRegime) {
    try {
      const need = Math.max(lookback, (s.shortRegime.ema + 30) * s.shortRegime.ms);
      regime = regimeByTime(await ex.candles(s.shortRegime.symbol, barLabel(s.barMs), now - need), s);
    } catch (err) {
      log("market regime unavailable: no new shorts this run", { error: err.message });
    }
  }
  for (const sym of s.symbols) {
    const c = coin(sym);
    const candles = await ex.candles(sym, barLabel(s.barMs), now - lookback);
    if (candles.length < 60) { log("not enough candles yet", { sym, candles: candles.length }); continue; }
    const i = candles.length - 1;
    const bar = candles[i];
    lastClose[sym] = bar.close;
    if (c.lastCandle === bar.time) continue;
    const p = prepare(candles, s, regime);
    const a = p.atr14[i];
    const spec = specs[sym];
    if (!spec || a === null) continue;

    if (c.status === "open" && !c.exitReason && posOf(sym)) {
      const pos = posOf(sym);
      if (bar.time + s.barMs > c.openedAt) c.extreme = c.side > 0 ? Math.max(c.extreme, bar.high) : Math.min(c.extreme, bar.low);
      let newStop = c.extreme - c.side * s.trailAtr * a;
      const exitLine = c.side > 0 ? p.exit.lower[i] : p.exit.upper[i];
      const lostTrend = (s.exitEma && p.ema?.[i] != null && c.side * (bar.close - p.ema[i]) < 0) ||
        (s.signal === "momentum" && i >= s.lookback && c.side * (bar.close - candles[i - s.lookback].close) < 0);
      if ((exitLine !== null && c.side * (bar.close - exitLine) < 0) || lostTrend) {
        if (c.stopId) await ex.cancelStop(sym, c.stopId);
        if (c.tpId && orders.some((x) => x.orderId === c.tpId)) await ex.cancelOrder(sym, c.tpId);
        await ex.placeMarket(sym, closeSide(c.side), Math.abs(pos.contracts), true);
        c.exitReason = lostTrend ? "trend lost" : "exit channel";
        log("exit", { sym, reason: c.exitReason, close: bar.close });
      } else {
        if (s.pyramid && c.adds < s.pyramid.maxAdds && c.side * (bar.close - c.lastAdd) >= s.pyramid.everyAtr * c.atrEntry && !state.halted && !state.killed) {
          const room = Math.max(0, level.leverageCap * equity - notional(lastClose)) / (bar.close * spec.contractValue);
          const contracts = clean(floorTo(Math.min(c.unitContracts, room), spec.lotSize));
          if (contracts >= spec.minSize) {
            await ex.placeMarket(sym, openSide(c.side), contracts, false);
            c.adds++;
            c.lastAdd = bar.close;
            newStop = c.side > 0 ? Math.max(newStop, bar.close - s.stopAtr * c.atrEntry) : Math.min(newStop, bar.close + s.stopAtr * c.atrEntry);
            log("added to winner", { sym, contracts, price: bar.close, adds: c.adds });
          }
        }
        newStop = clean(roundTo(newStop, spec.tickSize));
        if (c.side * (newStop - c.stop) > (spec.tickSize ?? 0)) {
          const old = c.stop;
          if (c.stopId) await ex.cancelStop(sym, c.stopId);
          c.stopId = await ex.placeStop(sym, closeSide(c.side), newStop);
          c.stop = newStop;
          log("stop raised", { sym, from: old, to: newStop });
        }
      }
    } else if (c.status === "flat" && !state.halted && !state.killed) {
      const busy = s.symbols.filter((x) => state.coins[x]?.status && state.coins[x].status !== "flat").length;
      const side = signalAt(p, s, i);
      // Another bot (or you) already has a position or order on this coin: don't merge into it.
      const foreign = posOf(sym) || orders.some((x) => x.symbol === sym);
      if (side && foreign) {
        log("signal skipped: coin already has a position or order this bot didn't place", { sym });
      } else if (side && busy < (s.maxOpenPositions ?? limits.maxOpenPositions)) {
        const risk = ladder.current(equity, state.peak);
        const stopDist = s.stopAtr * a;
        const price = clean(side > 0 ? floorTo(bar.close, spec.tickSize ?? 1e-12) : roundTo(bar.close, spec.tickSize));
        const room = Math.max(0, level.leverageCap * equity - notional(lastClose)) / price;
        const qty = Math.min(sizeQty(s, { equity, riskPct: risk, price, stopDist, vol: p.vol?.[i] }), room);
        const contracts = clean(floorTo(qty / spec.contractValue, spec.lotSize));
        if (contracts < spec.minSize) {
          log("signal skipped: below minimum order size", { sym, wanted: qty, minQty: spec.minSize * spec.contractValue });
        } else {
          if (state.leverage[sym] !== level.leverageCap) {
            await ex.setLeverage(sym, level.leverageCap);
            state.leverage[sym] = level.leverageCap;
          }
          const market = s.entry?.type !== "limit";
          try {
            const orderId = market ? await ex.placeMarket(sym, openSide(side), contracts, false) : await ex.placeLimit(sym, openSide(side), price, contracts);
            state.coins[sym] = {
              status: "entering", side, orderId, placedAt: now, limitPrice: price, atr: a, riskPct: risk, unitContracts: contracts,
              expiresAt: bar.time + s.barMs * (1 + (s.entry?.waitBars ?? 1)),
            };
            log("entry order", { sym, side: side > 0 ? "long" : "short", type: market ? "market" : "limit", price, contracts, risk, stopDistance: stopDist });
          } catch (err) {
            // A rejected entry (e.g. not enough margin) skips this signal; other coins carry on.
            log("entry order rejected", { sym, price, contracts, error: err.message });
          }
        }
      }
    }
    coin(sym).lastCandle = bar.time;
  }

  // What the dashboard shows: open positions with their current stop.
  state.view = {
    positions: s.symbols.flatMap((sym) => {
      const c = state.coins[sym];
      const p = posOf(sym);
      if (c?.status !== "open" || !p) return [];
      const size = Math.abs(p.contracts) * cvOf(sym);
      const mark = p.markPrice ?? lastClose[sym] ?? (p.avgPrice + p.unrealizedPnl / (c.side * size || 1));
      return [{ symbol: sym, side: c.side > 0 ? "long" : "short", size, entryPrice: p.avgPrice, markPrice: mark, stopPrice: c.stop, ...(c.target ? { targetPrice: c.target } : {}), unrealizedPnl: p.unrealizedPnl, openedAt: new Date(c.openedAt).toISOString(), adds: c.adds }];
    }),
    entering: s.symbols.filter((sym) => state.coins[sym]?.status === "entering").map((sym) => ({ symbol: sym, price: state.coins[sym].limitPrice })),
  };
  state.ladder = ladder.state();
  state.equity = equity;
  state.updatedAt = new Date(now).toISOString();
  return { state, events };
}

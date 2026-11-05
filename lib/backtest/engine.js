// Bar-by-bar simulation of one momentum strategy on one pot of money.
//
// Timing rules (no lookahead):
// - Signals are read on a bar's CLOSE and filled at the NEXT bar's OPEN, plus slippage.
// - Stops are checked against each bar's high/low. A gap through the stop fills at the
//   open, not at the stop price.
// - Higher-timeframe trends use only higher-timeframe bars that had already closed.

import { atr, adx, donchian, trailingMean, htfTrend } from "./ta.js";
import { createLadder } from "./ladder.js";

const DAY = 86_400_000;

function prepare(candles, s) {
  const atr14 = atr(candles, 14);
  const adx14 = adx(candles, 14);
  const entry = donchian(candles, s.breakout);
  const exit = donchian(candles, s.exitChannel);
  const volMean = trailingMean(candles.map((c) => c.volume), 20);
  const trends = s.trendFilters.map((f) => htfTrend(candles, s.barMs, f.ms, f.ema));
  return { candles, atr14, adx14, entry, exit, volMean, trends };
}

/** +1 long, -1 short, 0 nothing, on the close of bar i. */
export function signalAt(p, s, i) {
  const c = p.candles[i];
  if (p.atr14[i] === null || p.adx14[i] === null || p.entry.upper[i] === null || p.volMean[i] === null) return 0;
  if (p.adx14[i] < s.adxMin) return 0;
  if (!(c.volume > p.volMean[i] * s.volumeMult)) return 0;
  const longOk = p.trends.every((t) => t[i] === 1);
  const shortOk = p.trends.every((t) => t[i] === -1);
  if (longOk && c.close > p.entry.upper[i]) return 1;
  if (shortOk && c.close < p.entry.lower[i]) return -1;
  return 0;
}

const floorTo = (x, step) => Math.floor(x / step + 1e-9) * step;

/**
 * @param {object} o
 * @param {object} o.strategy   one of STRATEGIES
 * @param {object} o.level      one of LEVELS
 * @param {object} o.ladder     LADDER rules
 * @param {object} o.limits     LIMITS
 * @param {object} o.costs      COSTS
 * @param {object} o.specs      { symbol: { qtyStep, minQty } }
 * @param {object} o.data       { symbol: candles[] } (bar open time in ms, oldest first)
 * @param {object} [o.funding]  { symbol: Map(fundingTimeMs -> rate) }
 * @param {number} o.startEquity
 * @param {number} [o.from]     first bar time to trade (earlier bars only warm up indicators)
 * @param {number} [o.to]       stop trading at this time (exclusive)
 */
export function runBacktest(o) {
  const { strategy: s, level, limits, costs, specs } = o;
  const symbols = s.symbols.filter((sym) => o.data[sym]?.length);
  if (!symbols.length) throw new Error(`no candles for ${s.symbols.join(", ")}`);
  const prep = Object.fromEntries(symbols.map((sym) => [sym, prepare(o.data[sym], s)]));
  const index = Object.fromEntries(symbols.map((sym) => [sym, new Map(o.data[sym].map((c, i) => [c.time, i]))]));
  const from = o.from ?? -Infinity;
  const to = o.to ?? Infinity;
  // Every bar time of any symbol: a coin that lists later simply joins when its data starts.
  const times = [...new Set(symbols.flatMap((sym) => [...index[sym].keys()]))]
    .filter((t) => t >= from && t < to)
    .sort((a, b) => a - b);

  const ladder = createLadder(level, o.ladder);
  let cash = o.startEquity;
  let peak = cash;
  const positions = new Map();
  const pending = new Map();
  const trades = [];
  const equityCurve = [];
  const events = [];
  let fees = 0, funding = 0, skippedMinSize = 0, liquidations = 0, missedLimits = 0;
  let lastPrice = {};
  let dayKey = null, dayStart = cash, halted = false, killed = false;

  const unrealized = (pos, price) => pos.units.reduce((u, x) => u + pos.side * x.qty * (price - x.price), 0);
  const qtyOf = (pos) => pos.units.reduce((q, x) => q + x.qty, 0);
  const equityAt = (prices) => {
    let e = cash;
    for (const [sym, pos] of positions) e += unrealized(pos, prices[sym]);
    return e;
  };
  const notionalAt = (prices, except) => {
    let n = 0;
    for (const [sym, pos] of positions) if (sym !== except) n += qtyOf(pos) * prices[sym];
    return n;
  };

  function close(sym, rawPrice, time, reason) {
    const pos = positions.get(sym);
    const fill = rawPrice * (1 - pos.side * costs.slippage);
    const qty = qtyOf(pos);
    const fee = qty * fill * costs.takerFee;
    const gross = unrealized(pos, fill);
    cash += gross - fee;
    fees += fee;
    pos.fees += fee;
    const pnl = gross - pos.fees - pos.funding;
    const avg = pos.units.reduce((a, x) => a + x.qty * x.price, 0) / qty;
    trades.push({
      symbol: sym, side: pos.side > 0 ? "long" : "short", openTime: pos.openTime, closeTime: time,
      entryPrice: avg, exitPrice: fill, qty, adds: pos.units.length - 1, pnl,
      r: pnl / pos.initialRisk, riskPct: pos.riskPct, reason,
    });
    positions.delete(sym);
    ladder.record(pnl);
  }

  // maker = a resting limit order: maker fee and no slippage.
  function open(sym, side, rawPrice, a, time, prices, maker = false) {
    const equity = equityAt(prices);
    const fill = maker ? rawPrice : rawPrice * (1 + side * costs.slippage);
    const stopDist = s.stopAtr * a;
    const riskPct = ladder.current(equity, peak);
    let qty = (equity * riskPct) / stopDist;
    qty = Math.min(qty, Math.max(0, level.leverageCap * equity - notionalAt(prices)) / fill);
    const spec = specs[sym];
    qty = floorTo(qty, spec.qtyStep);
    if (qty < spec.minQty || equity <= 0) { skippedMinSize++; return; }
    const fee = qty * fill * (maker ? costs.makerFee : costs.takerFee);
    cash -= fee;
    fees += fee;
    positions.set(sym, {
      side, units: [{ qty, price: fill }], stop: fill - side * stopDist, atrEntry: a, lastAdd: fill,
      extreme: fill, initialRisk: qty * stopDist, riskPct, fees: fee, funding: 0, openTime: time,
    });
  }

  function add(sym, rawPrice, prices) {
    const pos = positions.get(sym);
    const equity = equityAt(prices);
    const fill = rawPrice * (1 + pos.side * costs.slippage);
    let qty = Math.min(pos.units[0].qty, Math.max(0, level.leverageCap * equity - notionalAt(prices)) / fill);
    qty = floorTo(qty, specs[sym].qtyStep);
    if (qty < specs[sym].minQty) return;
    const fee = qty * fill * costs.takerFee;
    cash -= fee;
    fees += fee;
    pos.fees += fee;
    pos.units.push({ qty, price: fill });
    pos.lastAdd = fill;
    const stop = fill - pos.side * s.stopAtr * pos.atrEntry;
    pos.stop = pos.side > 0 ? Math.max(pos.stop, stop) : Math.min(pos.stop, stop);
  }

  for (const t of times) {
    const active = symbols.filter((sym) => index[sym].has(t));
    const bars = Object.fromEntries(active.map((sym) => [sym, prep[sym].candles[index[sym].get(t)]]));
    const opens = { ...lastPrice, ...Object.fromEntries(active.map((sym) => [sym, bars[sym].open])) };

    // New UTC day: reset the daily loss cap.
    const dk = Math.floor(t / DAY);
    if (dk !== dayKey) {
      if (dayKey !== null) dayStart = equityAt(opens);
      dayKey = dk;
      halted = false;
    }

    // 1. Orders queued on the previous close fill at this open. A limit entry fills only
    //    if the bar trades back to its price, and is cancelled after `waitBars` bars.
    for (const sym of active) {
      const order = pending.get(sym);
      if (!order) continue;
      pending.delete(sym);
      if (order.type === "exit" && positions.has(sym)) close(sym, bars[sym].open, t, order.reason);
      else if (order.type === "entry" && !positions.has(sym) && !halted && !killed) {
        const b = bars[sym];
        if (order.limit === undefined) open(sym, order.side, b.open, order.atr, t, opens);
        else if (order.side > 0 ? b.low <= order.limit : b.high >= order.limit) {
          const price = order.side > 0 ? Math.min(b.open, order.limit) : Math.max(b.open, order.limit);
          open(sym, order.side, price, order.atr, t, opens, true);
        } else if (order.barsLeft > 1) pending.set(sym, { ...order, barsLeft: order.barsLeft - 1 });
        else missedLimits++;
      }
      else if (order.type === "add" && positions.has(sym) && !halted && !killed) add(sym, bars[sym].open, opens);
    }

    // 2. Funding.
    for (const sym of active) {
      const pos = positions.get(sym);
      if (!pos || t % costs.fundingEveryMs !== 0) continue;
      const rate = o.funding?.[sym]?.get(t) ?? costs.defaultFundingRate;
      const cost = pos.side * qtyOf(pos) * bars[sym].open * rate;
      cash -= cost;
      funding += cost;
      pos.funding += cost;
    }

    // 3. Liquidation, checked before stops: each position's worst price this bar is its
    //    low/high, or where its stop would have closed it. If the pot's equity at those
    //    prices falls to the maintenance margin, the exchange liquidates everything and
    //    the remaining margin is lost.
    if (positions.size) {
      const worst = { ...opens };
      for (const sym of active) {
        const pos = positions.get(sym);
        const b = bars[sym];
        if (!pos) continue;
        if (pos.side > 0) worst[sym] = b.low <= pos.stop ? Math.min(b.open, pos.stop) : b.low;
        else worst[sym] = b.high >= pos.stop ? Math.max(b.open, pos.stop) : b.high;
      }
      const mm = [...positions].reduce((m, [sym, pos]) => m + qtyOf(pos) * worst[sym] * costs.maintenanceMargin, 0);
      if (equityAt(worst) <= mm) {
        liquidations++;
        events.push({ time: t, type: "liquidation" });
        for (const sym of [...positions.keys()]) close(sym, worst[sym], t, "liquidation");
        trades[trades.length - 1].pnl -= cash; // whatever margin was left goes too
        cash = 0;
        pending.clear();
      }
    }

    // Stops. A gap through the stop fills at the open.
    for (const sym of active) {
      const pos = positions.get(sym);
      if (!pos) continue;
      const bar = bars[sym];
      if (pos.side > 0 && bar.low <= pos.stop) close(sym, Math.min(bar.open, pos.stop), t, "stop");
      else if (pos.side < 0 && bar.high >= pos.stop) close(sym, Math.max(bar.open, pos.stop), t, "stop");
    }

    // 4. On the close: trail stops, exits, adds, new entries.
    const closes = { ...lastPrice, ...Object.fromEntries(active.map((sym) => [sym, bars[sym].close])) };
    lastPrice = closes;
    for (const sym of active) {
      const p = prep[sym];
      const i = index[sym].get(t);
      const bar = bars[sym];
      const pos = positions.get(sym);
      if (pos) {
        pos.extreme = pos.side > 0 ? Math.max(pos.extreme, bar.high) : Math.min(pos.extreme, bar.low);
        if (p.atr14[i] !== null) {
          const trail = pos.extreme - pos.side * s.trailAtr * p.atr14[i];
          pos.stop = pos.side > 0 ? Math.max(pos.stop, trail) : Math.min(pos.stop, trail);
        }
        const exitLine = pos.side > 0 ? p.exit.lower[i] : p.exit.upper[i];
        if (exitLine !== null && (pos.side > 0 ? bar.close < exitLine : bar.close > exitLine)) {
          pending.set(sym, { type: "exit", reason: "exit channel" });
        } else if (s.pyramid && pos.units.length - 1 < s.pyramid.maxAdds &&
          pos.side * (bar.close - pos.lastAdd) >= s.pyramid.everyAtr * pos.atrEntry) {
          pending.set(sym, { type: "add" });
        }
      } else if (!pending.has(sym) && !halted && !killed) {
        const queued = [...pending.values()].filter((x) => x.type === "entry").length;
        if (positions.size + queued < limits.maxOpenPositions) {
          const side = signalAt(p, s, i);
          if (side) {
            const order = { type: "entry", side, atr: p.atr14[i] };
            if (s.entry?.type === "limit") {
              order.limit = bar.close - side * (s.entry.offsetAtr ?? 0) * p.atr14[i];
              order.barsLeft = s.entry.waitBars ?? 1;
            }
            pending.set(sym, order);
          }
        }
      }
    }

    // 5. Mark to market, daily loss cap, kill switch.
    const equity = equityAt(closes);
    peak = Math.max(peak, equity);
    equityCurve.push({ time: t + s.barMs, equity });
    const flatten = (reason) => {
      pending.clear();
      for (const sym of positions.keys()) pending.set(sym, { type: "exit", reason });
    };
    if (!killed && limits.killSwitch !== null && equity <= peak * (1 - limits.killSwitch)) {
      killed = true;
      events.push({ time: t, type: "kill switch", equity });
      flatten("kill switch");
    } else if (!halted && equity <= dayStart * (1 - limits.dailyLossCap)) {
      halted = true;
      events.push({ time: t, type: "daily loss cap", equity });
      flatten("daily loss cap");
    }
  }

  // Close anything still open at the last close so the result is all realized.
  const last = times[times.length - 1];
  if (last !== undefined) {
    for (const sym of [...positions.keys()]) close(sym, lastPrice[sym], last + s.barMs, "end of test");
    if (equityCurve.length) equityCurve[equityCurve.length - 1].equity = cash;
  }

  return {
    strategy: s.label, level: level.label, startEquity: o.startEquity, endEquity: cash,
    start: times[0], end: last === undefined ? undefined : last + s.barMs,
    trades, equityCurve, events, fees, funding, skippedMinSize, missedLimits, liquidations, killed,
  };
}

// The smoke test's steps, against any exchange adapter (see scripts/smoke-test.js).
// Returns { failed }. Always tries to leave the coin flat with no orders.

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runSmokeTest(ex, sym, { log = console.log, sleep = defaultSleep, now = Date.now } = {}) {
  let failed = 0;
  async function step(name, fn) {
    try {
      const detail = await fn();
      log(`PASS  ${name}${detail ? `: ${detail}` : ""}`);
      return true;
    } catch (err) {
      failed++;
      log(`FAIL  ${name}: ${err.message}`);
      return false;
    }
  }
  const check = (ok, msg) => { if (!ok) throw new Error(msg); };
  async function waitFor(fn, tries = 10) {
    for (let k = 0; k < tries; k++) {
      const v = await fn();
      if (v) return v;
      await sleep(1000);
    }
    return null;
  }

  const started = now();
  let spec;
  let price;
  let minContracts;

  const ready = await step("account uses isolated margin and net positions", async () => {
    await ex.prepareAccount((type, d) => log(`      ${type} ${JSON.stringify(d)}`));
    const [positions, orders] = await Promise.all([ex.positions(), ex.pendingOrders()]);
    check(!positions.some((p) => p.symbol === sym), `${sym} already has a position; pick another coin with --symbol`);
    check(!orders.some((o) => o.symbol === sym), `${sym} already has open orders; pick another coin with --symbol`);
    spec = (await ex.specs([sym]))[sym];
    check(spec, `no order rules for ${sym}`);
    const candles = await ex.candles(sym, "1H", now() - 6 * 3_600_000);
    price = candles.at(-1).close;
    minContracts = spec.minSize;
    return `price ${price}, minimum ${minContracts} contracts = ${(minContracts * spec.contractValue).toPrecision(3)} ${sym.split("-")[0]} (about $${(minContracts * spec.contractValue * price).toFixed(2)})`;
  });
  if (!ready) return { failed };

  const tick = spec.tickSize ?? 0.01;
  const roundTick = (x) => Number((Math.round(x / tick) * tick).toPrecision(12));

  await step("set leverage 3× (isolated)", async () => { await ex.setLeverage(sym, 3); });

  await step("limit buy far below the market, then cancel it", async () => {
    const id = await ex.placeLimit(sym, "buy", roundTick(price * 0.8), minContracts);
    check(id && id !== "undefined", "no order id returned");
    const seen = await waitFor(async () => (await ex.pendingOrders()).find((o) => o.orderId === id));
    check(seen, "order didn't appear in open orders");
    await ex.cancelOrder(sym, id);
    const gone = await waitFor(async () => !(await ex.pendingOrders()).some((o) => o.orderId === id));
    check(gone, "order still open after cancel");
    return `order ${id}`;
  });

  let opened = false;
  await step("market buy at the minimum size", async () => {
    await ex.placeMarket(sym, "buy", minContracts, false);
    const pos = await waitFor(async () => (await ex.positions()).find((p) => p.symbol === sym));
    check(pos, "no position appeared");
    opened = true;
    return `${pos.contracts} contracts at ${pos.avgPrice}`;
  });

  let stopId;
  if (opened) {
    await step("stop-loss for the whole position (size -1)", async () => {
      stopId = await ex.placeStop(sym, "sell", roundTick(price * 0.9));
      check(stopId && stopId !== "undefined", "no stop id returned");
      const seen = await waitFor(async () => (await ex.pendingStops()).find((s) => s.stopId === stopId));
      check(seen, "stop didn't appear in pending TP/SL orders");
      return `stop ${stopId} at ${seen.triggerPrice}`;
    });

    await step("move the stop up (cancel + place)", async () => {
      if (stopId) await ex.cancelStop(sym, stopId);
      const gone = await waitFor(async () => !(await ex.pendingStops()).some((s) => s.stopId === stopId));
      check(gone, "old stop still there after cancel");
      stopId = await ex.placeStop(sym, "sell", roundTick(price * 0.95));
      const seen = await waitFor(async () => (await ex.pendingStops()).find((s) => s.stopId === stopId));
      check(seen, "new stop didn't appear");
      return `new stop at ${seen.triggerPrice}`;
    });

    await step("take-profit limit order (reduce-only), then cancel it", async () => {
      const id = await ex.placeLimit(sym, "sell", roundTick(price * 1.2), minContracts, { reduceOnly: true });
      check(id && id !== "undefined", "no order id returned");
      const seen = await waitFor(async () => (await ex.pendingOrders()).find((o) => o.orderId === id));
      check(seen, "take-profit order didn't appear in open orders");
      await ex.cancelOrder(sym, id);
      const gone = await waitFor(async () => !(await ex.pendingOrders()).some((o) => o.orderId === id));
      check(gone, "take-profit order still open after cancel");
      return `order ${id} at ${seen.price}`;
    });

    await step("close the position (market, reduce-only)", async () => {
      const pos = (await ex.positions()).find((p) => p.symbol === sym);
      check(pos, "position missing before close");
      await ex.placeMarket(sym, "sell", Math.abs(pos.contracts), true);
      const gone = await waitFor(async () => !(await ex.positions()).some((p) => p.symbol === sym));
      check(gone, "position still open after close");
    });

    await step("no stop left behind", async () => {
      const left = (await ex.pendingStops()).filter((s) => s.symbol === sym);
      for (const s of left) await ex.cancelStop(sym, s.stopId);
      return left.length ? `cancelled ${left.length} leftover stop(s) (BloFin didn't remove it with the position)` : "BloFin removed it with the position";
    });

    await step("realized P&L is reported", async () => {
      const pnl = await waitFor(async () => ex.closedPnl(sym, started), 15);
      check(pnl !== null, "no closed position found in position history");
      return `${pnl.toFixed(4)} USDT (fees and spread)`;
    });
  }

  // Clean up whatever a failed step may have left behind.
  if (failed) {
    try {
      for (const o of (await ex.pendingOrders()).filter((x) => x.symbol === sym)) await ex.cancelOrder(sym, o.orderId);
      for (const s of (await ex.pendingStops()).filter((x) => x.symbol === sym)) await ex.cancelStop(sym, s.stopId);
      const pos = (await ex.positions()).find((p) => p.symbol === sym);
      if (pos && opened) {
        await ex.placeMarket(sym, pos.contracts > 0 ? "sell" : "buy", Math.abs(pos.contracts), true);
        log(`      cleanup: closed the test position on ${sym}`);
      }
    } catch (err) {
      log(`      cleanup failed: ${err.message}. Check ${sym} on BloFin and close it by hand.`);
    }
  }
  return { failed };
}

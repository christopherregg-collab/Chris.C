#!/usr/bin/env node
// Momentum backtest: Core Momentum and Big Swing at three aggression levels.
//
//   npm run backtest:fetch                 download BloFin data (run on the server; ~2 years)
//   npm run backtest                       backtest on the downloaded data
//   npm run backtest -- --synthetic        backtest on simulated data (engine check only)
//
// Options: --core 240 --swing 60 (starting money), --split 0.7 (in-sample share),
//          --no-kill (disable the kill switch), --dir data/blofin, --out data/backtest

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COSTS, DEFAULT_ALLOCATION, DEFAULT_SPECS, LADDER, LEVELS, LIMITS, STRATEGIES } from "../lib/backtest/config.js";
import { runBacktest } from "../lib/backtest/engine.js";
import { monteCarlo, summarize } from "../lib/backtest/stats.js";
import { syntheticMarket } from "../lib/backtest/synthetic.js";
import { barLabel, loadBlofin } from "../lib/backtest/blofin-data.js";
import { resample } from "../lib/backtest/ta.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else { out[a.slice(2)] = next; i++; }
  }
  return out;
}

const opt = parseArgs(process.argv.slice(2));
const symbols = [...new Set(Object.values(STRATEGIES).flatMap((s) => s.symbols))];
const barLengths = [...new Set(Object.values(STRATEGIES).map((s) => s.barMs))];
if (barLengths.length !== 1) throw new Error("all strategies must use the same candle length");
const barMs = barLengths[0];
const allocation = { core: Number(opt.core ?? DEFAULT_ALLOCATION.core), swing: Number(opt.swing ?? DEFAULT_ALLOCATION.swing) };
const split = Number(opt.split ?? 0.7);
const limits = { ...LIMITS, killSwitch: opt["no-kill"] ? null : LIMITS.killSwitch };
const outDir = opt.out ?? "data/backtest";

let source;
let data;
let funding = {};
let specs = {};
if (opt.synthetic) {
  source = "SIMULATED data (engine check only, not a profit estimate)";
  const hourly = syntheticMarket({ symbols: symbols.slice(0, 2) });
  data = Object.fromEntries(Object.entries(hourly).map(([sym, c]) =>
    [sym, resample(c, barMs, HOUR).filter((b) => b.complete).map(({ end, complete, ...b }) => b)]));
} else {
  ({ data, funding, specs } = loadBlofin(opt.dir ?? "data/blofin", symbols, barMs));
  source = `BloFin ${barLabel(barMs)} candles`;
}
const traded = symbols.filter((sym) => data[sym]?.length);
specs = { ...DEFAULT_SPECS, ...specs };

// Coins with shorter histories join the test when their data starts.
const first = Math.min(...traded.map((s) => data[s][0].time));
const last = Math.max(...traded.map((s) => data[s][data[s].length - 1].time));
// The daily-trend filter needs ~50 days of history before it can say anything; skip that warm-up.
const from = first + 55 * DAY;
if (from >= last) throw new Error("not enough data: need more than 55 days of candles");
const cut = from + Math.floor(((last - from) * split) / HOUR) * HOUR;

const pct = (x, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : "∞");
const num = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "∞");
const money = (x) => `$${x.toFixed(2)}`;
const day = (t) => new Date(t).toISOString().slice(0, 10);

function run(key, levelKey, range, lim = limits) {
  return runBacktest({
    strategy: STRATEGIES[key], level: LEVELS[levelKey], ladder: LADDER, limits: lim, costs: COSTS, specs,
    data, funding, startEquity: allocation[key], ...range,
  });
}

const rows = [];
for (const key of Object.keys(STRATEGIES)) {
  for (const levelKey of Object.keys(LEVELS)) {
    const full = run(key, levelKey, { from });
    const m = summarize(full);
    // The kill switch ends trading early, which would leave the Monte Carlo too few trades
    // to sample. It samples from a run without the kill switch instead.
    const raw = limits.killSwitch === null ? full : run(key, levelKey, { from }, { ...limits, killSwitch: null });
    const mc = monteCarlo(raw.trades, LEVELS[levelKey], LADDER, { tradesPerYear: summarize(raw).tradesPerYear });
    const noKill = { ...limits, killSwitch: null };
    const ins = summarize(run(key, levelKey, { from, to: cut }, noKill));
    const oos = summarize(run(key, levelKey, { from: cut }, noKill));
    rows.push({ key, levelKey, strategy: STRATEGIES[key].label, level: LEVELS[levelKey].label, m, mc, ins, oos, events: full.events, trades: full.trades });
  }
}

// Buy and hold each symbol over the same period, for comparison.
const hold = traded.map((sym) => {
  const c = data[sym].filter((x) => x.time >= from);
  return { symbol: sym, since: c[0].time, ret: c[c.length - 1].close / c[0].open - 1 };
});

const lines = [];
const p = (s = "") => lines.push(s);
p(`# Momentum backtest`);
p();
p(`- Data: ${source}, ${traded.map((sym) => `${sym} from ${day(data[sym][0].time)}`).join(", ")}`);
p(`- Period: ${day(from)} to ${day(last)} (in-sample to ${day(cut)}, out-of-sample after)`);
p(`- Starting money: Core Momentum ${money(allocation.core)}, Big Swing ${money(allocation.swing)}`);
p(`- Entries: ${Object.values(STRATEGIES).map((s) => `${s.label} ${s.entry?.type === "limit" ? `limit orders (wait ${s.entry.waitBars ?? 1} candle)` : "market orders"}`).join(", ")}`);
p(`- Costs: maker fee ${pct(COSTS.makerFee, 2)} on limit fills, taker fee ${pct(COSTS.takerFee, 2)} + slippage ${pct(COSTS.slippage, 2)} on market fills, funding ${Object.keys(funding).length ? "from BloFin history" : `assumed ${pct(COSTS.defaultFundingRate, 2)} per 8h`}`);
p(`- Limits: daily loss cap ${pct(limits.dailyLossCap, 0)}, kill switch ${limits.killSwitch === null ? "off" : pct(limits.killSwitch, 0) + " from peak"}, max ${limits.maxOpenPositions} positions`);
p(`- Buy and hold (from the test start, or listing): ${hold.map((h) => `${h.symbol} ${pct(h.ret)}`).join(", ")}`);
p();
p(`## Results`);
p();
p(`| Strategy | Level | End money | Return | CAGR | Max DD | Best day | Worst day | Trades | Win rate | Profit factor | Avg win R | Best trade R | Fees | Kill switch |`);
p(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
for (const r of rows) {
  const m = r.m;
  p(`| ${r.strategy} | ${r.level} | ${money(m.endEquity)} | ${pct(m.totalReturn)} | ${pct(m.cagr)} | ${pct(m.maxDrawdown)} | ${pct(m.bestDay)} | ${pct(m.worstDay)} | ${m.trades} | ${pct(m.winRate, 0)} | ${num(m.profitFactor)} | ${num(m.avgWinR, 1)} | ${num(m.bestTradeR, 1)} | ${money(m.fees)} | ${m.killSwitchHit ? "HIT" : "no"} |`);
}
p();
p(`## Risk of ruin`);
p();
p(`Monte Carlo: 5,000 simulated years made by shuffling these trades, with the risk ladder replayed and the kill switch ignored.`);
p();
p(`| Strategy | Level | Trades/yr | Median year | Bad year (5th pct) | Great year (95th pct) | 95th pct drawdown | P(DD ≥ 25%) | P(DD ≥ 50%) | P(DD ≥ 90%) | P(losing year) |`);
p(`|---|---|---|---|---|---|---|---|---|---|---|`);
for (const r of rows) {
  const mc = r.mc;
  if (!mc) { p(`| ${r.strategy} | ${r.level} | 0 | no trades | | | | | | | |`); continue; }
  p(`| ${r.strategy} | ${r.level} | ${mc.tradesPerYear} | ${pct(mc.medianReturn)} | ${pct(mc.p5Return)} | ${pct(mc.p95Return)} | ${pct(mc.drawdown95)} | ${pct(mc.probDrawdown25, 0)} | ${pct(mc.probDrawdown50, 0)} | ${pct(mc.probDrawdown90, 0)} | ${pct(mc.probLoss, 0)} |`);
}
p();
p(`## Overfitting check: in-sample vs out-of-sample`);
p();
p(`Kill switch off here, so both halves trade the whole period. If out-of-sample is much worse than in-sample, the edge probably isn't real.`);
p();
p(`| Strategy | Level | In-sample return | In-sample PF | Out-of-sample return | Out-of-sample PF | OOS trades |`);
p(`|---|---|---|---|---|---|---|`);
for (const r of rows) p(`| ${r.strategy} | ${r.level} | ${pct(r.ins.totalReturn)} | ${num(r.ins.profitFactor)} | ${pct(r.oos.totalReturn)} | ${num(r.oos.profitFactor)} | ${r.oos.trades} |`);
p();
p(`## By coin (Conservative level, full period)`);
p();
p(`| Strategy | Coin | Trades | Win rate | Net P&L | Avg R |`);
p(`|---|---|---|---|---|---|`);
for (const r of rows.filter((x) => x.levelKey === "conservative")) {
  for (const sym of traded) {
    const ts = r.trades.filter((t) => t.symbol === sym);
    if (!ts.length) { p(`| ${r.strategy} | ${sym} | 0 | | | |`); continue; }
    const pnl = ts.reduce((a, t) => a + t.pnl, 0);
    const wr = ts.filter((t) => t.pnl > 0).length / ts.length;
    p(`| ${r.strategy} | ${sym} | ${ts.length} | ${pct(wr, 0)} | ${money(pnl)} | ${num(ts.reduce((a, t) => a + t.r, 0) / ts.length)} |`);
  }
}
p();
p(`## Notes`);
p();
for (const r of rows) {
  const caps = r.events.filter((e) => e.type === "daily loss cap").length;
  const notes = [
    r.m.skippedMinSize ? `${r.m.skippedMinSize} entries skipped (below BloFin's minimum order size)` : "",
    r.m.missedLimits ? `${r.m.missedLimits} limit entries never filled` : "",
    r.m.liquidations ? `${r.m.liquidations} liquidation(s)` : "",
    caps ? `daily loss cap hit ${caps} time(s)` : "",
    ...r.events.filter((e) => e.type === "kill switch").map((e) => `kill switch on ${day(e.time)}, no trading after`),
  ].filter(Boolean);
  if (notes.length) p(`- ${r.strategy} / ${r.level}: ${notes.join("; ")}.`);
}

const report = lines.join("\n") + "\n";
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "report.md"), report);
writeFileSync(join(outDir, "report.json"), JSON.stringify({ source, from, to: last, cut, allocation, hold, rows }, null, 2));
console.log(report);
console.log(`Saved ${join(outDir, "report.md")} and report.json (with every trade).`);

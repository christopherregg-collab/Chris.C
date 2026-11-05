#!/usr/bin/env node
// Paper trading on BloFin's DEMO account, using the backtested rules.
//
//   node scripts/paper-trader.js             one step against the demo account (BLOFIN_DEMO_* keys)
//   node scripts/paper-trader.js --dry-run   live BloFin prices, no account, no orders: prints
//                                            what it would do right now
//   node scripts/paper-trader.js --status    show saved state without trading
//
// On the server a systemd timer runs one step every 5 minutes (deploy/paper-trader.timer).
// State: data/paper/state.json. Every event: data/paper/log.jsonl.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { LADDER, LEVELS, LIMITS, PAPER, STRATEGIES } from "../lib/backtest/settings.js";
import { initialState, runOnce } from "../lib/trader/trader.js";
import { createBlofinExchange, createDemoClient, createDryRunExchange, demoCredentialsFromEnv } from "../lib/trader/blofin-exchange.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const dir = process.env.PAPER_DIR || "data/paper";
const stateFile = `${dir}/${dryRun ? "dry-run-state.json" : "state.json"}`;
const logFile = `${dir}/${dryRun ? "dry-run-log.jsonl" : "log.jsonl"}`;

const level = LEVELS[PAPER.level];
if (!STRATEGIES[PAPER.strategy] || !level) throw new Error("unknown PAPER.strategy or PAPER.level in lib/backtest/settings.js");
const strategy = { ...STRATEGIES[PAPER.strategy], ...PAPER.overrides };

function load() {
  if (dryRun || !existsSync(stateFile)) return initialState(PAPER.pot);
  return JSON.parse(readFileSync(stateFile, "utf8"));
}

function save(state) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile + ".tmp", JSON.stringify(state, null, 2));
  renameSync(stateFile + ".tmp", stateFile);
}

function summary(state) {
  const open = Object.entries(state.coins).filter(([, c]) => c.status !== "flat");
  const wins = state.trades.filter((t) => t.pnl > 0).length;
  const risk = (state.ladder?.risk ?? level.baseRisk) * 100;
  console.log(`${strategy.label} / ${level.label}, pot $${PAPER.pot}: equity $${(state.equity ?? PAPER.pot).toFixed(2)}, realized $${state.realized.toFixed(2)}, peak $${state.peak.toFixed(2)}`);
  console.log(`Trades: ${state.trades.length} (${wins} wins), missed limit entries: ${state.missedEntries}, next risk ${risk.toFixed(2)}%${state.killed ? ", KILL SWITCH ON" : ""}${state.halted ? ", halted for today" : ""}`);
  for (const [sym, c] of open) {
    console.log(`  ${sym}: ${c.status}${c.status === "open" ? ` from ${c.entryPrice}, stop ${c.stop}, adds ${c.adds}` : ` limit ${c.limitPrice}`}`);
  }
}

if (args.has("--status")) {
  summary(load());
  process.exit(0);
}

let ex;
if (dryRun) {
  ex = createDryRunExchange({ equity: PAPER.pot });
} else {
  const creds = demoCredentialsFromEnv();
  if (!creds) {
    console.error("Missing BLOFIN_DEMO_API_KEY / BLOFIN_DEMO_API_SECRET / BLOFIN_DEMO_API_PASSPHRASE (demo-trading keys).");
    process.exit(1);
  }
  ex = createBlofinExchange(createDemoClient(creds));
}

mkdirSync(dir, { recursive: true });
const { state } = await runOnce({
  ex, strategy, level, ladderRules: LADDER, limits: LIMITS, pot: PAPER.pot, state: load(),
  log: (e) => {
    const { time, type, ...rest } = e;
    console.log(`${time} ${type}`, JSON.stringify(rest));
    appendFileSync(logFile, JSON.stringify(e) + "\n");
  },
});
if (!dryRun) save(state);
if (dryRun) {
  console.log(`\nDry run (${ex.name}). Orders it would place now:`);
  if (!ex.actions.length) console.log("  none: no signal on the latest closed candles");
  for (const a of ex.actions) console.log("  ", JSON.stringify(a));
}
summary(state);

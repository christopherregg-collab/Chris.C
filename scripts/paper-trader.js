#!/usr/bin/env node
// Trading with the backtested rules: on BloFin's DEMO account by default, or with real money.
//
//   node scripts/paper-trader.js             one step against the demo account (BLOFIN_DEMO_* keys)
//   node scripts/paper-trader.js --live      one step with REAL money: needs LIVE_TRADING=on and
//                                            separate BLOFIN_TRADE_* keys; settings in LIVE, state in data/live
//   node scripts/paper-trader.js --dry-run   live BloFin prices, no account, no orders: prints
//                                            what it would do right now
//   node scripts/paper-trader.js --status    show saved state without trading
//   add --active to any of these             Active Swing (PAPER_ACTIVE / LIVE_ACTIVE) instead of Big Swing
//   add --short (demo only)                  Big Swing Short experiment (PAPER_SHORT), state in data/paper-short
//
// On the server systemd timers run one step every 5 minutes (deploy/paper-trader.timer,
// deploy/paper-active.timer). State: data/paper[-active]/state.json, events: log.jsonl.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { LADDER, LEVELS, LIMITS, LIVE, LIVE_ACTIVE, PAPER, PAPER_ACTIVE, PAPER_SHORT, STRATEGIES } from "../lib/backtest/settings.js";
import { initialState, runOnce } from "../lib/trader/trader.js";
import { createBlofinExchange, createDryRunExchange, createTradingClient, demoCredentialsFromEnv, liveCredentialsFromEnv } from "../lib/trader/blofin-exchange.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const live = args.has("--live");
const active = args.has("--active"); // Active Swing instead of Big Swing
const short = args.has("--short"); // Big Swing Short: a demo-only experiment
if (short && live) {
  console.error("Big Swing Short is a demo-only experiment: there is no live mode for it.");
  process.exit(1);
}
const CONFIG = short ? PAPER_SHORT : live ? (active ? LIVE_ACTIVE : LIVE) : active ? PAPER_ACTIVE : PAPER;
const dir = `data/${live ? "live" : "paper"}${active ? "-active" : short ? "-short" : ""}`;
const stateFile = `${dir}/${dryRun ? "dry-run-state.json" : "state.json"}`;
const logFile = `${dir}/${dryRun ? "dry-run-log.jsonl" : "log.jsonl"}`;

const level = LEVELS[CONFIG.level];
if (!STRATEGIES[CONFIG.strategy] || !level) throw new Error(`unknown strategy or level in ${live ? "LIVE" : "PAPER"} (lib/backtest/settings.js)`);
const strategy = { ...STRATEGIES[CONFIG.strategy], ...CONFIG.overrides };

function load() {
  if (dryRun || !existsSync(stateFile)) return initialState(CONFIG.pot);
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
  console.log(`${live ? "LIVE " : ""}${strategy.label} / ${level.label}, pot $${CONFIG.pot}: equity $${(state.equity ?? CONFIG.pot).toFixed(2)}, realized $${state.realized.toFixed(2)}, peak $${state.peak.toFixed(2)}`);
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
  ex = createDryRunExchange({ equity: CONFIG.pot });
} else if (live) {
  if (process.env.LIVE_TRADING !== "on") {
    console.error("Live trading is off. Set LIVE_TRADING=on in .env to trade real money (see LIVE_TRADING.md).");
    process.exit(1);
  }
  const creds = liveCredentialsFromEnv();
  if (!creds) {
    console.error("Missing BLOFIN_TRADE_API_KEY / BLOFIN_TRADE_API_SECRET / BLOFIN_TRADE_API_PASSPHRASE (a separate real-account key with trade permission).");
    process.exit(1);
  }
  if (creds.key === process.env.BLOFIN_API_KEY) {
    console.error("BLOFIN_TRADE_API_KEY must be a different key from the dashboard's read-only BLOFIN_API_KEY.");
    process.exit(1);
  }
  ex = createBlofinExchange(createTradingClient(creds, { live: true }));
} else {
  const creds = demoCredentialsFromEnv();
  if (!creds) {
    console.error("Missing BLOFIN_DEMO_API_KEY / BLOFIN_DEMO_API_SECRET / BLOFIN_DEMO_API_PASSPHRASE (demo-trading keys).");
    process.exit(1);
  }
  ex = createBlofinExchange(createTradingClient(creds));
}

mkdirSync(dir, { recursive: true });
const { state } = await runOnce({
  ex, strategy, level, ladderRules: LADDER, limits: LIMITS, pot: CONFIG.pot, state: load(),
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

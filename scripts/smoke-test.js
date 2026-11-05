#!/usr/bin/env node
// Exercises every order call the trader makes, in about 30 seconds, at BloFin's minimum
// order size, and reports each step as PASS or FAIL:
//   limit buy far below the market + cancel, market buy, stop-loss for the whole position,
//   move the stop up, close the position, read its realized P&L.
//
//   node scripts/smoke-test.js                    on the DEMO account (BLOFIN_DEMO_* keys)
//   node scripts/smoke-test.js --live             on the REAL account (LIVE_TRADING=on, BLOFIN_TRADE_* keys);
//                                                 costs a few cents in fees and spread
//   node scripts/smoke-test.js --symbol ETH-USDT  coin to use (default BTC-USDT)
//
// It refuses to run on a coin that already has a position or open orders, so it can't
// interfere with the trader or with your own trades.

import { createBlofinExchange, createTradingClient, demoCredentialsFromEnv, liveCredentialsFromEnv } from "../lib/trader/blofin-exchange.js";
import { runSmokeTest } from "../lib/trader/smoke.js";

const argv = process.argv.slice(2);
const live = argv.includes("--live");
const symIndex = argv.indexOf("--symbol");
const sym = symIndex > -1 ? argv[symIndex + 1] : "BTC-USDT";

if (live && process.env.LIVE_TRADING !== "on") {
  console.error("Live trading is off. Set LIVE_TRADING=on in .env first.");
  process.exit(1);
}
const creds = live ? liveCredentialsFromEnv() : demoCredentialsFromEnv();
if (!creds) {
  console.error(`Missing ${live ? "BLOFIN_TRADE_*" : "BLOFIN_DEMO_*"} keys in .env.`);
  process.exit(1);
}
const ex = createBlofinExchange(createTradingClient(creds, { live }));

console.log(`Smoke test on ${ex.name}, ${sym}\n`);
const { failed } = await runSmokeTest(ex, sym);
console.log(failed ? `\n${failed} step(s) FAILED. Send the output to Claude; nothing above is left open on purpose.` : "\nAll steps passed: the trader's order calls work on this account.");
process.exit(failed ? 1 : 0);

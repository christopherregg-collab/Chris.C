#!/usr/bin/env node
// Downloads BloFin candles (at the strategies' candle length), funding history and
// order-size rules for the backtester. Goes back as far as BloFin has data, up to --days.
//   npm run backtest:fetch                 (up to 5 years)
//   npm run backtest:fetch -- --days 730

import { STRATEGIES } from "../lib/backtest/config.js";
import { downloadAll } from "../lib/backtest/blofin-data.js";

const i = process.argv.indexOf("--days");
const days = i > -1 ? Number(process.argv[i + 1]) : 5 * 365;
const dir = "data/blofin";
const strategies = Object.values(STRATEGIES);
const symbols = [...new Set(strategies.flatMap((s) => s.symbols))];
const barLengths = [...new Set(strategies.map((s) => s.barMs))];

let specs;
for (const barMs of barLengths) specs = await downloadAll({ symbols, days, dir, barMs });
console.log("Order size rules:", specs);
console.log(`Done. Data is in ${dir}/. Now run: npm run backtest`);

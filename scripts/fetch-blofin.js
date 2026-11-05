#!/usr/bin/env node
// Downloads BloFin hourly candles, funding history and order-size rules for the backtester.
//   npm run backtest:fetch                 (about 2 years)
//   npm run backtest:fetch -- --days 365

import { STRATEGIES } from "../lib/backtest/config.js";
import { downloadAll } from "../lib/backtest/blofin-data.js";

const i = process.argv.indexOf("--days");
const days = i > -1 ? Number(process.argv[i + 1]) : 790; // 2 years + 55 days of indicator warm-up
const dir = "data/blofin";
const symbols = [...new Set(Object.values(STRATEGIES).flatMap((s) => s.symbols))];

const specs = await downloadAll({ symbols, days, dir });
console.log("Order size rules:", specs);
console.log(`Done. Data is in ${dir}/. Now run: npm run backtest`);

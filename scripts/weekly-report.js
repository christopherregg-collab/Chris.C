#!/usr/bin/env node
// Weekly report for all bots (live and demo): trades, results in R, win rate, drawdown,
// limit fill rate, problems from the logs, and progress to the 30-trade review.
//   node scripts/weekly-report.js          print it
//   node scripts/weekly-report.js --save   also save data/reports/YYYY-MM-DD.md (the Monday timer does this)
// The dashboard shows the same report, always current, at /api/report.
import { mkdirSync, writeFileSync } from "node:fs";
import { loadBots } from "../lib/trader/bots.js";
import { reportMarkdown, summarizeBot } from "../lib/trader/report.js";

const now = Date.now();
const md = reportMarkdown(loadBots().map((b) => summarizeBot(b, now)), now);
console.log(md);
if (process.argv.includes("--save")) {
  mkdirSync("data/reports", { recursive: true });
  const file = `data/reports/${new Date(now).toISOString().slice(0, 10)}.md`;
  writeFileSync(file, md);
  console.log(`Saved ${file}`);
}

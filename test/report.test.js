import test from "node:test";
import assert from "node:assert/strict";
import { REVIEW_TRADES, reportHtml, reportMarkdown, summarizeBot, verdict } from "../lib/trader/report.js";

const NOW = Date.UTC(2026, 11, 7, 8);
const DAY = 86_400_000;
const trade = (daysAgo, pnl, r, reason = r > 0 ? "target" : "stop") => ({
  sym: "BTC-USDT", side: "short", openedAt: new Date(NOW - daysAgo * DAY - 36e5 * 20).toISOString(),
  closedAt: new Date(NOW - daysAgo * DAY).toISOString(), pnl, r, reason,
});
const state = (trades, extra = {}) => ({
  realized: trades.reduce((a, t) => a + t.pnl, 0), equity: 60 + trades.reduce((a, t) => a + t.pnl, 0), peak: 70,
  trades, missedEntries: 1, ladder: { risk: 0.0125 }, startedAt: new Date(NOW - 21 * DAY).toISOString(),
  updatedAt: new Date(NOW).toISOString(), view: { positions: [{ symbol: "ETH-USDT", side: "short", entryPrice: 2000, stopPrice: 2100, targetPrice: 1700, unrealizedPnl: 0.4 }] },
  ...extra,
});

test("summarizeBot counts trades, R, win rate, fill rate, drawdown and this week's problems", () => {
  const trades = [trade(15, 1.8, 3), trade(10, -0.6, -1), trade(3, -0.6, -1), trade(2, 1.8, 3)];
  const events = [
    { time: new Date(NOW - 2 * DAY).toISOString(), type: "entry order rejected", sym: "SOL-USDT" },
    { time: new Date(NOW - 20 * DAY).toISOString(), type: "entry order rejected", sym: "SOL-USDT" }, // older than a week
  ];
  const s = summarizeBot({ key: "swingShort", label: "Big Swing Short", mode: "live", pot: 60, state: state(trades), events }, NOW);
  assert.equal(s.trades, 4);
  assert.equal(s.tradesThisWeek, 2);
  assert.equal(s.winRate, 0.5);
  assert.equal(s.avgR, 1);
  assert.equal(s.totalR, 4);
  assert.ok(Math.abs(s.pnlThisWeek - 1.2) < 1e-9);
  assert.equal(s.fillRate, 5 / 6, "4 closed + 1 open filled, 1 expired");
  assert.ok(Math.abs(s.maxDrawdown - 1.2 / 61.8) < 1e-9, "two 0.6 losses after a 1.8 win");
  assert.deepEqual(s.problems, { "entry orders rejected by BloFin": 1 });
  assert.equal(s.exits.target, 2);
});

test("verdict follows the 30-trade review rules", () => {
  const st = {};
  assert.match(verdict(3, 0.5, 0, st), /Too early/);
  assert.match(verdict(20, -0.5, 0.1, st), /Early warning/);
  assert.match(verdict(20, 0.1, 0.1, st), /On track/);
  assert.match(verdict(REVIEW_TRADES, 0.25, 0.1, st), /keep it/);
  assert.match(verdict(REVIEW_TRADES, -0.05, 0.1, st), /retire it/);
  assert.match(verdict(REVIEW_TRADES, 0.1, 0.1, st), /keep testing/);
  assert.match(verdict(40, 0.5, 0.22, st), /WARNING/);
  assert.match(verdict(40, 0.5, 0.1, { killed: true }), /kill switch/);
  assert.match(verdict(0, null, 0, null), /Not running/);
});

test("the report lists every bot, compares live with demo, and renders as HTML", () => {
  const live = summarizeBot({ key: "swingShort", label: "Big Swing Short", mode: "live", pot: 60, state: state([trade(2, 1.8, 3)]) }, NOW);
  const demo = summarizeBot({ key: "swingShort", label: "Big Swing Short", mode: "demo", pot: 60, state: state([trade(2, 1.8, 3), trade(1, -0.6, -1)]) }, NOW);
  const off = summarizeBot({ key: "active", label: "Active Swing", mode: "live", pot: 100, state: null }, NOW);
  const md = reportMarkdown([live, demo, off], NOW);
  assert.match(md, /\| Big Swing Short \| LIVE \| \$61\.80 \(\$60\.00\)/);
  assert.match(md, /\| Active Swing \| LIVE \| not running/);
  assert.match(md, /## Live vs demo/);
  assert.match(md, /Open now: short ETH-USDT from 2000, stop 2100, target 1700/);
  assert.match(md, /Pace: 0\.3 trades a week \(backtest ~0\.6\)/);
  const html = reportHtml(md);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<table>/);
  assert.match(html, /<strong>Too early to judge: 1 of 30 trades\.<\/strong>/);
  assert.ok(!html.includes("<script"), "no scripts in the report page");
});

test("reportHtml escapes anything that looks like HTML", () => {
  assert.match(reportHtml("- <img src=x onerror=alert(1)>\n"), /&lt;img src=x onerror=alert\(1\)&gt;/);
});

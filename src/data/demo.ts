// Demo fixtures. Clearly fictional numbers for building and testing the UI
// before a live integration exists. Times are generated relative to "now" so
// the demo looks current; the "stale" and "disconnected" scenarios age them.

import { dashboardConfig } from "../config/dashboard";
import { startOfDay } from "../lib/derive";
import type { DashboardData, EquityPoint, Position, StrategyRuntime, Trade } from "../types";

export type DemoScenario = "normal" | "empty" | "loading" | "error" | "stale" | "disconnected";
export const DEMO_SCENARIOS: { id: DemoScenario; label: string }[] = [
  { id: "normal", label: "Normal" },
  { id: "empty", label: "Empty (no positions or trades)" },
  { id: "loading", label: "Loading" },
  { id: "error", label: "Error" },
  { id: "stale", label: "Stale data" },
  { id: "disconnected", label: "Bot disconnected" },
];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (t: number) => new Date(t).toISOString();

// Small seeded PRNG so the demo looks the same on every load.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function equitySeries(nowMs: number, finalEquity: number): EquityPoint[] {
  const hours = 180 * 24;
  const rand = mulberry32(7);
  // Deposits and withdrawals, keyed by hours before now.
  const flows = new Map<number, number>([[120 * 24, 2000], [60 * 24 + 5, -1000], [8 * 24 + 3, 500]]);
  const raw: { equity: number; cashFlow: number }[] = [];
  let equity = 10_000;
  for (let i = 0; i < hours; i++) {
    const hoursAgo = hours - 1 - i;
    const noise = (rand() + rand() + rand() - 1.5) * 0.0042;
    const cashFlow = flows.get(hoursAgo) ?? 0;
    equity = equity * (1 + 0.00009 + noise) + cashFlow;
    raw.push({ equity, cashFlow });
  }
  // Scale so the series ends exactly at the account's current equity.
  const scale = finalEquity / raw[raw.length - 1]!.equity;
  const end = Math.floor(nowMs / 60_000) * 60_000;
  return raw.map((p, i) => ({
    t: iso(end - (hours - 1 - i) * HOUR),
    equity: Math.round(p.equity * scale * 100) / 100,
    cashFlow: p.cashFlow,
  }));
}

function positions(nowMs: number, dayStart: number): Record<string, Position> {
  const today = (f: number) => iso(dayStart + f * (nowMs - dayStart));
  return {
    btc: {
      id: "pos-btc", symbol: "BTC-USDT", side: "long", size: 0.05,
      entryPrice: 68_250, markPrice: 68_910, leverage: 5, stopPrice: 67_400, targetPrice: 70_100,
      openedAt: today(0.35), unrealizedPnl: 33.0,
    },
    eth: {
      id: "pos-eth", symbol: "ETH-USDT", side: "short", size: 0.8,
      entryPrice: 3_520, markPrice: 3_486.5, leverage: 3, stopPrice: 3_610, targetPrice: 3_380,
      openedAt: iso(dayStart - 7 * HOUR), unrealizedPnl: 26.8,
    },
    sol: {
      id: "pos-sol", symbol: "SOL-USDT", side: "long", size: 12,
      entryPrice: 161.2, markPrice: 159.85, leverage: 4, stopPrice: 156.5, targetPrice: 170,
      openedAt: today(0.7), unrealizedPnl: -16.2,
    },
  };
}

function trades(nowMs: number, dayStart: number, pos: Record<string, Position>): Trade[] {
  const today = (f: number) => iso(dayStart + f * (nowMs - dayStart));
  // [days before today, hour opened, hours held, symbol, slot, side, pnl, risk]
  const history: [number, number, number, string, Trade["slot"], Trade["side"], number, number | undefined][] = [
    [1, 2, 5, "BTC-USDT", "featured", "long", 84.2, 60],
    [1, 9, 3, "AVAX-USDT", "lower_1", "short", -41.5, 40],
    [1, 15, 6, "SOL-USDT", "lower_2", "long", 52.3, 45],
    [2, 4, 4, "ETH-USDT", "featured", "short", 0, 50],
    [2, 11, 8, "LINK-USDT", "lower_1", "long", 37.9, 35],
    [2, 19, 2, "DOGE-USDT", "lower_2", "long", -30.0, 30],
    [3, 6, 10, "BTC-USDT", "featured", "long", 121.6, 60],
    [3, 14, 3, "XRP-USDT", "lower_1", "short", -35.2, 35],
    [4, 3, 7, "ETH-USDT", "featured", "long", 66.4, 50],
    [4, 13, 4, "SOL-USDT", "lower_2", "short", 28.1, 40],
    [4, 20, 2, "AVAX-USDT", "lower_1", "long", -40.0, 40],
    [5, 8, 9, "BTC-USDT", "featured", "short", -58.7, 60],
    [5, 16, 5, "LINK-USDT", "lower_1", "long", 44.0, undefined],
    [6, 5, 6, "ETH-USDT", "featured", "long", 73.5, 50],
    [6, 12, 4, "DOGE-USDT", "lower_2", "short", 19.8, 30],
    [6, 18, 3, "SOL-USDT", "lower_2", "long", -45.0, 45],
  ];
  const closed: Trade[] = history.map(([d, h, held, symbol, slot, side, pnl, risk], i) => {
    const opened = dayStart - d * DAY + h * HOUR;
    return {
      id: `t-${i}`, symbol, slot, side,
      openedAt: iso(opened), closedAt: iso(opened + held * HOUR),
      realizedPnl: pnl, initialRisk: risk,
    };
  });
  // Today: two closed, plus the open positions.
  closed.push(
    { id: "t-today-1", symbol: "XRP-USDT", slot: "lower_1", side: "long", openedAt: today(0.1), closedAt: today(0.3), realizedPnl: 46.8, initialRisk: 60 },
    { id: "t-today-2", symbol: "AVAX-USDT", slot: "featured", side: "short", openedAt: today(0.2), closedAt: today(0.5), realizedPnl: -112.4, initialRisk: 112.4 },
  );
  const open: Trade[] = [
    { id: "t-open-btc", symbol: "BTC-USDT", slot: "featured", side: "long", openedAt: pos.btc!.openedAt, initialRisk: 42.5 },
    { id: "t-open-eth", symbol: "ETH-USDT", slot: "featured", side: "short", openedAt: pos.eth!.openedAt, initialRisk: 72 },
    { id: "t-open-sol", symbol: "SOL-USDT", slot: "lower_2", side: "long", openedAt: pos.sol!.openedAt, initialRisk: 56.4 },
  ];
  return [...closed, ...open];
}

export function demoData(scenario: DemoScenario, nowMs = Date.now()): DashboardData {
  // Stale and disconnected scenarios pretend the last update was a while ago.
  const lag = scenario === "stale" ? 25 * 60_000 : scenario === "disconnected" ? 2 * HOUR : 0;
  const asOfMs = nowMs - lag;
  const asOf = iso(asOfMs);
  const dayStart = startOfDay(asOfMs, dashboardConfig.displayTimezone);
  const empty = scenario === "empty";

  const pos = positions(asOfMs, dayStart);
  const openPositions = empty ? [] : [pos.btc!, pos.eth!, pos.sol!];
  const margin = openPositions.reduce((s, p) => s + (p.entryPrice * p.size) / (p.leverage ?? 1), 0);
  const equity = 12_486.35;
  const points = equitySeries(asOfMs, equity);

  const strategies: StrategyRuntime[] = empty
    ? [
        { asOf, slot: "featured", status: "flat", message: "No open positions.", positions: [] },
        { asOf, slot: "lower_1", status: "watching", message: "Waiting for entry conditions.", positions: [] },
        { asOf, slot: "lower_2", status: "paused", message: "Paused from the bot's settings.", positions: [] },
      ]
    : [
        { asOf, slot: "featured", status: "in_position", message: "Managing 2 open positions.", positions: [pos.btc!, pos.eth!] },
        { asOf, slot: "lower_1", status: "watching", message: "Waiting for entry conditions on 2 symbols.", positions: [] },
        { asOf, slot: "lower_2", status: "in_position", message: "Managing 1 open position.", positions: [pos.sol!] },
      ];
  if (scenario === "disconnected") {
    for (const s of strategies) {
      s.status = "error";
      s.message = "No update from the bot since it disconnected.";
    }
  }

  return {
    mode: "demo",
    currency: dashboardConfig.reportingCurrency,
    health: {
      asOf,
      status: scenario === "disconnected" ? "disconnected" : scenario === "stale" ? "no_heartbeat" : "connected",
      lastSeen: iso(asOfMs - 8_000),
      readiness: { ready: scenario === "disconnected" ? 0 : 3, total: 3 },
    },
    account: { asOf, equity, available: Math.round((equity - margin) * 100) / 100 },
    performance: {
      asOf,
      points,
      baseline: { label: "Since start", t: points[0]!.t },
      cashFlowsReported: true,
    },
    strategies,
    trades: { asOf, items: empty ? [] : trades(asOfMs, dayStart, pos) },
    scanner: {
      asOf,
      candidates: empty ? [] : [
        { symbol: "AVAX-USDT", slot: "lower_1", signal: "Setup forming", updatedAt: iso(asOfMs - 6 * 60_000) },
        { symbol: "LINK-USDT", slot: "lower_1", signal: "Approaching entry", updatedAt: iso(asOfMs - 14 * 60_000) },
        { symbol: "DOGE-USDT", slot: "featured", signal: "Watching", updatedAt: iso(asOfMs - 32 * 60_000) },
      ],
    },
    risk: { asOf, dailyLossCap: empty ? undefined : 300 },
    events: empty ? [] : [
      { id: "e1", t: openPositions[2]!.openedAt, level: "info", text: "Opened long SOL-USDT (Strategy 3)." },
      { id: "e2", t: iso(dayStart + 0.5 * (asOfMs - dayStart)), level: "warning", text: "Closed short AVAX-USDT at a loss of 112.40 USDT (Strategy 1)." },
      { id: "e3", t: openPositions[0]!.openedAt, level: "info", text: "Opened long BTC-USDT (Strategy 1)." },
      { id: "e4", t: iso(dayStart + 0.3 * (asOfMs - dayStart)), level: "success", text: "Closed long XRP-USDT for +46.80 USDT (Strategy 2)." },
    ],
  };
}

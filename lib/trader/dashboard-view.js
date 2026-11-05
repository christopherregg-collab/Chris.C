// Turns the paper trader's saved state and event log into dashboard data
// (see src/types.ts): a strategy runtime for its slot, its trades, and recent events.
// Read-only: the dashboard never changes the paper trader.

import { existsSync, readFileSync } from "node:fs";

export const PAPER_SLOT = "lower_1"; // "Strategy 2" on the dashboard
const LABEL = "Big Swing (paper)";

export function readPaper(dir = process.env.PAPER_DIR || "data/paper") {
  const stateFile = `${dir}/state.json`;
  if (!existsSync(stateFile)) return null;
  let state;
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
  const logFile = `${dir}/log.jsonl`;
  const events = existsSync(logFile)
    ? readFileSync(logFile, "utf8").trim().split("\n").slice(-40).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    })
    : [];
  return { state, events };
}

const money = (x) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`;

function describe(e) {
  const sym = e.sym ?? "";
  switch (e.type) {
    case "entry order": return { level: "info", text: `${LABEL}: limit ${e.side} ${sym} at ${e.price}` };
    case "filled": return { level: "success", text: `${LABEL}: ${sym} ${e.side} filled at ${e.price}, stop ${e.stop}` };
    case "closed": return { level: e.pnl > 0 ? "success" : "warning", text: `${LABEL}: ${sym} closed (${e.reason}), ${money(e.pnl)}` };
    case "exit": return { level: "info", text: `${LABEL}: exiting ${sym} (${e.reason})` };
    case "stop raised": return { level: "info", text: `${LABEL}: ${sym} stop raised to ${e.to}` };
    case "added to winner": return { level: "success", text: `${LABEL}: added to ${sym} at ${e.price}` };
    case "entry order rejected": return { level: "error", text: `${LABEL}: ${sym} entry rejected by BloFin: ${e.error}` };
    case "entry expired": return { level: "info", text: `${LABEL}: ${sym} limit order expired unfilled` };
    case "signal skipped: below minimum order size": return { level: "warning", text: `${LABEL}: ${sym} signal skipped, below BloFin's minimum order size` };
    case "stop was missing, placed again": return { level: "warning", text: `${LABEL}: ${sym} stop was missing and was placed again` };
    case "unmanaged position left alone": return { level: "warning", text: `${LABEL}: a ${sym} position it didn't open is on the demo account; left alone` };
    default:
      if (/kill switch/i.test(e.type) || /daily loss cap/i.test(e.type)) return { level: "error", text: `${LABEL}: ${e.type}` };
      return { level: "info", text: `${LABEL}: ${e.type}${sym ? ` ${sym}` : ""}` };
  }
}

/** Dashboard pieces for the paper trader, or null if it has never run. */
export function paperDashboard(paper, { pot = 60 } = {}) {
  if (!paper?.state) return null;
  const { state, events } = paper;
  const asOf = state.updatedAt ?? new Date(0).toISOString();
  const view = state.view ?? { positions: [], entering: [] };
  const equity = state.equity ?? pot;
  const summary = `Paper trading on the BloFin demo account: equity ${money(equity)} from a ${money(pot)} pot, ${state.trades.length} closed trade${state.trades.length === 1 ? "" : "s"}.`;

  let status;
  let message;
  if (state.killed) {
    status = "paused";
    message = `Kill switch tripped: closed everything and stopped. ${summary}`;
  } else if (state.halted) {
    status = "paused";
    message = `Daily loss cap hit: flat until tomorrow (UTC). ${summary}`;
  } else if (view.positions.length) {
    status = "in_position";
    message = summary;
  } else {
    status = "watching";
    message = view.entering.length
      ? `Limit order waiting: ${view.entering.map((x) => `${x.symbol} at ${x.price}`).join(", ")}. ${summary}`
      : `Waiting for a breakout signal. ${summary}`;
  }

  const positions = view.positions.map((p) => ({
    id: `paper-${p.symbol}`,
    symbol: p.symbol,
    side: p.side,
    size: p.size,
    entryPrice: p.entryPrice,
    markPrice: p.markPrice,
    stopPrice: p.stopPrice,
    openedAt: p.openedAt,
    unrealizedPnl: p.unrealizedPnl,
  }));

  const trades = [
    ...positions.map((p) => ({ id: `paper-open-${p.symbol}`, symbol: p.symbol, slot: PAPER_SLOT, side: p.side, openedAt: p.openedAt, paper: true })),
    ...state.trades.map((t, i) => ({
      id: `paper-${i}-${t.closedAt}`, symbol: t.sym, slot: PAPER_SLOT, side: t.side, openedAt: t.openedAt, closedAt: t.closedAt,
      realizedPnl: t.pnl, ...(t.initialRisk ? { initialRisk: t.initialRisk } : {}), paper: true,
    })),
  ];

  const botEvents = events.map((e, i) => ({ id: `paper-ev-${e.time}-${i}`, t: e.time, ...describe(e) }));

  return { strategy: { asOf, slot: PAPER_SLOT, status, message, positions }, trades, events: botEvents };
}

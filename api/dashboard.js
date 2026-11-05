// GET /api/dashboard: the live DashboardData (see src/types.ts), read from
// BloFin with a read-only API key held in server environment variables.
//
// Real-account positions are shown in the Strategy 1 slot, the paper trader in Strategy 2,
// the scanner shows Big Swing setups and momentum across the watchlist
// (server/setup-scanner.js; SCANNER_MODE=indicators for the older Coinbase EMA/MACD/RSI
// scanner), and "health" means "the BloFin API answered".

import { fetchAccount, fetchCashFlowSince, fetchClosedTrades, fetchPositions } from "../server/blofin.js";
import { accountClient, dashboardAccount } from "../server/account.js";
import { readSnapshots } from "../server/snapshots.js";
import { getScanner } from "../server/scanner.js";
import { getSetupScanner } from "../server/setup-scanner.js";

const defaultScanner = (nowMs) => (process.env.SCANNER_MODE === "indicators" ? getScanner(nowMs) : getSetupScanner(nowMs));
import { paperDashboard, readPaper } from "../lib/trader/dashboard-view.js";
import { PAPER } from "../lib/backtest/settings.js";

const DAY = 86_400_000;
/** Snapshots are hourly; older than this means the recorder has stopped. */
export const SNAPSHOT_MAX_AGE_MS = 70 * 60_000;
const CACHE_MS = 10_000;
let cache = { at: 0, body: null };

export async function buildDashboard(client, { nowMs = Date.now(), snapshots = [], dailyLossCap, scanner = defaultScanner, paper = null, source = { kind: "real", label: "BloFin" } } = {}) {
  const demo = source.kind === "demo";
  const asOf = new Date(nowMs).toISOString();
  const last = snapshots[snapshots.length - 1];
  const [account, positions, closed, flow, scan] = await Promise.all([
    fetchAccount(client),
    fetchPositions(client, nowMs),
    fetchClosedTrades(client, nowMs - 8 * DAY, nowMs),
    // The demo host has no funding account, so transfers can't be read there.
    last ? fetchCashFlowSince(client, Date.parse(last.t)).catch((err) => (demo ? 0 : Promise.reject(err))) : Promise.resolve(0),
    scanner(nowMs),
  ]);
  // The chart's history comes from hourly snapshots. If the newest is overdue,
  // report its time as asOf so the Performance card shows a stale badge.
  const snapshotsOverdue = last && nowMs - Date.parse(last.t) > SNAPSHOT_MAX_AGE_MS;

  const unrealized = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  // Live point appended after the stored hourly snapshots so "Today" is current.
  const points = [...snapshots, { t: asOf, equity: account.equity, cashFlow: last ? flow : 0 }];

  // On the demo account every trade is a paper trade: marked so it never counts against the real loss cap.
  const openTrades = positions.map((p) => ({ id: `open-${p.id}`, symbol: p.symbol, side: p.side, openedAt: p.openedAt, slot: "featured", ...(demo ? { paper: true } : {}) }));
  // The paper trader (BloFin demo account) shows in Strategy 2, its trades are marked paper.
  const paperView = paperDashboard(paper, { pot: PAPER.pot });

  return {
    mode: "live",
    exchangeAccount: source.kind,
    currency: "USDT",
    health: { asOf, status: "connected", lastSeen: asOf },
    account: { asOf, equity: account.equity, available: account.available },
    performance: {
      asOf: snapshotsOverdue ? last.t : asOf,
      points,
      baseline: { label: "Since tracking began", t: points[0].t },
      cashFlowsReported: true,
    },
    strategies: [
      {
        asOf,
        slot: "featured",
        status: positions.length ? "in_position" : "flat",
        message: positions.length
          ? `${positions.length} open position${positions.length === 1 ? "" : "s"} on the ${source.label} (unrealized ${unrealized.toFixed(2)} USDT).`
          : `No open positions on the ${source.label}.`,
        positions,
      },
      ...(paperView ? [paperView.strategy] : []),
    ],
    // In demo mode the account's own trades already are the paper trader's, so they aren't listed twice.
    trades: { asOf, items: [...openTrades, ...closed.map((t) => ({ ...t, slot: "featured", ...(demo ? { paper: true } : {}) })), ...(demo ? [] : paperView?.trades ?? [])] },
    scanner: scan,
    risk: { asOf, ...(dailyLossCap > 0 ? { dailyLossCap } : {}) },
    events: paperView?.events ?? [],
  };
}

export default async function handler(req, res) {
  const account = dashboardAccount();
  const client = accountClient(account);
  if (!client) {
    const keys = account.kind === "demo" ? "BLOFIN_DEMO_API_*" : "BLOFIN_API_*";
    return send(res, 503, { error: `${account.label} credentials (${keys}) are not set on the server (see .env.example).` });
  }
  const nowMs = Date.now();
  if (cache.body && nowMs - cache.at < CACHE_MS) return send(res, 200, cache.body);
  try {
    const body = await buildDashboard(client, {
      nowMs,
      source: account,
      snapshots: readSnapshots(account.snapshotFile),
      dailyLossCap: Number(process.env.DAILY_LOSS_CAP) || undefined,
      paper: readPaper(),
    });
    cache = { at: nowMs, body };
    return send(res, 200, body);
  } catch (err) {
    console.error(`dashboard: ${err.message}`);
    return send(res, err.status || 502, { error: err.message });
  }
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

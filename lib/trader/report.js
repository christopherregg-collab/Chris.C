// Weekly report for the trading bots: for each bot (live and demo), trades, results in R,
// win rate, drawdown, limit-order fill rate, open positions, problems from the log, and
// progress to the 30-trade review. Pure functions: the caller supplies saved state and logs.

const DAY = 86_400_000;
export const REVIEW_TRADES = 30;

/** What each strategy's backtest led us to expect (Nov 2026, Conservative level). */
export const EXPECTED = {
  swing: { winRate: 0.23, avgR: 1.34, perWeek: 0.9 }, // with the 1.5 ATR stop
  active: { winRate: 0.32, avgR: 0.19, perWeek: 3.3 },
  swingShort: { winRate: 0.33, avgR: 0.15, perWeek: 0.6 },
};

// Log events that mean something needs attention.
const PROBLEMS = {
  "entry order rejected": "entry orders rejected by BloFin",
  "take-profit rejected": "take-profit orders rejected by BloFin",
  "stop was missing, placed again": "stops found missing and replaced",
  "market regime unavailable: no new shorts this run": "runs without BTC's trend (no new shorts)",
  "unmanaged position left alone": "positions on the account the bot didn't open",
  "KILL SWITCH: flattening and stopping": "kill switch tripped",
  "daily loss cap: flattening until tomorrow (UTC)": "daily loss cap hit",
};

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Numbers for one bot. `bot` = { key, label, mode: "live"|"demo", pot, state, events }. */
export function summarizeBot(bot, now = Date.now()) {
  const { state, events = [], pot } = bot;
  const trades = (state?.trades ?? []).filter((t) => Number.isFinite(t.pnl));
  const weekAgo = now - 7 * DAY;
  const thisWeek = trades.filter((t) => Date.parse(t.closedAt) >= weekAgo);
  const rs = trades.map((t) => t.r).filter(Number.isFinite);
  // Equity path from closed trades, for the worst drop from a peak.
  let equity = pot, peak = pot, maxDrawdown = 0;
  for (const t of [...trades].sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt))) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0);
  }
  const open = state?.view?.positions ?? [];
  const filled = trades.length + open.length;
  const missed = state?.missedEntries ?? 0;
  const problems = {};
  for (const e of events) {
    if (Date.parse(e.time) < weekAgo || !PROBLEMS[e.type]) continue;
    problems[PROBLEMS[e.type]] = (problems[PROBLEMS[e.type]] ?? 0) + 1;
  }
  const exits = {};
  for (const t of trades) exits[t.reason] = (exits[t.reason] ?? 0) + 1;
  const holds = trades.map((t) => Date.parse(t.closedAt) - Date.parse(t.openedAt)).filter(Number.isFinite);
  const avgR = avg(rs);
  const started = state?.startedAt ?? trades[0]?.openedAt ?? null;
  return {
    key: bot.key, label: bot.label, mode: bot.mode, pot,
    running: !!state, equity: state?.equity ?? pot, realized: state?.realized ?? 0,
    killed: !!state?.killed, halted: !!state?.halted, nextRisk: state?.ladder?.risk ?? null,
    updatedAt: state?.updatedAt ?? null, started,
    trades: trades.length, tradesThisWeek: thisWeek.length,
    pnlThisWeek: thisWeek.reduce((a, t) => a + t.pnl, 0),
    winRate: trades.length ? trades.filter((t) => t.pnl > 0).length / trades.length : null,
    avgR, totalR: rs.reduce((a, b) => a + b, 0),
    bestR: rs.length ? Math.max(...rs) : null, worstR: rs.length ? Math.min(...rs) : null,
    avgHoldHours: holds.length ? avg(holds) / 3_600_000 : null,
    maxDrawdown, exits, open,
    fillRate: filled + missed ? filled / (filled + missed) : null, missed,
    problems, verdict: verdict(trades.length, avgR, maxDrawdown, state),
  };
}

/** Where the bot stands against the review rules agreed in Nov 2026. */
export function verdict(n, avgR, maxDrawdown, state) {
  if (!state) return "Not running.";
  if (state.killed) return "STOPPED by the kill switch (25% below its peak). Review before restarting.";
  if (maxDrawdown >= 0.2) return "WARNING: 20%+ below its peak. Consider stopping it.";
  if (n < 15) return `Too early to judge: ${n} of ${REVIEW_TRADES} trades.`;
  if (n < REVIEW_TRADES) {
    return avgR < -0.3
      ? `Early warning: averaging ${avgR.toFixed(2)}R after ${n} trades, far below plan.`
      : `On track to review: ${n} of ${REVIEW_TRADES} trades, averaging ${avgR >= 0 ? "+" : ""}${avgR.toFixed(2)}R.`;
  }
  if (avgR >= 0.2) return `REVIEW: keep it. ${n} trades averaging +${avgR.toFixed(2)}R (target +0.20R or better).`;
  if (avgR < 0) return `REVIEW: retire it. ${n} trades averaging ${avgR.toFixed(2)}R (below 0).`;
  return `REVIEW: keep testing. ${n} trades averaging +${avgR.toFixed(2)}R (between 0 and +0.20R).`;
}

const money = (x) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`;
const pct = (x, d = 0) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);
const r = (x) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** The report as Markdown (for the console and the weekly archive). */
export function reportMarkdown(summaries, now = Date.now()) {
  const L = [];
  const p = (s = "") => L.push(s);
  p(`# Trading bots: weekly report`);
  p();
  p(`${new Date(now).toISOString().slice(0, 16).replace("T", " ")} UTC. "This week" = the last 7 days. R = result in units of the risk taken.`);
  p();
  p(`| Bot | Mode | Equity (pot) | This week | Trades (week / total) | Win rate | Avg per trade | Worst drop | Review |`);
  p(`|---|---|---|---|---|---|---|---|---|`);
  for (const s of summaries) {
    if (!s.running) { p(`| ${s.label} | ${s.mode.toUpperCase()} | not running | | | | | | |`); continue; }
    p(`| ${s.label} | ${s.mode.toUpperCase()} | ${money(s.equity)} (${money(s.pot)}) | ${money(s.pnlThisWeek)} | ${s.tradesThisWeek} / ${s.trades} | ${pct(s.winRate)} | ${r(s.avgR)} | ${pct(s.maxDrawdown)} | ${s.trades}/${REVIEW_TRADES} |`);
  }
  for (const s of summaries.filter((x) => x.running)) {
    const e = EXPECTED[s.key];
    p();
    p(`## ${s.label} (${s.mode})`);
    p();
    p(`- **${s.verdict}**`);
    p(`- Equity ${money(s.equity)} from a ${money(s.pot)} pot (realized ${money(s.realized)}), worst drop ${pct(s.maxDrawdown, 1)}${s.killed ? ", KILL SWITCH ON" : ""}${s.halted ? ", halted for today" : ""}. Next trade risks ${pct(s.nextRisk, 2)}.`);
    p(`- Trades: ${s.trades} (${s.tradesThisWeek} this week). Win rate ${pct(s.winRate)}${e ? ` (backtest ~${pct(e.winRate)})` : ""}, average ${r(s.avgR)}${e ? ` (backtest ~${r(e.avgR)})` : ""}, total ${r(s.totalR)}, best ${r(s.bestR)}, worst ${r(s.worstR)}.`);
    if (s.avgHoldHours != null) p(`- Average hold ${s.avgHoldHours < 48 ? `${s.avgHoldHours.toFixed(0)} hours` : `${(s.avgHoldHours / 24).toFixed(1)} days`}. Exits: ${Object.entries(s.exits).map(([k, v]) => `${k} ${v}`).join(", ") || "none yet"}.`);
    p(`- Limit entries filled: ${pct(s.fillRate)}${s.missed ? ` (${s.missed} expired unfilled)` : ""}. The backtest assumes nearly all fill; much below 80% means it's too optimistic.`);
    const probs = Object.entries(s.problems);
    p(`- Problems this week: ${probs.length ? probs.map(([k, v]) => `${v} ${k}`).join("; ") : "none"}.`);
    if (s.open.length) {
      p(`- Open now: ${s.open.map((o) => `${o.side} ${o.symbol} from ${o.entryPrice}, stop ${o.stopPrice}${o.targetPrice ? `, target ${o.targetPrice}` : ""}, ${money(o.unrealizedPnl)} open P&L`).join("; ")}.`);
    }
    if (e && s.started) {
      const weeks = Math.max(1, (now - Date.parse(s.started)) / (7 * DAY));
      p(`- Pace: ${(s.trades / weeks).toFixed(1)} trades a week (backtest ~${e.perWeek}).`);
    }
  }
  // Live vs demo for the same strategy.
  const pairs = summaries.filter((s) => s.mode === "live" && s.running).map((l) => [l, summaries.find((d) => d.key === l.key && d.mode === "demo" && d.running)]).filter(([, d]) => d);
  if (pairs.length) {
    p();
    p(`## Live vs demo`);
    p();
    p(`| Strategy | Live trades / avg | Demo trades / avg | Live fill rate | Demo fill rate |`);
    p(`|---|---|---|---|---|`);
    for (const [l, d] of pairs) p(`| ${l.label} | ${l.trades} / ${r(l.avgR)} | ${d.trades} / ${r(d.avgR)} | ${pct(l.fillRate)} | ${pct(d.fillRate)} |`);
  }
  p();
  p(`Review rule: at ${REVIEW_TRADES} trades, keep a bot averaging +0.20R or better, retire one below 0, keep testing in between. Stop early if a pot falls 20%+ below its peak.`);
  return L.join("\n") + "\n";
}

/** The report as a small standalone HTML page (for the dashboard). */
export function reportHtml(markdown) {
  const lines = markdown.split("\n");
  const out = [];
  let inTable = false, inList = false;
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const close = () => { if (inTable) { out.push("</tbody></table></div>"); inTable = false; } if (inList) { out.push("</ul>"); inList = false; } };
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (line.startsWith("|")) {
      const cells = line.slice(1, -1).split("|").map((c) => c.trim());
      if (lines[k + 1]?.startsWith("|---")) { close(); out.push(`<div class="scroll"><table><thead><tr>${cells.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>`); inTable = true; k++; continue; }
      out.push(`<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`);
      continue;
    }
    if (line.startsWith("- ")) { if (inTable) close(); if (!inList) { out.push("<ul>"); inList = true; } out.push(`<li>${inline(line.slice(2))}</li>`); continue; }
    close();
    if (line.startsWith("## ")) out.push(`<h2>${inline(line.slice(3))}</h2>`);
    else if (line.startsWith("# ")) out.push(`<h1>${inline(line.slice(2))}</h1>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  close();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Weekly report</title>
<style>
:root{--bg:#0f1115;--fg:#e8eaed;--muted:#9aa0a6;--line:#2a2f37;--card:#161a20}
@media (prefers-color-scheme: light){:root{--bg:#f7f7f8;--fg:#1d1f23;--muted:#5f6368;--line:#dadce0;--card:#fff}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1000px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:8px 0}h2{font-size:17px;margin:24px 0 6px}p,li{color:var(--fg)}p:first-of-type{color:var(--muted)}
.scroll{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{color:var(--muted);font-weight:600}a{color:inherit}
</style></head><body><main><p><a href="/">← Dashboard</a></p>${out.join("\n")}</main></body></html>`;
}

import { useMemo, useState } from "react";
import { Card, type CardState } from "../components/Card";
import { Modal } from "../components/Modal";
import { Sparkline } from "../components/Sparkline";
import { SLOT_LABELS, dashboardConfig } from "../config/dashboard";
import { TRADE_WINDOW_DAYS, RECENT_OUTCOMES, freshness, ms, outcome, rMultiple, tradeStats } from "../lib/derive";
import { fmtDateTime, fmtDay, pct, signedMoney, signedR } from "../lib/format";
import type { DashboardData, SlotId, StrategyDisplayConfig } from "../types";

const OUTCOME_LABEL = { win: "Win", loss: "Loss", breakeven: "Breakeven" } as const;

export function TradesCard({ data, state, error, onRetry, now, strategies }: {
  data?: DashboardData;
  state: CardState;
  error?: string;
  onRetry: () => void;
  now: number;
  strategies: Record<SlotId, StrategyDisplayConfig>;
}) {
  const [expanded, setExpanded] = useState(false);
  const tz = dashboardConfig.displayTimezone;
  const stats = useMemo(() => data && tradeStats(data.trades.items, now, tz), [data, now, tz]);
  const slotName = (slot?: SlotId) => (slot ? strategies[slot].name || SLOT_LABELS[slot] : "—");
  const scope = stats ? `Closed trades since ${fmtDay(stats.windowStart)} (last ${TRADE_WINDOW_DAYS} days, ${tz}). Open trades aren't counted.` : "";

  return (
    <>
      <Card
        id="trades"
        title="Trades"
        className="card--trades area-trades"
        headExtra={stats && <span title={`Entries per day, last ${TRADE_WINDOW_DAYS} days`}><Sparkline values={stats.dailyEntries} /></span>}
        stale={data && freshness(data.trades.asOf, now, "trades")}
        state={state}
        error={error}
        onRetry={onRetry}
        onExpand={() => setExpanded(true)}
      >
        {stats && (
          <>
            <div className="trades-count">
              <strong>{stats.entriesToday}</strong>
              <span>entries today</span>
            </div>
            {stats.recent.length === 0 ? (
              <p className="muted small">No closed trades in the last {TRADE_WINDOW_DAYS} days.</p>
            ) : (
              <ul className="outcomes" aria-label={`Last ${stats.recent.length} closed trades, oldest first`} title={scope}>
                {stats.recent.map((t) => {
                  const o = outcome(t)!;
                  const text = `${t.symbol}, closed ${fmtDateTime(t.closedAt!)}: ${OUTCOME_LABEL[o]} ${signedMoney(t.realizedPnl!)}`;
                  return <li key={t.id} className={`outcome outcome--${o}`} title={text} aria-label={text} />;
                })}
              </ul>
            )}
            <dl className="mini-stats" title={scope}>
              <div><dt>Win rate</dt><dd>{stats.winRate === null ? "—" : pct(stats.winRate * 100, 0)}</dd></div>
              <div>
                <dt>Avg R</dt>
                <dd title={stats.avgR === null ? "Unavailable: no closed trade reported its initial risk" : stats.rCount < stats.closedCount ? `Based on ${stats.rCount} of ${stats.closedCount} trades that reported initial risk` : undefined}>
                  {stats.avgR === null ? "n/a" : signedR(stats.avgR)}
                </dd>
              </div>
              <div><dt>Closed</dt><dd>{stats.closedCount}</dd></div>
            </dl>
          </>
        )}
      </Card>

      {expanded && stats && data && (
        <Modal title="Trades" subtitle={scope} onClose={() => setExpanded(false)} wide>
          <dl className="mini-stats mini-stats--wide">
            <div><dt>Entries today</dt><dd>{stats.entriesToday}</dd></div>
            <div><dt>Open</dt><dd>{stats.openCount}</dd></div>
            <div><dt>Wins / losses / breakeven</dt><dd>{stats.win} / {stats.loss} / {stats.breakeven}</dd></div>
            <div><dt>Win rate</dt><dd>{stats.winRate === null ? "—" : pct(stats.winRate * 100, 0)}</dd></div>
            <div><dt>Avg R</dt><dd>{stats.avgR === null ? "n/a" : `${signedR(stats.avgR)} (${stats.rCount} of ${stats.closedCount})`}</dd></div>
          </dl>
          <p className="muted small">
            Win rate = wins ÷ closed trades. R = realized P&amp;L ÷ initial risk; trades without initial risk are left out of Avg R.
            Breakeven = P&amp;L rounds to 0.00. The outcome grid shows the last {RECENT_OUTCOMES} closed trades.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>Symbol</th><th>Strategy</th><th>Side</th><th>Opened</th><th>Closed</th><th className="num">P&amp;L ({data.currency})</th><th className="num">R</th></tr>
              </thead>
              <tbody>
                {[...data.trades.items].sort((a, b) => ms(b.closedAt ?? b.openedAt) - ms(a.closedAt ?? a.openedAt)).map((t) => {
                  const r = rMultiple(t);
                  const o = outcome(t);
                  return (
                    <tr key={t.id}>
                      <td>{t.symbol}</td>
                      <td>{slotName(t.slot)}</td>
                      <td>{t.side === "long" ? "Long" : "Short"}</td>
                      <td>{fmtDateTime(t.openedAt)}</td>
                      <td>{t.closedAt ? fmtDateTime(t.closedAt) : <span className="badge">Open</span>}</td>
                      <td className={`num ${o === "win" ? "up" : o === "loss" ? "down" : ""}`}>{t.realizedPnl === undefined ? "—" : signedMoney(t.realizedPnl)}</td>
                      <td className="num">{r === null ? "—" : signedR(r)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </>
  );
}

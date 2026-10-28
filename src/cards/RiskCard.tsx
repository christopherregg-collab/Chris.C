import { useMemo, useState } from "react";
import { Card, type CardState } from "../components/Card";
import { Gauge } from "../components/Gauge";
import { Modal } from "../components/Modal";
import { dashboardConfig } from "../config/dashboard";
import { RISK_DANGER, RISK_WARN, freshness, riskLevel, riskUsage, tradeStats } from "../lib/derive";
import { fmtDateTime, fmtTime, money, signedMoney, tzLabel } from "../lib/format";
import type { DashboardData } from "../types";

const DEFINITION =
  "Cap usage = today's net realized loss ÷ daily loss cap. Today runs from midnight in the display time zone. A profitable day uses none of the cap; open positions aren't counted.";

function CapBar({ usage }: { usage: number | null }) {
  const filled = usage === null ? 0 : Math.min(usage, 1) * 100;
  const level = usage === null ? "none" : riskLevel(usage);
  return (
    <div className="capbar">
      <div className="capbar-head"><span>Today vs cap</span><span>{usage === null ? "—" : `${Math.round(usage * 100)}%`}</span></div>
      <div className={`capbar-track capbar--${level}`} role="img" aria-label={usage === null ? "No cap configured" : `Today's loss is ${Math.round(usage * 100)}% of the cap`}>
        <span className="capbar-fill" style={{ width: `${filled}%` }} />
        <span className="capbar-tick" style={{ left: `${RISK_WARN * 100}%` }} title={`Warning at ${RISK_WARN * 100}%`} />
        <span className="capbar-tick" style={{ left: `${RISK_DANGER * 100}%` }} title={`Danger at ${RISK_DANGER * 100}%`} />
      </div>
      <div className="capbar-scale" aria-hidden="true">
        <span style={{ left: `${RISK_WARN * 100}%` }}>{RISK_WARN * 100}%</span>
        <span style={{ left: `${RISK_DANGER * 100}%` }}>{RISK_DANGER * 100}%</span>
      </div>
    </div>
  );
}

export function RiskCard({ data, state, error, onRetry, now }: {
  data?: DashboardData;
  state: CardState;
  error?: string;
  onRetry: () => void;
  now: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const tz = dashboardConfig.displayTimezone;
  const risk = useMemo(() => data && riskUsage(data.risk, data.trades.items, now, tz), [data, now, tz]);
  const streak = useMemo(() => data && tradeStats(data.trades.items, now, tz).streak, [data, now, tz]);
  const currency = data?.currency ?? dashboardConfig.reportingCurrency;

  return (
    <>
      <Card
        id="risk"
        title="Risk"
        className="area-risk"
        stale={data && freshness(data.risk.asOf, now, "risk")}
        state={state}
        error={error}
        onRetry={onRetry}
        onExpand={() => setExpanded(true)}
      >
        {risk && (
          <div className="risk" title={DEFINITION}>
            <div className="risk-top">
              <Gauge usage={risk.usage} />
              {risk.cap === null ? (
                <div className="risk-info">
                  <strong>Set risk cap</strong>
                  <span>Add a daily loss limit in your bot to track usage.</span>
                </div>
              ) : (
                <dl className="risk-info">
                  <div><dt>Cap</dt><dd>{money(risk.cap)}</dd></div>
                  <div><dt>Scope</dt><dd>Daily realized loss</dd></div>
                  <div><dt>Resets</dt><dd>{fmtTime(risk.resetsAt)} {tzLabel()}</dd></div>
                </dl>
              )}
            </div>
            <CapBar usage={risk.usage} />
            {streak && <span className={`streak streak--${streak.kind}`}>{streak.length} {streak.kind === "win" ? "wins" : "losses"} in a row</span>}
          </div>
        )}
      </Card>

      {expanded && risk && (
        <Modal title="Risk" subtitle={data && `As of ${fmtDateTime(data.risk.asOf)}`} onClose={() => setExpanded(false)}>
          <div className="risk-expanded">
            <Gauge usage={risk.usage} size={120} />
            <dl className="mini-stats mini-stats--wide">
              <div><dt>Daily loss cap</dt><dd>{risk.cap === null ? "Not set" : `${money(risk.cap)} ${currency}`}</dd></div>
              <div><dt>Realized today</dt><dd>{signedMoney(risk.realizedToday)} {currency}</dd></div>
              <div><dt>Loss counted</dt><dd>{money(risk.lossUsed)} {currency}</dd></div>
              <div><dt>Resets</dt><dd>{fmtDateTime(risk.resetsAt)}</dd></div>
            </dl>
          </div>
          <CapBar usage={risk.usage} />
          <h3>Definition</h3>
          <p>{DEFINITION}</p>
          <p className="muted small">
            Thresholds: amber from {RISK_WARN * 100}%, red from {RISK_DANGER * 100}%. This card only displays the bot's risk settings;
            it can't change limits, leverage or sizing.
          </p>
        </Modal>
      )}
    </>
  );
}

import { useMemo, useState } from "react";
import { AreaChart } from "../components/AreaChart";
import { Card, type CardState } from "../components/Card";
import { Modal } from "../components/Modal";
import { dashboardConfig } from "../config/dashboard";
import {
  PERIODS, chartSeries, freshness, ms, pnlSince, startOfDay, type Metric, type Period,
} from "../lib/derive";
import { fmtDateTime, money, signedMoney, signedPct } from "../lib/format";
import type { DashboardData } from "../types";

const METRICS: { id: Metric; label: string }[] = [
  { id: "equity", label: "Equity" },
  { id: "return", label: "Trading return" },
];

function Pills<T extends string>({ label, options, value, onChange }: {
  label: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="pills" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" className="pill" aria-pressed={o.id === value} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const tone = (n: number) => (n > 0 ? "up" : n < 0 ? "down" : "");

export function PerformanceCard({ data, state, error, onRetry, now }: {
  data?: DashboardData;
  state: CardState;
  error?: string;
  onRetry: () => void;
  now: number;
}) {
  const [period, setPeriod] = useState<Period>("1W");
  const [metric, setMetric] = useState<Metric>("equity");
  const [expanded, setExpanded] = useState(false);
  const tz = dashboardConfig.displayTimezone;

  const view = useMemo(() => {
    if (!data) return null;
    const { performance: perf, account } = data;
    const asOfMs = ms(perf.asOf);
    return {
      today: pnlSince(perf.points, startOfDay(asOfMs, tz)),
      sinceBase: pnlSince(perf.points, ms(perf.baseline.t)),
      account,
      perf,
      returnUnavailable: metric === "return" && !perf.cashFlowsReported,
      series: chartSeries(perf.points, period, metric, asOfMs),
      seriesFull: chartSeries(perf.points, period, metric, asOfMs, 400),
    };
  }, [data, period, metric, tz]);

  const stale = data && freshness(data.account.asOf, now, "account");
  const currency = data?.currency ?? dashboardConfig.reportingCurrency;
  const periodPills = <Pills label="Chart period" options={PERIODS.map((p) => ({ id: p, label: p }))} value={period} onChange={setPeriod} />;
  const metricPills = <Pills label="Chart metric" options={METRICS} value={metric} onChange={setMetric} />;

  const chart = (full: boolean) =>
    view && (view.returnUnavailable ? (
      <div className="chart chart--empty" role="status">
        Trading return is unavailable: this data source doesn't report deposits and withdrawals, so return can't be separated from them.
      </div>
    ) : view.perf.points.length < 2 ? (
      <div className="chart chart--empty" role="status">Not enough history to chart yet.</div>
    ) : (
      <AreaChart
        points={full ? view.seriesFull : view.series}
        metric={metric}
        period={period}
        currency={currency}
        label={`${metric === "equity" ? "Equity" : "Trading return"}, ${period}`}
      />
    ));

  return (
    <>
      <Card
        id="performance"
        title="Performance"
        className="card--performance area-perf"
        stale={stale}
        state={state}
        error={error}
        onRetry={onRetry}
        headRight={state === "ready" ? periodPills : undefined}
        onExpand={() => setExpanded(true)}
      >
        {view && (
          <>
            <div className="perf-summary">
              <div className="perf-equity">
                <span className="label">Equity</span>
                <span className="hero">
                  {money(view.account.equity)} <small>{currency}</small>
                </span>
              </div>
              <dl className="perf-stats">
                <div>
                  <dt>Today</dt>
                  <dd className={view.today ? tone(view.today.pnl) : ""}>
                    {view.today ? <>{signedMoney(view.today.pnl)} <span>{signedPct(view.today.pct)}</span></> : "—"}
                  </dd>
                </div>
                <div>
                  <dt title={`Trading P&L since ${fmtDateTime(view.perf.baseline.t)}, excluding deposits and withdrawals`}>
                    {view.perf.baseline.label}
                  </dt>
                  <dd className={view.sinceBase ? tone(view.sinceBase.pnl) : ""}>
                    {view.sinceBase ? <>{signedMoney(view.sinceBase.pnl)} <span>{signedPct(view.sinceBase.pct)}</span></> : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Available</dt>
                  <dd>{money(view.account.available)}</dd>
                </div>
              </dl>
            </div>
            {metricPills}
            {chart(false)}
            <p className="footnote">
              {currency}. Equity includes open P&amp;L, deposits and withdrawals. Trading return and P&amp;L exclude
              deposits and withdrawals.{" "}
              <span className="nowrap"><span className="key key--deposit" aria-hidden="true" /> Deposit</span>{" "}
              <span className="nowrap"><span className="key key--withdrawal" aria-hidden="true" /> Withdrawal</span>
            </p>
          </>
        )}
      </Card>

      {expanded && view && (
        <Modal title="Performance" subtitle={`As of ${fmtDateTime(view.perf.asOf)}`} onClose={() => setExpanded(false)} wide>
          <div className="modal-controls">
            {periodPills}
            {metricPills}
          </div>
          <div className="modal-chart card--performance">{chart(true)}</div>
          <h3>How these are calculated</h3>
          <ul className="defs">
            <li><strong>Equity</strong>: account balance plus unrealized P&amp;L, as reported by the source.</li>
            <li>
              <strong>Today / {view.perf.baseline.label}</strong>: change in equity minus net deposits and withdrawals since the
              start of today ({tz}) or since {fmtDateTime(view.perf.baseline.t)}. The percentage is the time-weighted return over
              the same span.
            </li>
            <li>
              <strong>Trading return</strong>: time-weighted. Each interval's return is (equity − cash flow) ÷ previous equity − 1,
              chained across the period, so deposits and withdrawals don't count as gains or losses.
            </li>
          </ul>
          {!view.returnUnavailable && (
            <details className="table-view">
              <summary>Data table ({view.series.length} points)</summary>
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Time</th><th>{metric === "equity" ? `Equity (${currency})` : "Trading return"}</th><th>Cash flow</th></tr></thead>
                  <tbody>
                    {[...view.series].reverse().map((p) => (
                      <tr key={p.t}>
                        <td>{fmtDateTime(p.t)}</td>
                        <td className="num">{metric === "equity" ? money(p.value) : signedPct(p.value)}</td>
                        <td className="num">{p.cashFlow ? signedMoney(p.cashFlow) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </Modal>
      )}
    </>
  );
}

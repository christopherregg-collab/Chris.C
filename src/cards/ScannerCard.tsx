import { useState } from "react";
import { Card, StatusDot, type CardState } from "../components/Card";
import { Modal } from "../components/Modal";
import { SLOT_LABELS } from "../config/dashboard";
import { freshness, ms } from "../lib/derive";
import { ago, fmtDateTime } from "../lib/format";
import type { DashboardData, SlotId, StrategyDisplayConfig } from "../types";

const PREVIEW = 4;

export function ScannerCard({ data, state, error, onRetry, now, strategies }: {
  data?: DashboardData;
  state: CardState;
  error?: string;
  onRetry: () => void;
  now: number;
  strategies: Record<SlotId, StrategyDisplayConfig>;
}) {
  const [expanded, setExpanded] = useState(false);
  const scanner = data?.scanner;
  const candidates = scanner?.candidates ?? [];
  const slotName = (slot?: SlotId) => (slot ? strategies[slot].name || SLOT_LABELS[slot] : undefined);
  const hasScore = candidates.some((c) => c.score !== undefined);

  return (
    <>
      <Card
        id="scanner"
        title="Scanner"
        className="area-scanner"
        stale={scanner && freshness(scanner.asOf, now, "scanner")}
        state={state}
        error={error}
        onRetry={onRetry}
        onExpand={() => setExpanded(true)}
      >
        {candidates.length === 0 ? (
          <div className="quiet">
            <div className="strat-status"><StatusDot tone="idle" /><span className="strat-status-label">Quiet market</span></div>
            <p className="strat-sentence">The scanner hasn't flagged any candidates right now.</p>
          </div>
        ) : (
          <ol className="candidates">
            {candidates.slice(0, PREVIEW).map((c) => (
              <li key={`${c.symbol}-${c.slot ?? ""}`}>
                <div className="cand-top">
                  <span className="cand-symbol" title={c.symbol}>{c.symbol}</span>
                  {c.score !== undefined && <span className="cand-score">{c.score}</span>}
                </div>
                <div className="cand-meta">
                  <span title={c.signal}>{c.signal}</span>
                  <span>{ago(ms(c.updatedAt), now)}</span>
                </div>
                {slotName(c.slot) && <div className="cand-strat" title={slotName(c.slot)}>{slotName(c.slot)}</div>}
              </li>
            ))}
            {candidates.length > PREVIEW && <li className="more">+{candidates.length - PREVIEW} more</li>}
          </ol>
        )}
      </Card>

      {expanded && scanner && (
        <Modal title="Scanner" subtitle={`As of ${fmtDateTime(scanner.asOf)}`} onClose={() => setExpanded(false)} wide>
          <h3>Criteria</h3>
          <p className={scanner.criteria ? "" : "muted"}>{scanner.criteria ?? "The data source didn't report its scanner criteria."}</p>
          <h3>Candidates</h3>
          {candidates.length === 0 ? (
            <p className="muted">Quiet market: no candidates right now.</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>#</th><th>Symbol</th><th>Strategy</th><th>Signal</th>{hasScore && <th className="num">Score</th>}<th>Updated</th></tr>
                </thead>
                <tbody>
                  {candidates.map((c, i) => (
                    <tr key={`${c.symbol}-${c.slot ?? ""}`}>
                      <td>{i + 1}</td>
                      <td>{c.symbol}</td>
                      <td>{slotName(c.slot) ?? "—"}</td>
                      <td>{c.signal}</td>
                      {hasScore && <td className="num">{c.score ?? "—"}</td>}
                      <td>{fmtDateTime(c.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">Order is as ranked by the source. A score is shown only when the integration provides one.</p>
        </Modal>
      )}
    </>
  );
}

import { useState, type FormEvent } from "react";
import { Card, StatusDot, type CardState } from "../components/Card";
import { ChevronDown } from "../components/Icons";
import { Modal } from "../components/Modal";
import { SLOT_LABELS } from "../config/dashboard";
import { isConfigured } from "../hooks/useStrategies";
import { freshness, positionReturnPct, stopToTargetProgress } from "../lib/derive";
import { fmtDateTime, price, signedMoney, signedPct } from "../lib/format";
import type { Position, SlotId, StrategyDisplayConfig, StrategyRuntime, StrategyStatus } from "../types";

const STATUS: Record<StrategyStatus | "none", { label: string; tone: "ok" | "info" | "idle" | "warn" | "error" | "none"; sentence: string }> = {
  none: { label: "Not configured", tone: "none", sentence: "The bot isn't reporting a strategy in this slot." },
  flat: { label: "Flat", tone: "idle", sentence: "No open positions." },
  watching: { label: "Watching", tone: "info", sentence: "Looking for an entry." },
  in_position: { label: "In position", tone: "ok", sentence: "Managing open positions." },
  paused: { label: "Paused", tone: "warn", sentence: "Paused; not opening new positions." },
  error: { label: "Error", tone: "error", sentence: "The bot reported an error for this strategy." },
};

const tone = (n: number) => (n > 0 ? "up" : n < 0 ? "down" : "");

function StopTargetBar({ p }: { p: Position }) {
  const progress = stopToTargetProgress(p);
  if (progress === null) return <p className="tile-note">No stop/target reported</p>;
  const at = Math.min(Math.max(progress, 0), 1) * 100;
  const desc = progress <= 0 ? "at or past the stop" : progress >= 1 ? "at or past the target" : `${Math.round(at)}% of the way from stop to target`;
  return (
    <div className="stt" role="img" aria-label={`Price is ${desc}`}>
      <div className="stt-track"><span className="stt-marker" style={{ left: `${at}%` }} /></div>
      <div className="stt-labels"><span>Stop</span><span>Target</span></div>
    </div>
  );
}

function PositionTile({ p, currency }: { p: Position; currency: string }) {
  const [open, setOpen] = useState(false);
  const ret = positionReturnPct(p);
  return (
    <li className="tile">
      <button type="button" className="tile-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="tile-symbol" title={p.symbol}>{p.symbol}</span>
        <span className={`side side--${p.side}`}>{p.side === "long" ? "Long" : "Short"}</span>
        <span className={`tile-pnl ${tone(p.unrealizedPnl)}`}>
          {signedMoney(p.unrealizedPnl)} <span>{signedPct(ret)}</span>
        </span>
        <ChevronDown className="tile-chevron" width={14} height={14} />
      </button>
      <StopTargetBar p={p} />
      {open && (
        <dl className="tile-details">
          <div><dt>Entry</dt><dd>{price(p.entryPrice)}</dd></div>
          <div><dt>Mark</dt><dd>{price(p.markPrice)}</dd></div>
          <div><dt>Size</dt><dd>{p.size}</dd></div>
          {p.leverage !== undefined && <div><dt>Leverage</dt><dd>{p.leverage}×</dd></div>}
          {p.stopPrice !== undefined && <div><dt>Stop</dt><dd>{price(p.stopPrice)}</dd></div>}
          {p.targetPrice !== undefined && <div><dt>Target</dt><dd>{price(p.targetPrice)}</dd></div>}
          <div className="wide"><dt>Opened</dt><dd>{fmtDateTime(p.openedAt)}</dd></div>
          <div className="wide"><dt>Unrealized</dt><dd>{signedMoney(p.unrealizedPnl)} {currency}, {signedPct(ret)} of margin</dd></div>
        </dl>
      )}
    </li>
  );
}

function StrategyForm({ slot, config, onSave, onCancel }: {
  slot: SlotId;
  config: StrategyDisplayConfig;
  onSave: (c: StrategyDisplayConfig) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState({ ...config, symbols: config.symbols.join(", ") });
  const set = (k: keyof typeof draft) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave({
      name: draft.name.trim(),
      description: draft.description.trim(),
      timeframe: draft.timeframe.trim(),
      symbols: draft.symbols.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean),
      notes: draft.notes.trim(),
    });
  };
  const id = (k: string) => `${slot}-${k}`;
  return (
    <form className="form" onSubmit={submit}>
      <p className="form-note">
        Display only. These details label this slot on the dashboard and are saved in this browser. Saving does not start,
        stop or change a strategy. Don't enter API keys here.
      </p>
      <label htmlFor={id("name")}>Name</label>
      <input id={id("name")} value={draft.name} onChange={set("name")} placeholder={SLOT_LABELS[slot]} maxLength={40} />
      <label htmlFor={id("desc")}>Description</label>
      <input id={id("desc")} value={draft.description} onChange={set("description")} placeholder="One line about what it does" maxLength={120} />
      <div className="form-row">
        <div>
          <label htmlFor={id("tf")}>Timeframe</label>
          <input id={id("tf")} value={draft.timeframe} onChange={set("timeframe")} placeholder="e.g. 4h" maxLength={12} />
        </div>
        <div>
          <label htmlFor={id("sym")}>Symbols</label>
          <input id={id("sym")} value={draft.symbols} onChange={set("symbols")} placeholder="BTC-USDT, ETH-USDT" />
        </div>
      </div>
      <label htmlFor={id("notes")}>Rules or notes</label>
      <textarea id={id("notes")} value={draft.notes} onChange={set("notes")} rows={4} placeholder="Notes for yourself. These don't execute." />
      <div className="form-actions">
        <button type="button" className="pill" onClick={onCancel}>Cancel</button>
        <button type="submit" className="pill pill--primary">Save</button>
      </div>
    </form>
  );
}

export function StrategyCard({ slot, runtime, config, onSave, featured = false, state, error, onRetry, now, currency }: {
  slot: SlotId;
  runtime?: StrategyRuntime;
  config: StrategyDisplayConfig;
  onSave: (slot: SlotId, c: StrategyDisplayConfig) => void;
  featured?: boolean;
  state: CardState;
  error?: string;
  onRetry: () => void;
  now: number;
  currency: string;
}) {
  const [modal, setModal] = useState<"expand" | "edit" | null>(null);
  const name = config.name || SLOT_LABELS[slot];
  const status = STATUS[runtime?.status ?? "none"];
  const positions = runtime?.positions ?? [];
  const configured = isConfigured(config);
  const sentence = runtime
    ? runtime.message ?? status.sentence
    : configured
      ? "Saved for display. The bot isn't reporting this strategy yet."
      : status.sentence;

  const meta = (
    <>
      {config.description && <p className="strat-desc">{config.description}</p>}
      {(config.timeframe || config.symbols.length > 0) && (
        <ul className="chips" aria-label="Timeframe and symbols">
          {config.timeframe && <li className="chip chip--tf">{config.timeframe}</li>}
          {config.symbols.map((s) => <li key={s} className="chip">{s}</li>)}
        </ul>
      )}
    </>
  );

  return (
    <>
      <Card
        id={slot}
        title={name}
        className={`card--strategy area-${slot}${featured ? " card--featured" : ""}`}
        headExtra={positions.length > 0 && <span className="count-pill" aria-label={`${positions.length} open positions`}>{positions.length}</span>}
        stale={runtime && freshness(runtime.asOf, now, "strategies")}
        state={state}
        error={error}
        onRetry={onRetry}
        onEdit={() => setModal("edit")}
        onExpand={() => setModal("expand")}
      >
        <div className="strat-status">
          <StatusDot tone={status.tone} />
          <span className="strat-status-label">{status.label}</span>
        </div>
        <p className="strat-sentence">{sentence}</p>
        {featured && meta}
        {positions.length > 0 ? (
          <ul className="tiles" aria-label={`${name} positions`}>
            {positions.map((p) => <PositionTile key={p.id} p={p} currency={currency} />)}
          </ul>
        ) : (
          <div className="empty">
            {!configured && !runtime ? (
              <button type="button" className="pill pill--ghost" onClick={() => setModal("edit")}>+ Add your strategy</button>
            ) : (
              <span>No open positions</span>
            )}
          </div>
        )}
      </Card>

      {modal === "edit" && (
        <Modal title={`${SLOT_LABELS[slot]} display settings`} onClose={() => setModal(null)}>
          <StrategyForm
            slot={slot}
            config={config}
            onCancel={() => setModal(null)}
            onSave={(c) => { onSave(slot, c); setModal(null); }}
          />
        </Modal>
      )}

      {modal === "expand" && (
        <Modal
          title={name}
          subtitle={<>{SLOT_LABELS[slot]} · <StatusDot tone={status.tone} /> {status.label}{runtime && <> · updated {fmtDateTime(runtime.asOf)}</>}</>}
          onClose={() => setModal(null)}
          wide
        >
          <p>{sentence}</p>
          {meta}
          {config.notes && (<><h3>Notes</h3><p className="pre">{config.notes}</p></>)}
          <h3>Positions</h3>
          {positions.length === 0 ? (
            <p className="muted">No open positions.</p>
          ) : (
            <ul className="tiles tiles--wide">
              {positions.map((p) => <PositionTile key={p.id} p={p} currency={currency} />)}
            </ul>
          )}
          <div className="form-actions">
            <button type="button" className="pill" onClick={() => setModal("edit")}>Edit display settings</button>
          </div>
        </Modal>
      )}
    </>
  );
}

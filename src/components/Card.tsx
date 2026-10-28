import type { ReactNode } from "react";
import { age } from "../lib/format";
import { EditIcon, ExpandIcon } from "./Icons";

export type CardState = "loading" | "error" | "ready";

/** Amber badge shown when a card's source hasn't updated within its threshold. */
export function StaleBadge({ ageSec }: { ageSec: number }) {
  return (
    <span className="badge badge--stale" title={`No update from this source for ${age(ageSec)}. Showing the last known values.`}>
      Stale · {age(ageSec)}
    </span>
  );
}

export function Card({
  id, title, className = "", headExtra, headRight, stale, onExpand, onEdit, state = "ready", error, onRetry, children,
}: {
  id: string;
  title: ReactNode;
  className?: string;
  headExtra?: ReactNode;
  headRight?: ReactNode;
  stale?: { stale: boolean; ageSec: number };
  onExpand?: () => void;
  onEdit?: () => void;
  state?: CardState;
  error?: string;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  const label = typeof title === "string" ? title : id;
  return (
    <section className={`card ${className}`} id={`card-${id}`} aria-label={label} data-card={id}>
      <header className="card-head">
        <div className="card-title">
          <h2>{title}</h2>
          {headExtra}
          {state === "ready" && stale?.stale && <StaleBadge ageSec={stale.ageSec} />}
        </div>
        <div className="card-actions">
          {headRight}
          {onEdit && (
            <button type="button" className="icon-btn icon-btn--sm" onClick={onEdit} aria-label={`Edit ${label} display settings`}>
              <EditIcon width={13} height={13} />
            </button>
          )}
          {onExpand && state === "ready" && (
            <button type="button" className="icon-btn icon-btn--sm" onClick={onExpand} aria-label={`Expand ${label}`}>
              <ExpandIcon width={13} height={13} />
            </button>
          )}
        </div>
      </header>
      <div className="card-body">
        {/* Narrow cards show staleness here instead of in the crowded header (see styles.css). */}
        {state === "ready" && stale?.stale && (
          <p className="stale-line" aria-hidden="true">
            <span className="dot dot--warn" /> Stale · last update {age(stale.ageSec)} ago
          </p>
        )}
        {state === "loading" && <Skeleton />}
        {state === "error" && (
          <div className="card-error" role="alert">
            <span className="dot dot--error" aria-hidden="true" />
            <p>{error ?? "Couldn't load this data."}</p>
            {onRetry && <button type="button" className="pill" onClick={onRetry}>Retry</button>}
          </div>
        )}
        {state === "ready" && children}
      </div>
    </section>
  );
}

function Skeleton() {
  return (
    <div className="skeleton" role="status" aria-label="Loading">
      <span /><span /><span />
    </div>
  );
}

export function StatusDot({ tone, label }: { tone: "ok" | "info" | "idle" | "warn" | "error" | "none"; label?: string }) {
  return <span className={`dot dot--${tone}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

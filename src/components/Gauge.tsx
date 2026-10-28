import { riskLevel } from "../lib/derive";

/** Circular cap-usage gauge. `usage` is a ratio (0.25 = 25%); null means no cap configured. */
export function Gauge({ usage, size = 90 }: { usage: number | null; size?: number }) {
  const stroke = 8;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const filled = usage === null ? 0 : Math.min(usage, 1);
  const level = usage === null ? "none" : riskLevel(usage);
  return (
    <div className={`gauge gauge--${level}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} className="gauge-track" strokeWidth={stroke} fill="none" />
        {filled > 0 && (
          <circle
            cx={size / 2} cy={size / 2} r={r} className="gauge-fill" strokeWidth={stroke} fill="none"
            strokeDasharray={`${filled * c} ${c}`} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <div className="gauge-label">
        {usage === null ? (
          <span className="gauge-none">No cap</span>
        ) : (
          <>
            <strong>{Math.round(usage * 100)}%</strong>
            <span>of cap</span>
          </>
        )}
      </div>
    </div>
  );
}

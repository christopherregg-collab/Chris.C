import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { ChartPoint, Metric, Period } from "../lib/derive";
import { compactMoney, fmtDateTime, fmtDay, fmtTime, fmtWeekday, money, signedMoney, signedPct } from "../lib/format";

const PAD = { top: 10, right: 10, bottom: 22, left: 46 };

function niceTicks(min: number, max: number, count = 4): number[] {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Math.round(v / step) * step);
  return ticks;
}

function xLabel(t: number, period: Period) {
  return period === "1D" ? fmtTime(t) : period === "1W" ? fmtWeekday(t) : fmtDay(t);
}

/**
 * Single-series area chart for the performance card. Mouse: hover shows a
 * crosshair. Touch: tap to inspect (a horizontal swipe still scrolls the
 * carousel, because the chart never captures or blocks pan gestures).
 * Keyboard: focus the chart and use ←/→, Esc to clear.
 */
export function AreaChart({ points, metric, period, currency, label }: {
  points: ChartPoint[];
  metric: Metric;
  period: Period;
  currency: string;
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      setSize({ w: Math.floor(width), h: Math.floor(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => setActive(null), [points]);

  const geo = useMemo(() => {
    const { w, h } = size;
    if (w < 40 || h < 40 || points.length < 2) return null;
    const values = points.map((p) => p.value);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (metric === "return") { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.05 || 1;
    const ticks = niceTicks(lo - pad, hi + pad);
    const y0 = Math.min(lo - pad, ticks[0]!);
    const y1 = Math.max(hi + pad, ticks[ticks.length - 1]!);
    const t0 = points[0]!.t;
    const t1 = points[points.length - 1]!.t;
    const iw = w - PAD.left - PAD.right;
    const ih = h - PAD.top - PAD.bottom;
    const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0 || 1)) * iw;
    const y = (v: number) => PAD.top + (1 - (v - y0) / (y1 - y0)) * ih;
    const xy = points.map((p) => [x(p.t), y(p.value)] as const);
    const line = xy.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
    const base = PAD.top + ih;
    const area = `${line}L${xy[xy.length - 1]![0].toFixed(1)},${base}L${xy[0]![0].toFixed(1)},${base}Z`;
    const tickCount = w < 360 ? 3 : 5;
    const xTicks = Array.from({ length: tickCount }, (_, i) => t0 + ((t1 - t0) * i) / (tickCount - 1));
    return { w, h, x, y, xy, line, area, ticks: ticks.filter((v) => v >= y0 && v <= y1), xTicks, base };
  }, [size, points, metric]);

  const nearest = (clientX: number) => {
    if (!geo) return null;
    const left = box.current!.getBoundingClientRect().left;
    const px = clientX - left;
    let best = 0;
    geo.xy.forEach(([x], i) => { if (Math.abs(x - px) < Math.abs(geo.xy[best]![0] - px)) best = i; });
    return best;
  };

  const onMove = (e: PointerEvent) => { if (e.pointerType === "mouse") setActive(nearest(e.clientX)); };
  const onUp = (e: PointerEvent) => { if (e.pointerType !== "mouse") setActive(nearest(e.clientX)); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const d = e.key === "ArrowRight" ? 1 : -1;
      setActive((a) => Math.max(0, Math.min(points.length - 1, (a ?? (d > 0 ? -1 : points.length)) + d)));
    } else if (e.key === "Escape" && active !== null) {
      e.stopPropagation();
      setActive(null);
    }
  };

  const fmtValue = (v: number) => (metric === "return" ? signedPct(v) : `${money(v)} ${currency}`);
  const fmtTick = (v: number) => (metric === "return" ? `${v.toFixed(Math.abs(v) < 10 ? 1 : 0)}%` : compactMoney(v));
  const sel = active !== null ? points[active] : undefined;
  const selXY = active !== null && geo ? geo.xy[active] : undefined;
  const first = points[0];
  const last = points[points.length - 1];

  return (
    <div
      ref={box}
      className="chart"
      tabIndex={0}
      role="img"
      aria-label={first && last ? `${label}: ${fmtValue(first.value)} to ${fmtValue(last.value)}. Use arrow keys to inspect points.` : label}
      onPointerMove={onMove}
      onPointerLeave={(e) => e.pointerType === "mouse" && setActive(null)}
      onPointerUp={onUp}
      onKeyDown={onKey}
      onBlur={() => setActive(null)}
    >
      {geo && (
        <svg width={geo.w} height={geo.h} aria-hidden="true">
          <defs>
            <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-line)" stopOpacity="0.26" />
              <stop offset="100%" stopColor="var(--chart-line)" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {geo.ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={geo.w - PAD.right} y1={geo.y(v)} y2={geo.y(v)} className={`grid${metric === "return" && v === 0 ? " grid--zero" : ""}`} />
              <text x={PAD.left - 8} y={geo.y(v)} className="axis" textAnchor="end" dominantBaseline="middle">{fmtTick(v)}</text>
            </g>
          ))}
          {geo.xTicks.map((t, i) => (
            <text key={t} x={geo.x(t)} y={geo.h - 6} className="axis" textAnchor={i === 0 ? "start" : i === geo.xTicks.length - 1 ? "end" : "middle"}>
              {xLabel(t, period)}
            </text>
          ))}
          <path d={geo.area} fill="url(#chart-fill)" />
          <path d={geo.line} className="chart-line" />
          {geo.xy.map(([x, y], i) => {
            const flow = points[i]!.cashFlow;
            if (flow !== 0) {
              return <circle key={i} cx={x} cy={y} r={4.5} className={flow > 0 ? "mark mark--deposit" : "mark mark--withdrawal"} />;
            }
            return <circle key={i} cx={x} cy={y} r={2.5} className="mark" />;
          })}
          {selXY && (
            <g>
              <line x1={selXY[0]} x2={selXY[0]} y1={PAD.top} y2={geo.base} className="crosshair" />
              <circle cx={selXY[0]} cy={selXY[1]} r={5} className="mark mark--active" />
            </g>
          )}
        </svg>
      )}
      {sel && selXY && geo && (
        <div
          className="chart-tip"
          style={{ left: Math.min(Math.max(selXY[0], 70), geo.w - 70), top: Math.max(selXY[1] - 12, 0) }}
          role="status"
        >
          <strong>{fmtValue(sel.value)}</strong>
          <span>{fmtDateTime(sel.t)}</span>
          {sel.cashFlow !== 0 && (
            <span>{sel.cashFlow > 0 ? "Deposit" : "Withdrawal"} {signedMoney(sel.cashFlow)} {currency}</span>
          )}
        </div>
      )}
    </div>
  );
}

// Every number a card shows that isn't read straight from the data model is
// computed here, so cards agree with each other. The definitions below are
// also what the cards' footnotes and tooltips describe.

import type { EquityPoint, Position, RiskData, Trade } from "../types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const ms = (iso: string) => Date.parse(iso);

// ---------------------------------------------------------------- time zones

/** Offset of `tz` from UTC at `atMs`, in ms (positive east of UTC). */
export function tzOffsetMs(atMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(atMs);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(atMs / 1000) * 1000;
}

/** Start of the calendar day containing `atMs` in `tz`. */
export function startOfDay(atMs: number, tz: string): number {
  const localMidnight = Math.floor((atMs + tzOffsetMs(atMs, tz)) / DAY) * DAY;
  // Re-read the offset at midnight itself so DST changes during the day don't shift it.
  return localMidnight - tzOffsetMs(localMidnight - tzOffsetMs(atMs, tz), tz);
}

// ---------------------------------------------------------------- freshness

/** How long each source may go without an update before its card is marked stale. */
export const STALE_AFTER_SEC = {
  health: 90,
  account: 120,
  performance: 600,
  strategies: 120,
  trades: 300,
  scanner: 300,
  risk: 300,
} as const;

export type Source = keyof typeof STALE_AFTER_SEC;

export function freshness(asOf: string, nowMs: number, source: Source) {
  const ageSec = Math.max(0, (nowMs - ms(asOf)) / 1000);
  return { ageSec, stale: ageSec > STALE_AFTER_SEC[source] };
}

// ---------------------------------------------------------------- performance

export type Period = "1D" | "1W" | "1M" | "ALL";
export const PERIODS: Period[] = ["1D", "1W", "1M", "ALL"];
const PERIOD_MS: Record<Exclude<Period, "ALL">, number> = { "1D": DAY, "1W": 7 * DAY, "1M": 30 * DAY };

export type Metric = "equity" | "return";

export interface ChartPoint {
  t: number;
  /** Equity, or cumulative trading return in percent, depending on the metric. */
  value: number;
  /** Net cash flow folded into this point (deposits +, withdrawals −). */
  cashFlow: number;
}

/**
 * The points inside `period`, plus the last point before it as the starting
 * reference, so a period's return is measured from where it began.
 */
export function pointsInPeriod(points: EquityPoint[], period: Period, nowMs: number): EquityPoint[] {
  if (period === "ALL") return points;
  const start = nowMs - PERIOD_MS[period];
  const first = points.findIndex((p) => ms(p.t) >= start);
  if (first === -1) return points.slice(-1);
  return points.slice(Math.max(0, first - 1));
}

/**
 * Cumulative time-weighted trading return, in percent, from the first point.
 *
 * Per interval: r = (E_i − CF_i) / E_{i−1} − 1, where CF_i is the net
 * deposit/withdrawal during the interval (treated as arriving at its end).
 * Intervals are chained: R = Π(1 + r) − 1. Deposits and withdrawals therefore
 * move equity but not return.
 */
export function tradingReturn(points: EquityPoint[]): number[] {
  const out: number[] = [];
  let growth = 1;
  points.forEach((p, i) => {
    if (i > 0) {
      const prev = points[i - 1]!.equity;
      if (prev > 0) growth *= (p.equity - p.cashFlow) / prev;
    }
    out.push((growth - 1) * 100);
  });
  return out;
}

/** Reduce to at most `max` points: the last point of each bucket, with the bucket's cash flows summed. */
export function downsample(points: ChartPoint[], max: number): ChartPoint[] {
  if (points.length <= max) return points;
  const first = points[0]!;
  const rest = points.slice(1);
  const size = Math.ceil(rest.length / (max - 1));
  const out: ChartPoint[] = [first];
  for (let i = 0; i < rest.length; i += size) {
    const bucket = rest.slice(i, i + size);
    const last = bucket[bucket.length - 1]!;
    out.push({ t: last.t, value: last.value, cashFlow: bucket.reduce((s, p) => s + p.cashFlow, 0) });
  }
  return out;
}

export function chartSeries(points: EquityPoint[], period: Period, metric: Metric, nowMs: number, max = 48): ChartPoint[] {
  const slice = pointsInPeriod(points, period, nowMs);
  const returns = metric === "return" ? tradingReturn(slice) : [];
  const full = slice.map((p, i) => ({
    t: ms(p.t),
    value: metric === "return" ? returns[i]! : p.equity,
    // The reference point's own flow happened before the period started.
    cashFlow: i === 0 && slice !== points ? 0 : p.cashFlow,
  }));
  return downsample(full, max);
}

/**
 * Trading P&L since `sinceMs`: equity change minus net cash flows, measured
 * from the last point at or before `sinceMs`. The percentage is the
 * time-weighted return over the same span, so a deposit can't inflate it.
 */
export function pnlSince(points: EquityPoint[], sinceMs: number) {
  if (points.length === 0) return null;
  let baseIndex = 0;
  for (let i = 0; i < points.length; i++) {
    if (ms(points[i]!.t) <= sinceMs) baseIndex = i; else break;
  }
  const slice = points.slice(baseIndex);
  const base = slice[0]!;
  const current = slice[slice.length - 1]!;
  const flows = slice.slice(1).reduce((s, p) => s + p.cashFlow, 0);
  const returns = tradingReturn(slice);
  return { pnl: current.equity - base.equity - flows, pct: returns[returns.length - 1]! };
}

// ---------------------------------------------------------------- positions

export function marginUsed(p: Position): number {
  return (p.entryPrice * p.size) / (p.leverage ?? 1);
}

/** Unrealized P&L as a percentage of the margin committed (of notional when unleveraged). */
export function positionReturnPct(p: Position): number {
  const margin = marginUsed(p);
  return margin > 0 ? (p.unrealizedPnl / margin) * 100 : 0;
}

/**
 * Where the mark price sits between stop (0) and target (1). Null when either
 * is missing. Not clamped, so callers can show "past target" / "past stop".
 */
export function stopToTargetProgress(p: Position): number | null {
  if (p.stopPrice === undefined || p.targetPrice === undefined) return null;
  const span = p.targetPrice - p.stopPrice;
  if (span === 0) return null;
  return (p.markPrice - p.stopPrice) / span;
}

// ---------------------------------------------------------------- trades

export const TRADE_WINDOW_DAYS = 7;
export const RECENT_OUTCOMES = 20;

export type Outcome = "win" | "loss" | "breakeven";

/** Result of a closed trade. P&L is rounded to cents first, so dust counts as breakeven. */
export function outcome(t: Trade): Outcome | null {
  if (!t.closedAt || t.realizedPnl === undefined) return null;
  const cents = Math.round(t.realizedPnl * 100);
  return cents > 0 ? "win" : cents < 0 ? "loss" : "breakeven";
}

export function rMultiple(t: Trade): number | null {
  if (t.realizedPnl === undefined || !t.initialRisk) return null;
  return t.realizedPnl / t.initialRisk;
}

export function tradeStats(trades: Trade[], nowMs: number, tz: string) {
  const windowStart = startOfDay(nowMs, tz) - (TRADE_WINDOW_DAYS - 1) * DAY;
  const today = startOfDay(nowMs, tz);

  const closed = trades
    .filter((t) => outcome(t) !== null && ms(t.closedAt!) >= windowStart && ms(t.closedAt!) <= nowMs)
    .sort((a, b) => ms(b.closedAt!) - ms(a.closedAt!));

  const counts = { win: 0, loss: 0, breakeven: 0 };
  for (const t of closed) counts[outcome(t)!]++;

  const rs = closed.map(rMultiple).filter((r): r is number => r !== null);

  // Entries per day over the window, oldest first. Includes trades still open.
  const dailyEntries = Array.from({ length: TRADE_WINDOW_DAYS }, (_, i) => {
    const from = windowStart + i * DAY;
    return trades.filter((t) => ms(t.openedAt) >= from && ms(t.openedAt) < from + DAY).length;
  });

  let streak: { kind: "win" | "loss"; length: number } | null = null;
  for (const t of closed) {
    const o = outcome(t)!;
    if (o === "breakeven") break;
    if (!streak) streak = { kind: o, length: 1 };
    else if (streak.kind === o) streak.length++;
    else break;
  }

  return {
    windowStart,
    closed,
    recent: closed.slice(0, RECENT_OUTCOMES).reverse(), // oldest → newest
    closedCount: closed.length,
    ...counts,
    winRate: closed.length ? counts.win / closed.length : null,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    rCount: rs.length,
    entriesToday: trades.filter((t) => ms(t.openedAt) >= today && ms(t.openedAt) <= nowMs).length,
    openCount: trades.filter((t) => !t.closedAt).length,
    dailyEntries,
    streak: streak && streak.length >= 2 ? streak : null,
  };
}

// ---------------------------------------------------------------- risk

export const RISK_WARN = 0.5;
export const RISK_DANGER = 0.8;

/**
 * Cap usage = today's net realized loss ÷ the daily loss cap.
 *
 * "Today" is the current calendar day in the display time zone; the cap resets
 * at its midnight. Net realized loss is the negative of the summed realized
 * P&L of trades closed today, floored at zero, so a profitable day uses none
 * of the cap. Unrealized P&L is not counted.
 */
export function riskUsage(risk: RiskData, trades: Trade[], nowMs: number, tz: string) {
  const dayStart = startOfDay(nowMs, tz);
  const realizedToday = trades
    .filter((t) => t.closedAt && t.realizedPnl !== undefined && ms(t.closedAt) >= dayStart && ms(t.closedAt) <= nowMs)
    .reduce((s, t) => s + t.realizedPnl!, 0);
  const lossUsed = Math.max(0, -realizedToday);
  const cap = risk.dailyLossCap && risk.dailyLossCap > 0 ? risk.dailyLossCap : null;
  return {
    cap,
    realizedToday,
    lossUsed,
    usage: cap === null ? null : lossUsed / cap,
    resetsAt: startOfDay(dayStart + DAY + HOUR, tz),
  };
}

export function riskLevel(usage: number): "ok" | "warn" | "danger" {
  return usage >= RISK_DANGER ? "danger" : usage >= RISK_WARN ? "warn" : "ok";
}

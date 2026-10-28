import { dashboardConfig } from "../config/dashboard";

const tz = dashboardConfig.displayTimezone;

const amount = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export const money = (n: number) => amount.format(n);
export const signedMoney = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + amount.format(Math.abs(n));
export const compactMoney = (n: number) => compact.format(n);

export const pct = (n: number, digits = 2) => `${n.toFixed(digits)}%`;
export const signedPct = (n: number, digits = 2) =>
  (n > 0 ? "+" : n < 0 ? "−" : "") + `${Math.abs(n).toFixed(digits)}%`;

/** Prices keep enough significant digits for low-priced coins. */
export function price(n: number): string {
  const digits = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
  return n.toLocaleString("en-US", { minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits });
}

export function signedR(r: number): string {
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toFixed(2)}R`;
}

const dateTime = new Intl.DateTimeFormat("en-US", {
  timeZone: tz, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const timeOnly = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayOnly = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" });
const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });

export const fmtDateTime = (t: number | string) => `${dateTime.format(new Date(t))} ${tzLabel()}`;
export const fmtTime = (t: number | string) => timeOnly.format(new Date(t));
export const fmtDay = (t: number | string) => dayOnly.format(new Date(t));
export const fmtWeekday = (t: number | string) => weekday.format(new Date(t));
export const tzLabel = () => (tz === "UTC" || tz === "Etc/UTC" ? "UTC" : tz);

export function ago(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Short age for badges: "12m", "3h". */
export function age(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 172_800) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86_400)}d`;
}

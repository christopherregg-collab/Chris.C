// The one data model every card reads. A data adapter (demo fixtures today,
// a server-side exchange integration later) produces a DashboardData; cards
// never talk to a data source directly.
//
// Timestamps are ISO-8601 strings in UTC. Every section carries `asOf`, the
// time its *source* produced it, which is what freshness badges are based on.

export type Iso = string;

export type SlotId = "featured" | "lower_1" | "lower_2" | "lower_3";
export const SLOTS: SlotId[] = ["featured", "lower_1", "lower_2", "lower_3"];

export type HealthStatus = "connected" | "no_heartbeat" | "disconnected";

export interface BotHealth {
  asOf: Iso;
  status: HealthStatus;
  lastSeen?: Iso;
  /** Only shown when the bot reports it. */
  readiness?: { ready: number; total: number };
}

export interface AccountSummary {
  asOf: Iso;
  /** Total equity: balance plus unrealized P&L, in the reporting currency. */
  equity: number;
  /** Balance not tied up as margin. */
  available: number;
}

export interface EquityPoint {
  t: Iso;
  /** Equity at `t`, including open P&L and any cash flow in this interval. */
  equity: number;
  /** Net deposit (+) or withdrawal (−) during the interval ending at `t`. */
  cashFlow: number;
}

export interface PerformanceData {
  asOf: Iso;
  /** Oldest first, evenly spaced (hourly in the demo). */
  points: EquityPoint[];
  /** "P&L since" reference point. */
  baseline: { label: string; t: Iso };
  /**
   * False when the source can't report cash flows, in which case a
   * trading-return series can't be separated from deposits and withdrawals
   * and the chart shows it as unavailable.
   */
  cashFlowsReported: boolean;
}

export type Side = "long" | "short";

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  /** Contract size in base units. */
  size: number;
  entryPrice: number;
  markPrice: number;
  leverage?: number;
  stopPrice?: number;
  targetPrice?: number;
  openedAt: Iso;
  unrealizedPnl: number;
}

/** What the bot reports a strategy is doing. Distinct from display config. */
export type StrategyStatus = "flat" | "watching" | "in_position" | "paused" | "error";

export interface StrategyRuntime {
  asOf: Iso;
  slot: SlotId;
  status: StrategyStatus;
  message?: string;
  positions: Position[];
}

export interface Trade {
  id: string;
  symbol: string;
  slot?: SlotId;
  side: Side;
  openedAt: Iso;
  /** Absent while the trade is still open. */
  closedAt?: Iso;
  realizedPnl?: number;
  /** Amount at risk at entry (entry-to-stop distance × size). Needed for R multiples. */
  initialRisk?: number;
}

export interface TradesData {
  asOf: Iso;
  /** Should cover at least the last 7 days. */
  items: Trade[];
}

export interface ScannerCandidate {
  symbol: string;
  slot?: SlotId;
  signal: string;
  updatedAt: Iso;
  /** Shown only when the integration defines a score. */
  score?: number;
}

export interface ScannerData {
  asOf: Iso;
  /** Human-readable description of what the scanner looks for, if configured. */
  criteria?: string;
  /** In the order the source ranks them. */
  candidates: ScannerCandidate[];
}

export interface RiskData {
  asOf: Iso;
  /** Daily realized-loss limit in the reporting currency. Unset = no cap configured. */
  dailyLossCap?: number;
}

export interface BotEvent {
  id: string;
  t: Iso;
  level: "info" | "success" | "warning" | "error";
  text: string;
}

export interface DashboardData {
  mode: "demo" | "live";
  currency: string;
  health: BotHealth;
  account: AccountSummary;
  performance: PerformanceData;
  strategies: StrategyRuntime[];
  trades: TradesData;
  scanner: ScannerData;
  risk: RiskData;
  events: BotEvent[];
}

/** Display-only description of a strategy slot. Saving one does not run anything. */
export interface StrategyDisplayConfig {
  name: string;
  description: string;
  timeframe: string;
  symbols: string[];
  notes: string;
}

import { describe, expect, it } from "vitest";
import { demoData } from "../data/demo";
import type { EquityPoint, Position, Trade } from "../types";
import {
  chartSeries, downsample, outcome, pnlSince, positionReturnPct, riskUsage, startOfDay, stopToTargetProgress,
  tradeStats, tradingReturn,
} from "./derive";

const H = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();
const NOW = Date.UTC(2026, 9, 28, 15, 30);
const series = (values: [number, number][]): EquityPoint[] =>
  values.map(([equity, cashFlow], i) => ({ t: iso(NOW - (values.length - 1 - i) * H), equity, cashFlow }));

describe("tradingReturn", () => {
  it("chains interval returns", () => {
    const r = tradingReturn(series([[100, 0], [110, 0], [99, 0]]));
    expect(r[0]).toBe(0);
    expect(r[1]).toBeCloseTo(10);
    expect(r[2]).toBeCloseTo(-1);
  });

  it("ignores deposits and withdrawals", () => {
    // +1000 deposit alongside a 10% gain on 1000: equity 1000 -> 2100.
    const r = tradingReturn(series([[1000, 0], [2100, 1000], [1050, -1050]]));
    expect(r[1]).toBeCloseTo(10);
    expect(r[2]).toBeCloseTo(10); // withdrawal only, no trading change
  });
});

describe("pnlSince", () => {
  it("subtracts cash flows from the equity change", () => {
    const pts = series([[1000, 0], [1600, 500], [1650, 0]]);
    const res = pnlSince(pts, NOW - 2 * H)!;
    expect(res.pnl).toBeCloseTo(150);
    expect(res.pct).toBeCloseTo((1100 / 1000) * (1650 / 1600) * 100 - 100);
  });

  it("uses the first point when the baseline predates the data", () => {
    expect(pnlSince(series([[1000, 0], [1100, 0]]), 0)!.pnl).toBeCloseTo(100);
  });
});

describe("chartSeries / downsample", () => {
  it("keeps the last value of each bucket and sums cash flows", () => {
    const pts = Array.from({ length: 11 }, (_, i) => ({ t: i, value: i, cashFlow: i === 3 ? 50 : 0 }));
    const out = downsample(pts, 6);
    expect(out[0]!.t).toBe(0);
    expect(out.at(-1)!.value).toBe(10);
    expect(out.reduce((s, p) => s + p.cashFlow, 0)).toBe(50);
    expect(out.length).toBeLessThanOrEqual(6);
  });

  it("measures a period's return from the point before it starts", () => {
    const pts = series(Array.from({ length: 49 }, (_, i) => [1000 + i * 10, 0] as [number, number]));
    const day = chartSeries(pts, "1D", "return", NOW, 1000);
    expect(day[0]!.value).toBe(0);
    expect(day.at(-1)!.value).toBeCloseTo((1480 / 1230 - 1) * 100); // anchor is the point before the 24h window
  });
});

describe("positions", () => {
  const p: Position = {
    id: "p", symbol: "BTC-USDT", side: "long", size: 1, entryPrice: 100, markPrice: 105,
    leverage: 5, stopPrice: 90, targetPrice: 120, openedAt: iso(NOW), unrealizedPnl: 5,
  };
  it("expresses P&L on margin", () => expect(positionReturnPct(p)).toBeCloseTo(25));
  it("places the mark between stop and target", () => expect(stopToTargetProgress(p)).toBeCloseTo(0.5));
  it("works for shorts (stop above, target below)", () => {
    expect(stopToTargetProgress({ ...p, side: "short", stopPrice: 110, targetPrice: 80, markPrice: 95 })).toBeCloseTo(0.5);
  });
  it("is null without a stop or target", () => expect(stopToTargetProgress({ ...p, stopPrice: undefined })).toBeNull());
});

describe("trades and risk", () => {
  const today = startOfDay(NOW, "UTC");
  const t = (id: string, closedAgoH: number | null, pnl?: number, risk?: number, openedAt = today + H): Trade => ({
    id, symbol: "X", side: "long", openedAt: iso(openedAt),
    closedAt: closedAgoH === null ? undefined : iso(NOW - closedAgoH * H), realizedPnl: pnl, initialRisk: risk,
  });
  const trades = [
    t("a", 1, 50, 25),
    t("b", 2, -100, 100),
    t("c", 3, 0.004, 10),
    t("d", 30, 20, undefined, today - 2 * 24 * H),
    t("old", 24 * 10, 999, 1, today - 11 * 24 * H),
    t("open", null, undefined, 40),
  ];

  it("classifies outcomes and ignores open trades", () => {
    expect(outcome(trades[2]!)).toBe("breakeven");
    expect(outcome(trades[5]!)).toBeNull();
  });

  it("summarizes the 7-day window", () => {
    const s = tradeStats(trades, NOW, "UTC");
    expect(s.closedCount).toBe(4); // "old" is outside the window, "open" isn't closed
    expect([s.win, s.loss, s.breakeven]).toEqual([2, 1, 1]);
    expect(s.winRate).toBeCloseTo(0.5);
    expect(s.rCount).toBe(3);
    expect(s.avgR).toBeCloseTo((2 - 1 + 0.0004) / 3);
    expect(s.entriesToday).toBe(4);
    expect(s.recent.at(-1)!.id).toBe("a");
  });

  it("uses today's net realized loss against the cap", () => {
    const r = riskUsage({ asOf: iso(NOW), dailyLossCap: 200 }, trades, NOW, "UTC");
    expect(r.realizedToday).toBeCloseTo(-49.996);
    expect(r.usage).toBeCloseTo(49.996 / 200);
    expect(r.resetsAt).toBe(today + 24 * H);
  });

  it("reports no usage when no cap is configured", () => {
    expect(riskUsage({ asOf: iso(NOW) }, trades, NOW, "UTC").usage).toBeNull();
  });

  it("a profitable day uses none of the cap", () => {
    expect(riskUsage({ asOf: iso(NOW), dailyLossCap: 100 }, [t("w", 1, 80, 40)], NOW, "UTC").usage).toBe(0);
  });
});

describe("startOfDay", () => {
  it("handles time zones", () => {
    expect(startOfDay(NOW, "UTC")).toBe(Date.UTC(2026, 9, 28));
    // 15:30 UTC is 11:30 in New York (UTC−4 on Oct 28, 2026).
    expect(startOfDay(NOW, "America/New_York")).toBe(Date.UTC(2026, 9, 28, 4));
  });
});

describe("demo fixtures", () => {
  it("are internally consistent", () => {
    const d = demoData("normal", NOW);
    expect(d.mode).toBe("demo");
    expect(d.performance.points.at(-1)!.equity).toBeCloseTo(d.account.equity, 1);
    for (const s of d.strategies) {
      for (const p of s.positions) {
        const dir = p.side === "long" ? 1 : -1;
        expect(p.unrealizedPnl).toBeCloseTo((p.markPrice - p.entryPrice) * p.size * dir, 6);
        // Every open position has a matching open trade.
        expect(d.trades.items.some((t) => !t.closedAt && t.symbol === p.symbol && t.slot === s.slot)).toBe(true);
      }
    }
    // Nothing is dated in the future.
    for (const t of d.trades.items) {
      expect(Date.parse(t.openedAt)).toBeLessThanOrEqual(NOW);
      if (t.closedAt) expect(Date.parse(t.closedAt)).toBeLessThanOrEqual(NOW);
    }
  });

  it("empty scenario has no cap, so risk shows 'Set risk cap' instead of 0%", () => {
    const d = demoData("empty", NOW);
    expect(riskUsage(d.risk, d.trades.items, NOW, "UTC").usage).toBeNull();
  });
});

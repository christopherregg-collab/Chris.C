// The seam between the cards and the data. Cards only ever see DashboardData.
//
// - Demo adapter: fixtures from ./demo.ts (the default).
// - API adapter: GET /api/dashboard, a server-side function that talks to the
//   exchange/bot with credentials held in server environment variables and
//   returns DashboardData. Enable it by setting VITE_DATA_SOURCE=api.

import type { DashboardData } from "../types";
import { demoData, type DemoScenario } from "./demo";

export interface DashboardAdapter {
  kind: "demo" | "api";
  describe: string;
  load(signal?: AbortSignal): Promise<DashboardData>;
}

const SCENARIO_KEY = "mtb:demo-scenario";

export function getDemoScenario(): DemoScenario {
  try {
    return (localStorage.getItem(SCENARIO_KEY) as DemoScenario | null) ?? "normal";
  } catch {
    return "normal";
  }
}

export function setDemoScenario(s: DemoScenario) {
  try { localStorage.setItem(SCENARIO_KEY, s); } catch { /* storage unavailable */ }
}

export const demoAdapter: DashboardAdapter = {
  kind: "demo",
  describe: "Demo fixtures (src/data/demo.ts)",
  load(signal) {
    const scenario = getDemoScenario();
    if (scenario === "loading") {
      return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    if (scenario === "error") return Promise.reject(new Error("Demo error: the data source returned HTTP 503."));
    return Promise.resolve(demoData(scenario));
  },
};

export const apiAdapter: DashboardAdapter = {
  kind: "api",
  describe: "Server API (GET /api/dashboard)",
  async load(signal) {
    const res = await fetch("/api/dashboard", { signal, headers: { Accept: "application/json" } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `The dashboard API returned HTTP ${res.status}.`);
    }
    return (await res.json()) as DashboardData;
  },
};

export const adapter: DashboardAdapter = import.meta.env.VITE_DATA_SOURCE === "api" ? apiAdapter : demoAdapter;

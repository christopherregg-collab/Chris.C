import { useCallback, useState } from "react";
import { defaultStrategies } from "../config/dashboard";
import type { SlotId, StrategyDisplayConfig } from "../types";

// Display-only strategy descriptions, saved in this browser. Never store
// credentials here, and saving one does not start or change a strategy.
const KEY = "mtb:strategies:v1";

function read(): Record<SlotId, StrategyDisplayConfig> {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Record<SlotId, Partial<StrategyDisplayConfig>>>;
    const out = { ...defaultStrategies };
    for (const slot of Object.keys(out) as SlotId[]) {
      const s = saved[slot];
      if (s) out[slot] = { ...out[slot], ...s, symbols: Array.isArray(s.symbols) ? s.symbols.map(String) : out[slot].symbols };
    }
    return out;
  } catch {
    return { ...defaultStrategies };
  }
}

export function isConfigured(c: StrategyDisplayConfig) {
  return Boolean(c.name || c.description || c.timeframe || c.symbols.length || c.notes);
}

export function useStrategies() {
  const [strategies, setStrategies] = useState(read);
  const save = useCallback((slot: SlotId, config: StrategyDisplayConfig) => {
    setStrategies((prev) => {
      const next = { ...prev, [slot]: config };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable: keep in memory */ }
      return next;
    });
  }, []);
  return { strategies, save };
}

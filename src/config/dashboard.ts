// Dashboard display settings. Edit these to rebrand or to pre-fill the four
// strategy slots for everyone who opens the dashboard. Strategy slots can also
// be edited from the dashboard itself (pencil icon on each strategy card);
// those edits are saved in the browser and take precedence over the defaults
// here.
//
// Everything in this file is descriptive display configuration. Nothing here
// runs, starts or changes a strategy, and no credentials belong here: exchange
// keys live only in server-side environment variables.

import type { SlotId, StrategyDisplayConfig } from "../types";

export const dashboardConfig = {
  name: "My Trading Bot",
  reportingCurrency: "USDT",
  /**
   * Shown in Diagnostics. Live data comes from BloFin via /api/dashboard. The
   * dashboard only reads; what the API key itself may do is set in BloFin.
   */
  exchange: import.meta.env.VITE_DATA_SOURCE === "api" ? "BloFin" : "",
  /** IANA time zone for timestamps and for when "today" starts. */
  displayTimezone: "UTC",
};

const empty = (): StrategyDisplayConfig => ({ name: "", description: "", timeframe: "", symbols: [], notes: "" });

export const defaultStrategies: Record<SlotId, StrategyDisplayConfig> = {
  featured: empty(),
  lower_1: {
    name: "Big Swing (paper)",
    description: "Long-only 4h breakouts in strong uptrends, adding to winners. Paper trading on the BloFin demo account.",
    timeframe: "4h",
    symbols: ["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE"],
    notes: "Runs every 5 minutes on the server (scripts/paper-trader.js). Conservative level, $60 pot. Paper P&L doesn't count toward the real daily loss cap.",
  },
  lower_2: {
    name: "Active Swing (paper)",
    description: "Long-only 1h breakouts on 11 volatile alts in 4h and daily uptrends. About 3-4 trades a week. Paper trading on the BloFin demo account.",
    timeframe: "1h",
    symbols: ["XRP", "ADA", "SOL", "DOGE", "SUI", "LINK", "AVAX", "PEPE", "XLM", "INJ", "BNB"],
    notes: "Runs every 5 minutes on the server (scripts/paper-trader.js --active). Conservative level, $100 pot. Skips a coin Big Swing is already holding.",
  },
  lower_3: empty(),
};

export const SLOT_LABELS: Record<SlotId, string> = {
  featured: "Strategy 1",
  lower_1: "Strategy 2",
  lower_2: "Strategy 3",
  lower_3: "Strategy 4",
};

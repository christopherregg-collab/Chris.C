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
  /** Fill in when the live integration exists, e.g. "BloFin". */
  exchange: "",
  /** IANA time zone for timestamps and for when "today" starts. */
  displayTimezone: "UTC",
};

const empty = (): StrategyDisplayConfig => ({ name: "", description: "", timeframe: "", symbols: [], notes: "" });

export const defaultStrategies: Record<SlotId, StrategyDisplayConfig> = {
  featured: empty(),
  lower_1: empty(),
  lower_2: empty(),
  lower_3: empty(),
};

export const SLOT_LABELS: Record<SlotId, string> = {
  featured: "Strategy 1",
  lower_1: "Strategy 2",
  lower_2: "Strategy 3",
  lower_3: "Strategy 4",
};

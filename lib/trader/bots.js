// Every bot the server can run, where its state lives, and its settings.
import { existsSync, readFileSync } from "node:fs";
import { LIVE, LIVE_ACTIVE, LIVE_SHORT, PAPER, PAPER_ACTIVE, PAPER_SHORT, STRATEGIES } from "../backtest/settings.js";

export const BOTS = [
  { key: "swing", mode: "live", dir: "data/live", config: LIVE },
  { key: "active", mode: "live", dir: "data/live-active", config: LIVE_ACTIVE },
  { key: "swingShort", mode: "live", dir: "data/live-short", config: LIVE_SHORT },
  { key: "swing", mode: "demo", dir: "data/paper", config: PAPER },
  { key: "active", mode: "demo", dir: "data/paper-active", config: PAPER_ACTIVE },
  { key: "swingShort", mode: "demo", dir: "data/paper-short", config: PAPER_SHORT },
];

/** Saved state and the last `maxEvents` log events of each bot (state null if it never ran). */
export function loadBots(root = ".", { maxEvents = 5000 } = {}) {
  return BOTS.map((b) => {
    const stateFile = `${root}/${b.dir}/state.json`;
    const logFile = `${root}/${b.dir}/log.jsonl`;
    let state = null;
    try { if (existsSync(stateFile)) state = JSON.parse(readFileSync(stateFile, "utf8")); } catch { state = null; }
    const events = existsSync(logFile)
      ? readFileSync(logFile, "utf8").trim().split("\n").slice(-maxEvents).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
      : [];
    return { key: b.key, mode: b.mode, label: STRATEGIES[b.key].label, pot: b.config.pot, state, events };
  });
}

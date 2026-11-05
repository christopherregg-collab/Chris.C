// Win-streak risk ladder: risk goes up after winning streaks and back down after losses.

// `saved` restores a ladder from state() so a live bot keeps its streak across restarts.
export function createLadder(level, rules, saved) {
  const { baseRisk, step, ceiling } = level;
  const { winsToStep, lossesToHalve, drawdownCapAt } = rules;
  let risk = saved?.risk ?? baseRisk;
  let wins = saved?.wins ?? 0;
  let losses = saved?.losses ?? 0;

  return {
    /** Plain object to save and pass back to createLadder later. */
    state() {
      return { risk, wins, losses };
    },
    /** Risk fraction for the next trade, given current equity and its peak. */
    current(equity, peak) {
      if (peak > 0 && equity < peak * (1 - drawdownCapAt)) return Math.min(risk, baseRisk);
      return risk;
    },
    /** Feed the result of each closed trade (net P&L, fees included). */
    record(pnl) {
      if (pnl > 0) {
        wins++;
        losses = 0;
        if (risk < baseRisk) risk = baseRisk; // first win after a halving restores base risk
        // Once the streak reaches winsToStep, every further win steps risk up again.
        if (wins >= winsToStep) risk = Math.min(ceiling, risk + step);
      } else {
        losses++;
        wins = 0;
        risk = losses >= lossesToHalve ? baseRisk / 2 : baseRisk;
      }
    },
  };
}

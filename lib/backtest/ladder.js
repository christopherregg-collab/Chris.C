// Win-streak risk ladder: risk goes up after winning streaks and back down after losses.

export function createLadder(level, rules) {
  const { baseRisk, step, ceiling } = level;
  const { winsToStep, lossesToHalve, drawdownCapAt } = rules;
  let risk = baseRisk;
  let wins = 0;
  let losses = 0;

  return {
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

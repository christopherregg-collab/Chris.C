# Momentum backtester

Tests the bot's two live strategies on BloFin's own history before any real money is used:

| Slot | Strategy | Money | What it does |
| --- | --- | --- | --- |
| 1 | **Core Momentum** | $240 | 1h breakouts on BTC and ETH, only in the direction of the 4h trend |
| 2 | **Big Swing** | $60 | Only the strongest breakouts (4h and daily trends agree, strong ADX, volume spike), and adds to winners |
| 3, 4 | Shadow | $0 | Reserved for paper-testing new versions against the live ones |

Each strategy is run at three aggression levels, so the choice of level is made from the numbers.

## Run it

BloFin's API is reachable from the Hetzner server (and from your own computer), not from the
cloud coding sandbox.

```sh
npm run backtest:fetch          # download ~2 years of hourly candles, funding and order-size rules
npm run backtest                # run everything; writes data/backtest/report.md and report.json
```

Or from your computer, using the server:

```sh
deploy/deploy.sh                # push the latest code
deploy/run-backtest.sh          # fetch + backtest on the server, copy the report back
```

Options: `npm run backtest -- --core 240 --swing 60 --split 0.7 --no-kill`.
`npm run backtest -- --synthetic` runs on simulated prices. That only checks that the engine works;
its numbers say nothing about real profit.

## The rules being tested

**Entry.** On the close of a 1h bar: the close breaks the previous 20-bar high (long) or low (short),
every trend filter agrees (the higher-timeframe close is above its EMA 50 for longs, below for
shorts), ADX(14) is above the minimum, and volume is above its 20-bar average times the
multiplier. The order fills at the next bar's open.

| | Core Momentum | Big Swing |
| --- | --- | --- |
| Trend filters | 4h | 4h and daily |
| ADX minimum | 20 | 30 |
| Volume | above average | 1.5× average |
| Adds to winners | no | up to 3 times, every 1 ATR of profit |

**Exit.** A stop 2 ATR away, placed at entry. A trailing stop 3 ATR behind the best price.
A close beyond the opposite 10-bar channel. When Big Swing adds, its stop moves to 2 ATR behind
the latest add, so a failed run loses about one normal loss.

**Position size.** `risk % × equity ÷ stop distance`, then cut down to the leverage cap, then
rounded down to BloFin's order step. Orders below BloFin's minimum size are skipped and counted.

**Risk ladder (the "learning" part).** From the 2nd win in a row, each win raises risk one step,
up to the ceiling. Any loss drops risk back to base; 2 losses in a row halve it until the next win.
While equity is more than 10% below its peak, risk stays at base.

| Level | Base risk | Step | Ceiling | Leverage cap |
| --- | --- | --- | --- | --- |
| Conservative | 1% | 0.25% | 2% | 3× |
| Aggressive | 2% | 0.5% | 4% | 5× |
| Max | 3% | 1% | 6% | 10× |

**Limits at every level.** A day that loses 5% flattens and stops for the rest of the UTC day.
A fall of 25% from the peak trips the kill switch: flatten and stop trading. At most 3 positions.

**Costs.** 0.06% taker fee and 0.05% slippage on every fill, funding every 8 hours from BloFin's
history (or 0.01% per 8h when there is none). Liquidation is checked before stops on every bar:
if the account's equity at the bar's worst prices falls to the maintenance margin, the pot is lost.

All of these are settings in `lib/backtest/config.js`.

## Reading the report

- **Results**: what each strategy and level would have done with the real rules, kill switch included.
- **Risk of ruin**: 5,000 simulated years made by shuffling the trades, with the risk ladder
  replayed and the kill switch off. It shows how likely each level is to lose 25%, 50% or 90%.
- **Overfitting check**: the first 70% of the period vs the last 30%. A strategy that only works
  in the first part probably has no real edge.
- Compare everything with **buy and hold**.

What to look for: a profit factor above about 1.2 in **both** halves, and a level whose bad years
you could live with. If neither strategy holds up out of sample, change the rules and test again
rather than going live.

## Code

| Path | What it is |
| --- | --- |
| `lib/backtest/config.js` | Every setting: strategies, levels, ladder, limits, costs |
| `lib/backtest/engine.js` | Bar-by-bar simulation |
| `lib/backtest/ladder.js` | Win-streak risk ladder |
| `lib/backtest/ta.js` | ATR, ADX, Donchian channels, higher-timeframe trend |
| `lib/backtest/stats.js` | Metrics and Monte Carlo |
| `lib/backtest/blofin-data.js` | BloFin public data download and loading |
| `lib/backtest/synthetic.js` | Simulated prices for engine checks |
| `scripts/backtest.js`, `scripts/fetch-blofin.js` | Command-line entry points |
| `test/backtest.test.js` | Engine, ladder, indicator and data tests |

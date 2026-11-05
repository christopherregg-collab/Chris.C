# Backtester

Tests the bot's two live strategies on BloFin's own history before any real money is used:

| Slot | Strategy | Money | What it does |
| --- | --- | --- | --- |
| 1 | **Core Momentum** | $240 | Daily, long-only: hold a coin while it's above its price 30 days ago, sized by volatility. Not ready: see ROADMAP.md |
| 2 | **Big Swing** | $60 | 4h, long-only: only the strongest breakouts (strong ADX, volume spike), and adds to winners |
| 3 | **Active Swing** | $100 | 1h, long-only: the same breakout rules on 11 volatile alts, no adds, about 3–4 trades a week |
| 3, 4 | Shadow | $0 | Reserved for paper-testing new versions against the live ones |

Both trade BTC, ETH, SOL, XRP, BNB and DOGE USDT perpetuals (`SYMBOLS` in the config). Each strategy
is run at three aggression levels, so the choice of level is made from the numbers.

How we got here (Nov 2026):
- On 1h candles, breakouts made money before costs but traded about 300 times a year, and fees
  plus slippage turned that into a loss. Moving to 4h candles with limit-order entries cut costs sharply.
- On 4h, a breakout version of Core had no edge, and Big Swing's shorts lost money while its longs
  made it. So Core became a daily trend-holder, and both strategies are long-only.

## Run it

BloFin's API is reachable from the Hetzner server (and from your own computer), not from the
cloud coding sandbox.

```sh
npm run backtest:fetch          # download up to 5 years of candles (BloFin has from Jan 2023), funding and order-size rules
npm run backtest                # run everything; writes data/backtest/report.md and report.json
```

Or from your computer, using the server:

```sh
deploy/deploy.sh                # push the latest code
deploy/run-backtest.sh          # fetch + backtest on the server, copy the report back
```

Options: `npm run backtest -- --core 240 --swing 60 --split 0.7 --no-kill`.
In a Claude Code cloud session, Node's `fetch` needs the sandbox proxy: prefix the fetch with
`NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`, and allow `openapi.blofin.com`
in the environment's network settings.
`npm run backtest -- --synthetic` runs on simulated prices. That only checks that the engine works;
its numbers say nothing about real profit.

## The rules being tested

**Big Swing entry.** On the close of a 4h candle: the close breaks the previous 20-candle high,
the daily close is above its EMA 50, ADX(14) is at least 30, and volume is at least 1.5× its
20-candle average.

**Core Momentum entry.** On the close of a daily candle: the close is above the close 30 days
earlier. It exits when that's no longer true. Position size: each coin gets equity ÷ 6, scaled by
60% ÷ the coin's 30-day annualized volatility (at most half the account per coin), times the risk
ladder (1% risk = 1×). It has no daily loss cap of its own, because a holder rides through −5% days.

**Both.** A limit order is placed at the signal candle's close. It fills only if the next candle trades back to it (maker fee, no slippage); otherwise
it is cancelled and counted as a missed entry. Set `entry.type` to `"market"` to fill at the next open.

| | Core Momentum | Big Swing |
| --- | --- | --- |
| Candles | daily | 4h |
| Position size | by volatility | by risk to the stop |
| Initial stop | 3 ATR (protective) | 2 ATR |
| Trailing stop | none | 3 ATR behind the best price |
| Exit signal | close below the close 30 days earlier | close below the 10-candle low |
| Adds to winners | no | up to 3 times, every 1 ATR of profit |
| Max positions | 6 (one per coin) | 3 |

When Big Swing adds, its stop moves to 2 ATR behind the latest add, so a failed run loses about
one normal loss.

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

**Costs.** 0.02% maker fee on limit entries; 0.06% taker fee and 0.05% slippage on market fills
(stops, exits, adds), funding every 8 hours from BloFin's
history (or 0.01% per 8h when there is none). Liquidation is checked before stops on every bar:
if the account's equity at the bar's worst prices falls to the maintenance margin, the pot is lost.

All of these are settings in `lib/backtest/settings.js`.

## Reading the report

- **Walk-forward test**: the honest one. Each quarter, the settings are chosen from the
  strategy's `walkForward.grid` using only the previous year, then traded on the next quarter.
  Only those unseen quarters count. The table also shows which settings were picked each time.
- **Results**: what each strategy and level would have done with the real rules, kill switch included.
- **Risk of ruin**: 5,000 simulated years made by shuffling the trades, with the risk ladder
  replayed and the kill switch off. It shows how likely each level is to lose 25%, 50% or 90%.
- **Overfitting check**: the first 70% of the period vs the last 30%. A strategy that only works
  in the first part probably has no real edge.
- **By coin**: which coins helped and which hurt, at the Conservative level.
- Compare everything with **buy and hold**.

What to look for: a profit factor above about 1.2 in **both** halves, and a level whose bad years
you could live with. If neither strategy holds up out of sample, change the rules and test again
rather than going live.

## Code

| Path | What it is |
| --- | --- |
| `lib/backtest/settings.js` | Every setting: strategies, levels, ladder, limits, costs |
| `lib/backtest/engine.js` | Bar-by-bar simulation |
| `lib/backtest/ladder.js` | Win-streak risk ladder |
| `lib/backtest/ta.js` | ATR, ADX, Donchian channels, higher-timeframe trend |
| `lib/backtest/stats.js` | Metrics and Monte Carlo |
| `lib/backtest/walkforward.js` | Rolling walk-forward test |
| `lib/backtest/blofin-data.js` | BloFin public data download and loading |
| `lib/backtest/synthetic.js` | Simulated prices for engine checks |
| `scripts/backtest.js`, `scripts/fetch-blofin.js` | Command-line entry points |
| `test/backtest.test.js` | Engine, ladder, indicator and data tests |

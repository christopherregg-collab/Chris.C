# Live trading (real money)

Each bot goes live on its own: `bash deploy/go-live.sh short` (Big Swing Short, experimental),
`bash deploy/go-live.sh swing` (Big Swing) or `bash deploy/go-live.sh active` (Active Swing). Stop one
with `bash deploy/go-live.sh stop short`, or all with `bash deploy/go-live.sh stop`. Live bots share
one real account and skip any coin another bot (or you) already holds.

**Big Swing Short is experimental:** its backtest edge faded in the recent half of the data
(profit factor 1.73, then 1.07). It runs live at the owner's request; judge it after about 30
trades: keep it if it averages +0.2R a trade or better, retire it if it averages below 0.

The live trader runs the same Big Swing rules and code as the paper trader, on your real BloFin
account: long-only 4h breakouts on BTC, ETH, SOL, XRP, BNB and DOGE, at the Conservative level,
sized as if the account held a **$60 pot**. Settings are in `LIVE` in `lib/backtest/settings.js`.
State and log are in `data/live/`.

## What to expect

These come from testing, not a promise:
- **Few trades.** Roughly 3–5 a month across the six coins, fewer in downtrends (most coins were in
  one in Nov 2026).
- **Low win rate, big winners.** About 1 trade in 4 or 5 wins; the winners make several times
  what the losers lose.
- **Lumpy returns.** Most quarters are small losses; a few trend runs make the year.
- **Thinner than the backtest.** On 21 coins the rules had never seen, the edge was much smaller
  (+0.11R a trade against +0.84R on these six). Plan for results well below the six-coin
  backtest.

## Before you start

1. **Run the smoke test on demo** (Hetzner console):
   ```
   bash /opt/trading-bot/deploy/smoke-test.sh
   ```
   Every line should say PASS. It checks every order call the trader makes: limit and cancel,
   market buy, stop-loss for the whole position, moving the stop, closing, and P&L.
2. **Create a separate real-account API key** in BloFin (normal mode, not demo): Read + Trade, **no
   withdrawal**, IP whitelist `2.29.115.23`. Don't reuse the dashboard's read-only key.
3. **Keep your own trades away from the bot's coins**, or better, give the bot its own BloFin
   sub-account if you have one. The bot needs isolated margin and net position mode. If the
   account is set differently, it switches it, but only when nothing is open; otherwise it stops
   with a message. In net mode your own trade on the same coin would merge with the bot's position.
4. **Fund it.** The bot sizes from the $60 pot, not the account balance, so any balance above
   about $60 plus margin is untouched. To trade bigger, raise `pot` in `LIVE` (and tell Claude, so
   the minimum-size check still holds).

## Start

In the Hetzner console:
```
bash /opt/trading-bot/deploy/go-live.sh swing
```
It asks for the trade key (first time only), runs the smoke test on the real account (one
minimum-size BTC trade, opened and closed, a few cents of fees), and only if every step passes,
starts the live timer.

## Weekly report

The dashboard's report button (top right, next to the theme switch) opens the weekly bots report
at `/api/report`: every bot, live and demo, with its trades, average result in R, win rate, worst
drop, limit-order fill rate, problems from its log, open positions, and progress to the 30-trade
review. It's built fresh each time you open it. Every Monday 08:00 UTC the server also saves a copy
to `data/reports/`. In the console: `bash deploy/report.sh`.

## Watch and stop

```
cd /opt/trading-bot
runuser -u bot -- node scripts/paper-trader.js --live --status
journalctl -u live-trader.service -n 30
```
Everything also shows in BloFin itself (positions, open orders, TP/SL orders, history).

Stop at any time:
```
bash /opt/trading-bot/deploy/go-live.sh stop
```
That stops new trades and turns `LIVE_TRADING` off. Open positions keep their stop-losses on
BloFin; close them there if you want out immediately.

## Built-in limits (same as paper)

- Risk 1% of the pot per trade (rising to at most 2% on winning streaks), 3× leverage cap,
  isolated margin, a stop-loss on BloFin for every position.
- Daily loss cap: −5% of the pot closes everything until the next UTC day.
- Kill switch: −25% from the pot's peak closes everything and stops for good.

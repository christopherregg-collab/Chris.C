# Paper trading on BloFin's demo account

The paper trader runs **Big Swing** (long-only, Conservative level, a $60 pot) on BloFin's demo
account with the exact rules from the backtest. It runs every 5 minutes on the server and acts
when a 4h candle closes. The goal is to compare real fills with the backtest before any real
money is used.

It can only reach BloFin's **demo** environment: the address is fixed in
`lib/trader/blofin-exchange.js` and isn't a setting.

## Set it up

1. **Create demo API keys.** In BloFin, switch to demo trading, then create an API key there with
   trade permission. Demo keys are separate from your real account's keys. Leave withdrawal off,
   and bind the key to the server's IP if BloFin offers that for demo keys.
2. **Put them on the server** in `/opt/trading-bot/.env` (never in the repo):
   ```
   BLOFIN_DEMO_API_KEY=...
   BLOFIN_DEMO_API_SECRET=...
   BLOFIN_DEMO_API_PASSPHRASE=...
   ```
3. **Deploy and start**, from your computer:
   ```sh
   deploy/deploy.sh
   deploy/setup-paper-trader.sh
   ```
   This does a dry run, one real step on the demo account, then turns on the 5-minute timer.

To stop: `deploy/setup-paper-trader.sh stop`. The state and log are kept.

## Check on it

On the server (`ssh` in, then `cd /opt/trading-bot`):

```sh
node scripts/paper-trader.js --status          # equity, open positions, trades, next risk
tail -n 50 data/paper/log.jsonl                # every event: orders, fills, stops, exits
journalctl -u paper-trader.service -n 50       # the last runs, including any errors
```

`node scripts/paper-trader.js --dry-run` shows what it would do right now on live prices,
without keys or orders.

## What it does each run

1. **Reconciles with BloFin.**
   - A filled entry gets a stop-loss on the exchange straight away (2 ATR below the fill).
   - An entry not filled within one candle is cancelled.
   - A position that disappeared (stop hit) has its P&L recorded, and the risk ladder updated.
   - A stop that went missing is placed again.
2. **Checks the limits on the pot.** A 5% daily loss closes everything until the next UTC day.
   A 25% fall from the peak trips the kill switch: close everything and stop for good.
3. **On a new 4h candle:**
   - It raises the trailing stop (stops never move down).
   - It closes on the exit signal.
   - It adds to winners, up to 3 times.
   - It places a limit buy at the close when there's a signal.

It uses isolated margin and sets leverage to the level's cap. It only manages positions it opened
itself: anything else on the account is reported once and left alone.

## Settings

`PAPER` in `lib/backtest/settings.js` sets the strategy, level, pot, and the settings chosen by
the latest walk-forward window. Re-check those against the backtest report each quarter.

## If BloFin rejects an order

The order format follows BloFin's v1 REST API, but the docs couldn't be checked when this was
written. A rejected call shows up in `journalctl` with BloFin's error code and the call that
failed. Paste that error into a Claude session to fix it. All BloFin-specific code is in
`lib/trader/blofin-exchange.js`.

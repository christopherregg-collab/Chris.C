# Roadmap: from dashboard to crypto trading app

Where this is going: a personal crypto trading app that watches the market, produces signals,
alerts on them, lets you practise with paper trades, and finally places real orders on an
exchange under strict risk limits.

Each phase ships something usable on its own. Real money comes last, after the signals have a
track record.

## Decisions to make first

These change the design, so settle them before Phase 3:

1. **Just for you, or for other people too?** Running other people's money, or charging for
   signals, brings in licensing, KYC and liability questions. A personal tool avoids nearly all
   of that. This plan assumes a personal tool.
2. **Which exchange?** From the US, Coinbase Advanced Trade and Kraken are the realistic options.
   Binance.com blocks US users and US servers, Vercel's included. The signals already use Coinbase
   data, so Coinbase is the default.
3. **How much automation?** The options are alerts only, one-click orders you confirm, or a fully
   automatic bot. Each step up needs more safeguards (Phase 5).
4. **Hosting budget.** Vercel's Hobby plan is for non-commercial use, and its cron jobs can run
   at most once a day. Per-minute signal checks need Vercel Pro, or a small always-on worker
   (Railway, Fly.io or a VPS) at about $5–20 a month.

## Phase 0: Dashboard and signals (done)

- TradingView widgets: chart, technicals, screener, heatmap, news.
- Signals table: EMA trend + MACD + RSI scoring on Coinbase candles, via `api/candles.js`.
- Unit tests for the indicators and the API.

## Phase 1: Make the signals trustworthy

Goal: know whether the signals would actually have made money before acting on them.

- **Backtester.** Replay months of historical candles through `evaluate()`, simulate entering on
  Buy and exiting on Sell, and report win rate, profit factor, max drawdown and the result of
  just holding. Include fees (about 0.4–0.6% a trade on Coinbase) and slippage.
- **Tune the scoring.** Today RSI works against the trend, which makes Strong buy and Strong sell
  rare. Try alternatives in the backtester: trend-filtered RSI, an ATR volatility filter, volume
  confirmation, and a dead band so a MACD near zero doesn't flip back and forth.
- **Multi-timeframe confirmation.** For example, act on 1h signals only when the 1d trend agrees.
- **Data fallback.** Add Kraken as a second source for coins Coinbase lacks, and for outages.
- **Configurable strategies.** Move the thresholds and weights into a strategy object so
  strategies can be compared side by side.

## Phase 2: Alerts

Goal: get told about a signal instead of watching the page.

- A scheduled job (Vercel Cron, or the worker) runs every N minutes, evaluates the watchlist and
  records each signal.
- A database for signal history. Neon or Supabase Postgres both have free tiers and work with Vercel.
- Notify only when a coin's label *changes*, for example Neutral → Buy. Start with a Telegram bot
  (free and simple), then add email or web push.
- A "signal history" view on the dashboard, with each signal's later outcome (price 1h, 1d and
  7d afterwards). This becomes the live track record.

## Phase 3: Accounts and app structure

Goal: turn the page into an app with saved state.

- Move to a framework once the page outgrows plain scripts. Next.js is the natural fit on Vercel,
  and the existing `lib/` and `api/` code carries over largely unchanged.
- Sign-in (Auth.js, Clerk or Supabase Auth), even for one user, because later phases hold
  exchange keys.
- Saved watchlists, alert rules and strategy settings per user.

## Phase 4: Paper trading

Goal: run the strategy on live prices with fake money.

- A simulated portfolio with a starting balance, market and limit orders, fees and slippage.
- Positions, an order history and P&L over time, charted against simply holding BTC.
- "Auto-paper" mode: the alert job places the paper trades itself, exactly as the live bot will.
- Run this for weeks. Go to Phase 5 only if paper results roughly match the backtest.

## Phase 5: Live trading

Goal: real orders, with the blast radius capped.

- **Exchange connection.** Coinbase Advanced Trade API, with keys entered once, encrypted at rest
  and used only on the server. Never send a key to the browser.
- **Key permissions.** Create keys with view and trade rights only, never transfer or withdraw.
  Restrict them to your server's IP address where the exchange allows it. Vercel functions don't
  have a fixed IP, which is one more reason to place orders from a worker.
- **Start manual.** First the app proposes an order and you confirm it with one click. Only after
  that works, optional automation per strategy.
- **Risk limits, enforced on the server:**
  - A maximum order size and a maximum position per coin.
  - A daily loss limit that halts trading for the day.
  - A cap on total funds the bot can use, ideally kept in a separate exchange sub-account.
  - A kill switch that cancels open orders and stops all automation.
- **Order safety.** Use an idempotency key on every order so a retry can't double-buy, reconcile
  against the exchange's fills, and keep an audit log of every decision and order.
- **Monitoring.** Alert on API errors, rejected orders and positions that drift from expectations.

## Phase 6: Hardening

- Security review: secrets handling, auth, rate limiting on the API routes, dependency audit.
- Error tracking (for example Sentry) and uptime checks.
- Tax export: a CSV of fills with cost basis.
- A mobile-friendly layout or an installable PWA.

## Risks to keep in mind

- **Backtests flatter.** Overfitting to past data is the most common way trading bots lose money.
  Keep a period of data the tuning never sees, and trust paper results over backtests.
- **Technical signals are weak on their own.** Expect modest edges at best. Risk limits matter
  more than the indicator mix.
- **Third-party dependence.** Exchange APIs change, rate-limit and go down. Every live code path
  needs a safe failure mode, where no data means no trade.

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
2. **Which exchange?** BloFin is the chosen exchange for the bot. Its API is authenticated with a key,
   a secret and a passphrase, which must live only in server-side environment variables. Check
   BloFin's terms for your country before trading. Binance.com blocks US users and US servers,
   Vercel's included. The markets page's signals use Coinbase public data, which needs no key.
3. **How much automation?** The options are alerts only, one-click orders you confirm, or a fully
   automatic bot. Each step up needs more safeguards (Phase 5).
4. **Hosting budget.** Vercel's Hobby plan is for non-commercial use, and its cron jobs can run
   at most once a day. Per-minute signal checks need Vercel Pro, or a small always-on worker
   (Railway, Fly.io or a VPS) at about $5–20 a month.

## Phase 0: Dashboard and signals (done)

- Bot dashboard (React + TypeScript): performance, four strategy slots, trades, scanner and risk
  cards, with demo data behind a data adapter (`src/data/adapter.ts`).
- Markets page: TradingView widgets and an EMA + MACD + RSI signals table on Coinbase candles.
- Tests for the indicators, the API and the dashboard calculations.

## Next: connect BloFin (read-only)

Goal: replace the demo data with the real account, without any ability to trade yet.

- Create a BloFin API key with **read-only** permission.
- Add `api/dashboard.js`, which calls BloFin's REST API server-side with the key, secret and
  passphrase from Vercel environment variables. It maps balances, positions and fills into
  `DashboardData` and returns it.
- An equity history needs storing over time, because exchanges report current balances. Record
  snapshots on a schedule (see Phase 2), or start with a short history built from fills.
- Set `VITE_DATA_SOURCE=api`. Cards, layout and calculations stay as they are.

## Phase 1: Make the signals trustworthy

Goal: know whether the signals would actually have made money before acting on them.

- **Momentum backtester (built, see BACKTEST.md).** Core Momentum and Big Swing on BloFin 4h
  data for six coins since 2023, at three aggression levels with a win-streak risk ladder, limit
  entries, fees, slippage, funding, liquidation, Monte Carlo risk of ruin and an
  in-sample/out-of-sample check. First results (Nov 2026): Core Momentum has no edge; Big Swing's
  longs do (profit factor ~1.9 over 165 trades) but its shorts lose, and it is uneven year to year.
  Neither is ready for real money.
- **Walk-forward test, Core Trend, long-only Big Swing (Nov 2026).** In the rolling walk-forward
  test (Mar 2024 to Nov 2026, settings picked each quarter from the previous year only), long-only
  Big Swing returned +90% with a 21% max drawdown and PF (R) 1.65, against +14% for an equal split
  of the six coins. Core Trend (daily trend-holder) was flat, and lost on the most recent data.
  Big Swing moves to paper trading (PAPER_TRADING.md); Core Trend needs more work.
- **Core rework and robustness check (Nov 2026).** Volatility-based sizing raised the trend-holder's
  exposure but not its results (walk-forward -9% to -12%). Time-series momentum (hold while above
  the price N days ago) did better: fixed 20-30 day lookbacks made +19% to +34% from Mar 2024 with
  ~36% max drawdown, against +15% and 63% for buy and hold. But its walk-forward result swings from
  -13% to +26% depending on which day the test starts (positive on 8 of 14 start dates), so Core
  is still not ready. Big Swing's walk-forward stayed between +65% and +87% on all 14 start dates:
  its edge doesn't depend on the start date.
- **Big Swing on 21 more coins (Nov 2026).** The unchanged rules on the 21 most-traded other crypto
  perpetuals on BloFin, which they were never tuned on: +0.11R a trade (PF 1.14, 12 of 21 coins
  positive) against +0.84R on the original six. The edge is real but much thinner away from the
  large caps, so expect paper results below the six-coin backtest. The 21 are watch-only, in the
  dashboard scanner, which now shows Big Swing setups and 30-day momentum from BloFin 4h candles.
- **Active Swing, a faster strategy (Nov 2026).** Goal: more trades. 1h mean reversion (buy sharp
  dips, sell at the average) lost money in every variant, even with zero costs. 1h breakouts on 11
  volatile alts (XRP, ADA, SOL, DOGE, SUI, LINK, AVAX, PEPE, XLM, INJ, BNB) with Big Swing's filters
  but no adding to winners made about 0.5 trades a day; walk-forward +123% to +147% (Oct 2024 to
  Nov 2026) on all 7 start dates tested, worst drop 19-24%, 8 of 11 coins positive, the recent
  30% better than the older 70%, positive on BTC+ETH too. Conservative level only: Aggressive and
  Max hit the kill switch. 3-5 trades a day wasn't achievable profitably: looser versions that
  trade more all lost after costs. Paper trading on demo next to Big Swing; each bot skips a coin
  the other already holds.
- **Today's top gainers (Nov 2026).** Over a year of BloFin's 150 most-traded crypto perps, buying a
  coin after a big 24h rise lost money: coins up 30%+ were 6% lower a week later on average, coins
  up 50%+ 12% lower (median -19%). Shorting them looked good without stops, but after a 50%+ pump
  1 in 10 rose another 100%+ within 3 days, and with a stop-loss the best short version made only
  +8% in a year (not traded). The scanner now lists pumps as "don't chase" warnings, and both bots
  skip a coin already up 30%+ in 24h (roughly neutral in their backtests; backed by the study).
- **Shorting (Nov 2026).** Short-only versions of both bots, Mar 2023 to Nov 2026: mirrored rules
  were break-even (PF 1.00 Big Swing, 1.04 Active Swing); no adds, tighter trails, faster exits,
  a take-profit at 3x risk, and shorting only while BTC's daily close is below its EMA 50 or 200
  didn't produce a short side that held up in both halves of the data (best: Big Swing, BTC below
  EMA 50, take profit 3x risk, +16%, PF 1.73 then 1.07). Adding shorts to either bot lowered its
  return and raised its drawdown. Both stay long-only: in downtrends they stay flat. The engine
  keeps the shortRegime filter and targetR take-profit for later tests.
- **Backtester for the scoring signals.** Replay months of historical candles through `evaluate()`, simulate entering on
  Buy and exiting on Sell, and report win rate, profit factor, max drawdown and the result of
  just holding. Include exchange fees and slippage.
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

- **Exchange connection.** BloFin's trading API, with keys entered once, encrypted at rest and used
  only on the server. Never send a key to the browser.
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

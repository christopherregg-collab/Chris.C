# Crypto Dashboard

A static crypto dashboard built on [TradingView's free embeddable widgets](https://www.tradingview.com/widget-docs/).

Panels: ticker tape, advanced chart (RSI + MACD), technical-analysis gauge, symbol profile,
a **signals** table, crypto screener, market-cap heatmap, and a crypto news feed. Pick a symbol and a light or dark theme from the top bar; the page remembers both.

See [ROADMAP.md](ROADMAP.md) for the plan to grow this into a trading app.

## Signals

The signals table scores every coin in the watchlist on three checks, each worth −1, 0 or +1:

| Check | Bullish (+1) | Bearish (−1) |
| --- | --- | --- |
| EMA 20/50 trend | EMA 20 above EMA 50 | EMA 20 below EMA 50 |
| MACD (12, 26, 9) | Histogram above zero | Histogram below zero |
| RSI 14 | Below 30 (oversold) | Above 70 (overbought), otherwise 0 |

The total (−3 to +3) maps to Strong sell, Sell, Neutral, Buy or Strong buy. A cross within the
last 3 candles is called out (golden/death cross, bullish/bearish MACD cross). Clicking a row
loads that coin in the chart. The table refreshes every minute.

Candles come from Coinbase's public market data through `api/candles.js`, a serverless function
(no API key; responses are cached at the edge for 60 s). Coins not listed on Coinbase in USD,
such as BNB, show as unavailable. The scoring lives in `lib/indicators.js`.

This is a technical-analysis aid, not financial advice.

## Run it

No build step and no dependencies (Node 18+):

```sh
npm run dev     # http://localhost:3000, serves the page and /api/candles
npm test        # indicator and API tests
```

## Deploy on Vercel

Import the repo at <https://vercel.com/new>, choose the **Other** framework preset, and leave the
build command and output directory empty. Vercel serves the static files and runs `api/` as
serverless functions. Every push to `main` deploys.

## Configure

Copy `config.example.js` to `config.js` and edit the symbol list, default symbol, or theme.
`config.js` is gitignored.

## About API keys

TradingView's embeddable widgets need **no API key**. TradingView does not offer a public
market-data API with keys. Its self-hosted
[Charting Library](https://www.tradingview.com/charting-library-docs/) is licensed by
application, and you supply its data feed yourself.

If you later add a keyed data source (for example an exchange API), keep the key on a server
or in a local `.env` file, never in this browser code: anyone who opens the page can read it.

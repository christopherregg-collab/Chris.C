# Crypto Dashboard

A static crypto dashboard built on [TradingView's free embeddable widgets](https://www.tradingview.com/widget-docs/).

Panels: ticker tape, advanced chart (RSI + MACD), technical-analysis gauge, symbol profile,
crypto screener, market-cap heatmap, and a crypto news feed. Pick a symbol and a light or dark theme from the top bar; the page remembers both.

## Run it

No build step and no dependencies. Serve the folder:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Or enable GitHub Pages for this repo (Settings → Pages → deploy from branch).

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

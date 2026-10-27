(function () {
  const DEFAULTS = {
    defaultSymbol: "BINANCE:BTCUSDT",
    theme: "dark",
    symbols: [
      "BINANCE:BTCUSDT",
      "BINANCE:ETHUSDT",
      "BINANCE:SOLUSDT",
      "BINANCE:BNBUSDT",
      "BINANCE:XRPUSDT",
      "BINANCE:DOGEUSDT",
      "BINANCE:ADAUSDT",
      "BINANCE:AVAXUSDT",
      "BINANCE:LINKUSDT",
      "BINANCE:DOTUSDT",
    ],
  };
  const config = Object.assign({}, DEFAULTS, window.DASHBOARD_CONFIG || {});
  const EMBED = "https://s3.tradingview.com/external-embedding/embed-widget-";

  const state = {
    symbol: localGet("symbol") || config.defaultSymbol,
    theme: localGet("theme") || config.theme,
  };

  // Each TradingView widget is a <script> whose text is its JSON config.
  function mount(id, widget, options) {
    const host = document.getElementById(id);
    host.innerHTML = "";
    const container = document.createElement("div");
    container.className = "tradingview-widget-container";
    const target = document.createElement("div");
    target.className = "tradingview-widget-container__widget";
    container.appendChild(target);
    const script = document.createElement("script");
    script.src = EMBED + widget + ".js";
    script.async = true;
    script.textContent = JSON.stringify(options);
    container.appendChild(script);
    host.appendChild(container);
  }

  function label(symbol) {
    return symbol.split(":").pop().replace(/USDT?$/, "");
  }

  function render() {
    const { symbol, theme } = state;
    const common = { colorTheme: theme, isTransparent: true, locale: "en" };

    mount("ticker-tape", "ticker-tape", {
      ...common,
      symbols: config.symbols.map((s) => ({ proName: s, title: label(s) })),
      showSymbolLogo: true,
      displayMode: "adaptive",
    });

    mount("chart", "advanced-chart", {
      autosize: true,
      symbol,
      interval: "60",
      timezone: "Etc/UTC",
      theme,
      style: "1",
      locale: "en",
      allow_symbol_change: true,
      withdateranges: true,
      hide_side_toolbar: false,
      studies: ["STD;RSI", "STD;MACD"],
      watchlist: config.symbols,
      support_host: "https://www.tradingview.com",
    });

    mount("technicals", "technical-analysis", {
      ...common,
      symbol,
      interval: "1h",
      width: "100%",
      height: "100%",
      showIntervalTabs: true,
      displayMode: "single",
    });

    mount("symbol-info", "symbol-profile", {
      ...common,
      symbol,
      width: "100%",
      height: "100%",
    });

    mount("screener", "screener", {
      ...common,
      width: "100%",
      height: "100%",
      defaultColumn: "overview",
      screener_type: "crypto_mkt",
      displayCurrency: "USD",
    });

    mount("heatmap", "crypto-coins-heatmap", {
      ...common,
      dataSource: "Crypto",
      blockSize: "market_cap_calc",
      blockColor: "change",
      hasTopBar: false,
      isDataSetEnabled: false,
      isZoomEnabled: true,
      hasSymbolTooltip: true,
      width: "100%",
      height: "100%",
    });

    mount("news", "timeline", {
      ...common,
      feedMode: "market",
      market: "crypto",
      displayMode: "regular",
      width: "100%",
      height: "100%",
    });
  }

  function localGet(key) {
    try { return localStorage.getItem("cryptodash:" + key); } catch (e) { return null; }
  }
  function localSet(key, value) {
    try { localStorage.setItem("cryptodash:" + key, value); } catch (e) { /* ignore */ }
  }

  const symbolSelect = document.getElementById("symbol");
  const themeSelect = document.getElementById("theme");
  const symbols = config.symbols.includes(state.symbol)
    ? config.symbols
    : [state.symbol, ...config.symbols];
  symbols.forEach((s) => symbolSelect.add(new Option(label(s) + " — " + s, s)));
  symbolSelect.value = state.symbol;
  themeSelect.value = state.theme;
  document.body.classList.toggle("light", state.theme === "light");

  symbolSelect.addEventListener("change", () => {
    state.symbol = symbolSelect.value;
    localSet("symbol", state.symbol);
    render();
  });
  themeSelect.addEventListener("change", () => {
    state.theme = themeSelect.value;
    localSet("theme", state.theme);
    document.body.classList.toggle("light", state.theme === "light");
    render();
  });

  render();
})();

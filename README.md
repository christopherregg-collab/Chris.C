# My Trading Bot: dashboard

A one-screen dashboard for a crypto trading bot: performance, four strategy slots, trades,
scanner and risk. It runs on **demo data** until a live bot or exchange integration is connected.

- `/`: the bot dashboard (React + TypeScript).
- `/markets.html`: the earlier markets page, with TradingView charts and the indicator signals table.

See [BACKTEST.md](BACKTEST.md) for the backtester, [PAPER_TRADING.md](PAPER_TRADING.md) for the demo-account paper trader, [LIVE_TRADING.md](LIVE_TRADING.md) for trading real money, [ROADMAP.md](ROADMAP.md) for where this is heading, and [HANDOVER.md](HANDOVER.md) to pick the project up on your own computer.

## Run it

Node 20+.

```sh
npm install
npm run dev        # http://localhost:5173, also serves /api/* like Vercel does
npm test           # API and indicator tests (node:test) + dashboard calculation tests (Vitest)
npm run build      # typecheck, then production build into dist/
npm run backtest   # momentum backtest (see BACKTEST.md; needs npm run backtest:fetch first)
```

Production runs on a Hetzner server; Vercel only forwards to it. See "Live deployment" below.

## Layout

| Desktop (≥1100px) | Tablet (700–1099px) | Phone (<700px) |
| --- | --- | --- |
| 12-column grid. Performance spans 7 columns and Strategy 1 spans 5 (top row, 59% of the height). Six equal cards below (41%). Fits one screen down to about 1440 × 900. | Top cards side by side or stacked, with lower cards in 3 or 2 columns. The page scrolls. | Swipeable carousel with snap, pagination dots, a card counter, and previous/next buttons. |

Bottom row order: Strategy 2, Strategy 3, Strategy 4, Trades, Scanner, Risk.

## Where things live

| What | Where |
| --- | --- |
| Name, currency, time zone, exchange label | `src/config/dashboard.ts` |
| Default strategy slot details | `defaultStrategies` in `src/config/dashboard.ts` |
| The data model every card reads | `src/types.ts` (`DashboardData`) |
| All calculations (P&L, trading return, win rate, R, risk usage, freshness) | `src/lib/derive.ts` |
| Demo fixtures and scenarios | `src/data/demo.ts` |
| Data source selection | `src/data/adapter.ts` |
| Cards | `src/cards/` |

### Editing the four strategy slots

Click the pencil on any strategy card to set its name, description, timeframe, symbols and notes.
These edits are saved in the browser. To set defaults for everyone, edit `defaultStrategies`.

This is **display configuration only**. Saving it doesn't start, stop or change a strategy, and
the card's status (Flat, Watching, In position…) always comes from the bot's data. A slot you've
named but the bot doesn't report stays "Not configured".

### Demo scenarios

Open **Diagnostics** (the pulse icon) to switch the demo between Normal, Empty, Loading, Error,
Stale data and Bot disconnected. The header always shows a **Demo** badge in demo mode.

## Definitions

- **Equity**: balance plus unrealized P&L, as reported.
- **Today / Since start P&L**: the change in equity minus net deposits and withdrawals. The
  percentage is time-weighted.
- **Trading return** (chart): time-weighted. Each interval's return is (equity − cash flow) ÷ previous
  equity − 1, chained across the period, so deposits and withdrawals don't count as gains or
  losses. If the source can't report cash flows, the chart says the return is unavailable instead
  of relabeling equity.
- **Trades**: "entries today" counts trades opened since midnight in the display time zone. Win
  rate, Avg R, Closed and the outcome dots use trades closed in the last 7 days; open trades are
  never counted. R = realized P&L ÷ initial risk, and trades without initial risk are left out of
  Avg R (it shows n/a if none have it).
- **Risk**: cap usage = today's net realized loss ÷ daily loss cap. It resets at midnight in the
  display time zone, and a profitable day uses none of the cap. It turns amber from 50% and red
  from 80%. With no cap configured, the card shows "Set risk cap" instead of 0%.
- **Stale**: each card has its own source timestamp (`asOf`) and threshold
  (`STALE_AFTER_SEC` in `derive.ts`). A stale card keeps its last values and shows an amber badge.

## Connecting live data

1. Add `api/dashboard.js`, a serverless function that reads from your bot or exchange and returns
   JSON matching `DashboardData` in `src/types.ts`.
2. Keep credentials in Vercel environment variables, read only inside `api/`. Never put a key in
   `src/`, in a `VITE_*` variable (those are bundled into the browser), or in local storage.
3. Set `VITE_DATA_SOURCE=api` in Vercel's environment variables and redeploy.

The cards don't change, because the adapter is the only part that knows where data comes from.

## Live deployment (Hetzner + BloFin)

The live dashboard runs on a Hetzner Cloud server, not Vercel, because BloFin keys can be locked
to a fixed IP and the equity snapshots need an always-on process.

- `api/dashboard.js` reads BloFin through `server/blofin.js` (GET requests only) and returns
  `DashboardData`. Open positions appear in the Strategy 1 slot.
- `server/snapshots.js` records equity once an hour to `data/equity.jsonl`, since BloFin only
  reports current balances. Transfers into or out of the futures account are cash flows.
- `server/index.js` serves `dist/` and `/api/*` and listens on 127.0.0.1 only. Everything
  except `/login` needs a session: one user (`DASHBOARD_EMAIL`), a password stored as a
  salted scrypt hash, and a signed 7-day cookie (`server/auth.js`, `server/login-page.js`).
  Failed logins are delayed and rate-limited. Changing the password logs out every session. Caddy in front of it serves `https://2-29-115-23.sslip.io` with a Let's
  Encrypt certificate (`deploy/setup-https.sh`). The SSH tunnel (`deploy/open-dashboard.sh`)
  still works too.
- Vercel only forwards: `vercel.json` rewrites every path to the Hetzner server, and
  `.vercelignore` keeps `api/` from deploying as Vercel functions. Vercel holds no secrets.
  See `vercel-proxy/README.md` to undo this.
- Credentials go in `.env` (see `.env.example`), on the server at `/opt/trading-bot/.env`.

| Task | Command |
| --- | --- |
| First-time server setup (firewall, SSH keys only, auto-updates, Node) | `ssh root@SERVER 'bash -s' < deploy/setup-server.sh` |
| HTTPS with Caddy (opens ports 80/443) | `ssh root@SERVER 'HOSTNAME_FQDN=… bash -s' < deploy/setup-https.sh` |
| Build and deploy | `deploy/deploy.sh` |
| Set or change the login (asks for the password, sends only a hash) | `deploy/set-login.sh` |
| Open the dashboard | https://chrisc-ashen.vercel.app, or `deploy/open-dashboard.sh` over SSH |
| Logs | `ssh root@SERVER journalctl -u trading-bot -n 50` |

The BloFin key is whitelisted to the server's IPv4 address. The service runs Node with
`--dns-result-order=ipv4first`; without it the server connects over IPv6 and BloFin rejects
the request (code 152406).

## Markets page

`/markets.html` keeps the TradingView widgets and the signals table. That table scores each coin
on EMA 20/50 trend, MACD and RSI 14 using Coinbase public candles from `api/candles.js`, with no
key needed. The indicator code is in `lib/indicators.js`. To change its coin list, copy
`public/config.example.js` to `public/config.js`. The signals are a technical-analysis aid, not
financial advice.

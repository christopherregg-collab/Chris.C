# Handover: continuing this project locally

Everything needed to pick this up on your own computer, in a local Claude Code session or by hand.
Written at commit `57a4b20` on branch `claude/inspiring-keller-p0ukdo`.

## Where things stand

| Branch | What's on it |
| --- | --- |
| `claude/inspiring-keller-p0ukdo` | **All the current work.** The bot dashboard, the markets page, tests, docs. |
| `main` | Only the first commit (the original TradingView page). Vercel deploys from here, so the live site is out of date. |

Three commits, oldest first:

1. `4621580`: the first dashboard, made of TradingView widgets.
2. `92766f6`: a signals table (EMA/MACD/RSI on Coinbase candles) and `ROADMAP.md`.
3. `57a4b20`: rebuilt as a React + TypeScript one-screen bot dashboard. The earlier page moved to `/markets.html`.

Nothing is uncommitted. Everything runs on **demo data**. No exchange or bot is connected, and the
repo holds no API keys.

## Get it running locally

You need Node 20 or newer and git.

```sh
git clone https://github.com/christopherregg-collab/Chris.C.git
cd Chris.C
git checkout claude/inspiring-keller-p0ukdo
npm install
npm run dev          # open http://localhost:5173  (markets page: /markets.html)
```

Other commands:

```sh
npm test             # 14 API/indicator tests (node:test) + 18 dashboard calculation tests (Vitest)
npm run typecheck    # TypeScript, strict
npm run build        # typecheck + production build into dist/
npm run preview      # serve the built dist/ (no /api routes here; use npm run dev for those)
```

`npm run dev` also runs the `api/` serverless functions, through a small plugin in
`vite.config.ts`, so `/api/candles` works locally the same way it does on Vercel.

## Start a local Claude Code session

From the repo folder, on the branch above, run `claude`. A good first message:

> Read HANDOVER.md, README.md and ROADMAP.md. Then run `npm install`, `npm test` and
> `npm run build` and tell me if anything fails. Don't change anything yet.

Things the cloud session couldn't do, which a local one can (see "Not yet verified"):

- Load TradingView, Coinbase and Google Fonts. The cloud sandbox blocked them, so the live
  charts, the markets signals table with real prices, and the Inter font were never seen working.
- Open the Vercel preview in your browser.

## What's where

| Path | What it is |
| --- | --- |
| `index.html`, `src/main.tsx`, `src/App.tsx` | Bot dashboard entry, grid and phone carousel |
| `src/cards/` | Performance, Strategy (×4 slots), Trades, Scanner, Risk |
| `src/components/` | Header (search, diagnostics, notifications, theme), Modal, Card shell, AreaChart, Gauge, Sparkline, Icons |
| `src/types.ts` | `DashboardData`, the single data model every card reads |
| `src/lib/derive.ts` | Every calculation: P&L, trading return, trade stats, R, risk usage, staleness |
| `src/lib/derive.test.ts` | Tests for those calculations and for demo-data consistency |
| `src/data/adapter.ts` | Chooses the data source: demo (default) or `/api/dashboard` (`VITE_DATA_SOURCE=api`) |
| `src/data/demo.ts` | Demo fixtures and scenarios (normal, empty, loading, error, stale, disconnected) |
| `src/config/dashboard.ts` | Dashboard name, currency, time zone, exchange label, default strategy slots |
| `src/styles.css` | Theme tokens (dark and light), 12-column grid, tablet breakpoints, phone carousel |
| `markets.html`, `src/markets/` | Earlier page: TradingView widgets + signals table |
| `lib/indicators.js` | EMA, RSI, MACD and signal scoring (used by the markets page) |
| `api/candles.js` | Serverless function: Coinbase public candles, no key needed |
| `test/` | node:test suites for `lib/indicators.js` and `api/candles.js` |
| `vercel.json` | Tells Vercel to build with Vite and serve `dist/` |
| `README.md` | Usage, layout, definitions of every metric, how to connect live data |
| `ROADMAP.md` | Phased plan: BloFin read-only → signals → alerts → paper trading → live trading |

## Decisions already made

- **Framework.** React 19 + TypeScript + Vite. The spec asked for React + TS on a new project. The
  chart is a small custom SVG instead of a library, so tapping it and swiping the carousel don't
  fight each other.
- **Layout.** Your spec's composition: 12 columns, Performance spans 7, Strategy 1 spans 5, and six
  lower cards span 2 each. Rows split 59:41 to fill one screen (min height 800px, capped at 1180px).
  Tablets use 2 or 3 columns. Phones under 700px get a snapping carousel.
- **Strategy slots are display-only.** Edits from the pencil icon are saved in browser
  `localStorage` and only label the cards. The status (Flat, Watching, In position…) always comes
  from the data. A named slot the bot doesn't report stays "Not configured".
- **No invented strategy logic.** The four slots are empty placeholders. The Scanner shows only
  what the data source sends, and shows a score only when the source provides one.
- **Credentials stay server-side.** Keys go only in Vercel environment variables, read inside
  `api/`. Never in `src/`, a `VITE_*` variable (those reach the browser), or `localStorage`.
- **Exchange.** BloFin, connected **read-only** first. Its API uses a key, a secret and a passphrase.

## Verified

- All 32 unit tests pass. The strict typecheck and the production build succeed.
- In headless Chromium, with Vite's dev server:
  - Layout measured at 2048×1100, 1440×900, 1024×768, 768×1024, 390×844 and 430×932.
  - No page scroll at 1440×900, no horizontal page overflow anywhere, and no card content clipped.
  - 41 interaction checks pass: period and metric filters, chart hover, tap and keyboard
    inspection, dialogs (focus trap, Escape, focus returns), strategy editing and persistence,
    search, notifications, theme, all six demo scenarios, carousel buttons, dots and real touch
    swipes (including swipes that start on the chart), and the bottom sheet on phones.
- The markets page still builds and renders its signals table.

## Not yet verified

- **Real network data.** TradingView widgets, live Coinbase candles in the markets signals table,
  and the Inter font. All were blocked in the cloud sandbox. Check `npm run dev` locally, or the
  Vercel preview.
- **Vercel.** No deploy of this branch has been checked. `vercel.json` sets Vite, `npm run build`
  and `dist`, so it shouldn't depend on the project's dashboard settings. Earlier the project was
  set up with the "Other" preset, which `vercel.json` now overrides.
- **Real phones.** Touch behavior was tested only with emulated touch events.

## Open items, in order

1. **Check the preview, then merge to `main`.** Open the Vercel preview for
   `claude/inspiring-keller-p0ukdo`. If it looks right, merge it into `main` (a pull request, or
   `git checkout main && git merge claude/inspiring-keller-p0ukdo && git push`). Also confirm
   `main` is the repo's default branch in GitHub (Settings → General), because Vercel deploys from it.
2. **Connect BloFin read-only.** Full plan in `ROADMAP.md`, under "Next: connect BloFin":
   - Create a read-only API key in BloFin.
   - Add the key, secret and passphrase as Vercel environment variables, plus a local `.env`
     that's gitignored. Don't paste them into chat or code.
   - Write `api/dashboard.js` to call BloFin server-side and return `DashboardData`
     (see `src/types.ts`; the README has the contract).
   - Set `VITE_DATA_SOURCE=api` and redeploy.
   - Equity history: BloFin reports current balances, so the chart needs snapshots stored over
     time (a scheduled job and a small database), or a history rebuilt from fills.
3. **Fill in your four strategies.** Use the pencil on each card, or `defaultStrategies` in
   `src/config/dashboard.ts`.
4. **Pick up the later roadmap phases**: backtesting the signals, alerts, paper trading, then live
   trading with hard risk limits.

## Gotchas

- **Stuck in a demo scenario?** The Diagnostics panel (pulse icon) saves the chosen scenario in
  `localStorage` (`mtb:demo-scenario`). Set it back to "Normal" there.
- **Other browser storage keys**: `mtb:strategies:v1` (strategy display settings), `mtb:theme`, and
  `mtb:events-seen` (notification badge). `cryptodash:*` belongs to the markets page.
- **Build warning.** `npm run build` warns that `/config.js` in `markets.html` "can't be bundled".
  That's expected: it's the markets page's optional override file (copy
  `public/config.example.js` to `public/config.js`).
- **BNB on the markets page** shows "not listed on Coinbase": the signals use Coinbase USD
  markets, which don't list it.
- **Time zone.** "Today", the risk-cap reset and all timestamps use `displayTimezone` in
  `src/config/dashboard.ts` (default UTC).
- **Vercel Hobby plan** is for non-commercial use, and its cron jobs run at most once a day. That
  matters once alerts or equity snapshots need scheduling (see `ROADMAP.md`).

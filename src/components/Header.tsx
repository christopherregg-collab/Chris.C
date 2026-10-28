import { useMemo, useState } from "react";
import { SLOT_LABELS, dashboardConfig } from "../config/dashboard";
import { adapter, getDemoScenario, setDemoScenario } from "../data/adapter";
import { DEMO_SCENARIOS, type DemoScenario } from "../data/demo";
import type { LoadState } from "../hooks/useDashboard";
import type { Theme } from "../hooks/useTheme";
import { STALE_AFTER_SEC, freshness, ms, type Source } from "../lib/derive";
import { age, ago, fmtDateTime } from "../lib/format";
import { SLOTS, type DashboardData, type HealthStatus, type SlotId, type StrategyDisplayConfig } from "../types";
import { StatusDot } from "./Card";
import { BellIcon, LogoMark, MoonIcon, PulseIcon, SearchIcon, SunIcon } from "./Icons";
import { Modal } from "./Modal";

const HEALTH: Record<HealthStatus, { label: string; tone: "ok" | "warn" | "error" }> = {
  connected: { label: "Connected", tone: "ok" },
  no_heartbeat: { label: "No heartbeat", tone: "warn" },
  disconnected: { label: "Disconnected", tone: "error" },
};

const SEEN_KEY = "mtb:events-seen";
const readSeen = () => { try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; } };

type Panel = "search" | "diagnostics" | "notifications" | null;

export function Header({ state, now, theme, onToggleTheme, onReload, onGoTo, strategies }: {
  state: LoadState;
  now: number;
  theme: Theme;
  onToggleTheme: () => void;
  onReload: () => void;
  onGoTo: (cardId: string) => void;
  strategies: Record<SlotId, StrategyDisplayConfig>;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const [seen, setSeen] = useState(readSeen);
  const data = state.data;
  const unread = data ? data.events.filter((e) => ms(e.t) > seen).length : 0;

  const openNotifications = () => {
    setPanel("notifications");
    const t = Date.now();
    setSeen(t);
    try { localStorage.setItem(SEEN_KEY, String(t)); } catch { /* storage unavailable */ }
  };

  const health = data?.health;
  const healthInfo = health && HEALTH[health.status];
  // A stale "connected" report is downgraded to "no heartbeat"; worse states keep their own tone.
  const healthStale = health?.status === "connected" && freshness(health.asOf, now, "health").stale;

  return (
    <header className="topbar">
      <div className="brand">
        <LogoMark />
        <span className="brand-name">{dashboardConfig.name}</span>
        {adapter.kind === "demo" && (
          <span className="badge badge--demo" title="Showing demo fixtures, not a live bot or exchange account">Demo</span>
        )}
        {state.status === "loading" && <span className="health"><StatusDot tone="idle" /> Loading…</span>}
        {state.status === "error" && <span className="health health--error"><StatusDot tone="error" /> Data unavailable</span>}
        {healthInfo && health && (
          <span
            className={`health health--${healthStale ? "warn" : healthInfo.tone}`}
            title={data.mode === "demo" ? "Simulated by the demo data, not a live bot" : undefined}
          >
            <StatusDot tone={healthStale ? "warn" : healthInfo.tone} />
            <span className="health-label">
              {healthStale ? "No heartbeat" : healthInfo.label}
              {data.mode === "demo" && <span className="health-meta"> (simulated)</span>}
            </span>
            {health.lastSeen && <span className="health-meta">· {ago(ms(health.lastSeen), now)}</span>}
            {health.readiness && <span className="health-meta health-ready">· {health.readiness.ready}/{health.readiness.total} ready</span>}
          </span>
        )}
        {state.status === "ready" && state.error && (
          <button type="button" className="health health--error health--btn" onClick={() => setPanel("diagnostics")}>
            <StatusDot tone="error" /> Refresh failed
          </button>
        )}
      </div>
      <nav className="toolbar" aria-label="Dashboard tools">
        <button type="button" className="icon-btn" aria-label="Search" onClick={() => setPanel("search")} disabled={!data}>
          <SearchIcon />
        </button>
        <button type="button" className="icon-btn" aria-label="Diagnostics" onClick={() => setPanel("diagnostics")}>
          <PulseIcon />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={unread ? `Notifications, ${unread} new` : "Notifications"}
          onClick={openNotifications}
          disabled={!data}
        >
          <BellIcon />
          {unread > 0 && <span className="icon-badge" aria-hidden="true">{unread}</span>}
        </button>
        <button type="button" className="icon-btn" aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={onToggleTheme}>
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
      </nav>

      {panel === "search" && data && (
        <Modal title="Search" onClose={() => setPanel(null)}>
          <SearchPanel
            data={data}
            strategies={strategies}
            // Wait for the dialog to close (it restores focus to the Search button) before focusing the card.
            onPick={(id) => { setPanel(null); setTimeout(() => onGoTo(id), 0); }}
          />
        </Modal>
      )}
      {panel === "diagnostics" && (
        <Modal title="Diagnostics" onClose={() => setPanel(null)}>
          <Diagnostics state={state} now={now} onReload={onReload} />
        </Modal>
      )}
      {panel === "notifications" && data && (
        <Modal title="Notifications" subtitle={data.mode === "demo" ? "Demo events" : undefined} onClose={() => setPanel(null)}>
          {data.events.length === 0 ? (
            <p className="muted">No notifications.</p>
          ) : (
            <ul className="events">
              {[...data.events].sort((a, b) => ms(b.t) - ms(a.t)).map((e) => (
                <li key={e.id}>
                  <StatusDot tone={e.level === "success" ? "ok" : e.level === "warning" ? "warn" : e.level === "error" ? "error" : "info"} label={e.level} />
                  <div><p>{e.text}</p><time dateTime={e.t}>{fmtDateTime(e.t)}</time></div>
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}
    </header>
  );
}

function SearchPanel({ data, strategies, onPick }: {
  data: DashboardData;
  strategies: Record<SlotId, StrategyDisplayConfig>;
  onPick: (cardId: string) => void;
}) {
  const [q, setQ] = useState("");
  const index = useMemo(() => {
    const items: { key: string; text: string; detail: string; card: string }[] = [];
    for (const slot of SLOTS) {
      const name = strategies[slot].name || SLOT_LABELS[slot];
      items.push({ key: `s-${slot}`, text: name, detail: `Strategy · ${SLOT_LABELS[slot]}`, card: slot });
      for (const sym of strategies[slot].symbols) items.push({ key: `ss-${slot}-${sym}`, text: sym, detail: `Symbol in ${name}`, card: slot });
    }
    for (const s of data.strategies) {
      for (const p of s.positions) items.push({ key: `p-${p.id}`, text: p.symbol, detail: `Open ${p.side} · ${strategies[s.slot].name || SLOT_LABELS[s.slot]}`, card: s.slot });
    }
    for (const c of data.scanner.candidates) items.push({ key: `c-${c.symbol}-${c.slot}`, text: c.symbol, detail: `Scanner · ${c.signal}`, card: "scanner" });
    const traded = new Set(data.trades.items.map((t) => t.symbol));
    for (const sym of traded) items.push({ key: `t-${sym}`, text: sym, detail: "Recent trades", card: "trades" });
    return items;
  }, [data, strategies]);
  const needle = q.trim().toLowerCase();
  const results = needle ? index.filter((i) => i.text.toLowerCase().includes(needle) || i.detail.toLowerCase().includes(needle)) : [];

  return (
    <div className="search">
      <label htmlFor="search-input" className="sr-only">Search symbols and strategies</label>
      <input id="search-input" type="search" placeholder="Symbol or strategy, e.g. BTC" value={q} onChange={(e) => setQ(e.target.value)} data-autofocus autoComplete="off" />
      {needle && (results.length === 0 ? (
        <p className="muted">No matches for “{q}”.</p>
      ) : (
        <ul className="search-results">
          {results.slice(0, 30).map((r) => (
            <li key={r.key}>
              <button type="button" onClick={() => onPick(r.card)}>
                <strong>{r.text}</strong><span>{r.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      ))}
      {!needle && <p className="muted small">Searches strategy slots, open positions, scanner candidates and recently traded symbols.</p>}
    </div>
  );
}

function Diagnostics({ state, now, onReload }: { state: LoadState; now: number; onReload: () => void }) {
  const [scenario, setScenario] = useState<DemoScenario>(getDemoScenario);
  const data = state.data;
  const sources: [Source, string, string | undefined][] = data
    ? [
        ["health", "Bot health", data.health.asOf],
        ["account", "Account", data.account.asOf],
        ["performance", "Performance", data.performance.asOf],
        ["strategies", "Strategies", data.strategies[0]?.asOf],
        ["trades", "Trades", data.trades.asOf],
        ["scanner", "Scanner", data.scanner.asOf],
        ["risk", "Risk", data.risk.asOf],
      ]
    : [];

  return (
    <div className="diag">
      <dl className="mini-stats mini-stats--wide">
        <div><dt>Mode</dt><dd>{adapter.kind === "demo" ? "Demo (no live data)" : "Live API"}</dd></div>
        <div><dt>Data source</dt><dd>{adapter.describe}</dd></div>
        <div><dt>Exchange</dt><dd>{dashboardConfig.exchange || "Not connected"}</dd></div>
        <div><dt>Status</dt><dd>{state.status === "ready" ? (state.error ? "Last refresh failed" : "OK") : state.status === "loading" ? "Loading" : "Error"}</dd></div>
      </dl>
      {state.error && <p className="diag-error" role="alert">{state.error}</p>}
      {sources.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Source</th><th>Last update</th><th>Age</th><th>Stale after</th><th>State</th></tr></thead>
            <tbody>
              {sources.map(([key, label, asOf]) => {
                const f = asOf ? freshness(asOf, now, key) : null;
                return (
                  <tr key={key}>
                    <td>{label}</td>
                    <td>{asOf ? fmtDateTime(asOf) : "—"}</td>
                    <td>{f ? age(f.ageSec) : "—"}</td>
                    <td>{age(STALE_AFTER_SEC[key])}</td>
                    <td>{f ? (f.stale ? <span className="badge badge--stale">Stale</span> : "Fresh") : "No data"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {adapter.kind === "demo" && (
        <fieldset className="scenarios">
          <legend>Demo scenario</legend>
          {DEMO_SCENARIOS.map((s) => (
            <label key={s.id}>
              <input
                type="radio"
                name="scenario"
                value={s.id}
                checked={scenario === s.id}
                onChange={() => { setScenario(s.id); setDemoScenario(s.id); onReload(); }}
              />
              {s.label}
            </label>
          ))}
        </fieldset>
      )}
      <div className="form-actions">
        <button type="button" className="pill" onClick={onReload}>Reload data</button>
      </div>
    </div>
  );
}

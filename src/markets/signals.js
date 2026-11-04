import { evaluate } from "../../lib/indicators.js";

const REFRESH_MS = 60_000;
const { config, label, selectSymbol, getSymbol } = window.DASHBOARD;

const body = document.getElementById("signals-body");
const status = document.getElementById("signals-status");
const intervalSelect = document.getElementById("signals-interval");
const changeHead = document.getElementById("signals-change-head");

let interval = localGet("signals-interval") || "1h";
if (![...intervalSelect.options].some((o) => o.value === interval)) interval = "1h";
intervalSelect.value = interval;
let requestId = 0;
let timer = null;

const price = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumSignificantDigits: 6 });

async function loadOne(symbol) {
  const res = await fetch(`/api/candles?base=${encodeURIComponent(label(symbol))}&interval=${interval}`);
  // Session expired: go to the login page, then come back here.
  if (res.status === 401) location.assign(`/login?next=${encodeURIComponent(location.pathname)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  // Signals use finished candles only; the price column shows the live price.
  const s = evaluate(data.candles);
  const first = data.candles[0].time;
  const last = data.candles[data.candles.length - 1].time;
  return { ...s, livePrice: data.current?.close ?? s.price, spanSec: last - first };
}

// "15d", "3.6d", "11mo": the length of the window the Change column covers.
export function spanLabel(sec) {
  const days = sec / 86_400;
  if (days >= 60) return `${Math.round(days / 30.44)}mo`;
  if (days >= 10) return `${Math.round(days)}d`;
  if (days >= 1) return `${days.toFixed(1)}d`;
  return `${Math.round(sec / 3600)}h`;
}

async function refresh() {
  const id = ++requestId;
  clearTimeout(timer);
  status.textContent = "Updating…";
  const results = await Promise.allSettled(config.symbols.map(loadOne));
  if (id !== requestId) return; // a newer refresh superseded this one
  renderRows(results);
  const ok = results.find((r) => r.status === "fulfilled");
  changeHead.textContent = ok ? `Change (${spanLabel(ok.value.spanSec)})` : "Change";
  changeHead.title = ok ? `Price change from the first to the last finished ${interval} candle loaded` : "";
  const failed = results.filter((r) => r.status === "rejected").length;
  status.textContent = `Updated ${new Date().toLocaleTimeString()}` +
    (failed ? ` · ${failed} unavailable` : "");
  timer = setTimeout(refresh, REFRESH_MS);
}

function renderRows(results) {
  body.replaceChildren(...results.map((r, i) => {
    const symbol = config.symbols[i];
    const tr = document.createElement("tr");
    tr.dataset.symbol = symbol;
    tr.classList.toggle("is-selected", symbol === getSymbol());
    tr.addEventListener("click", () => selectSymbol(symbol));
    tr.append(cell(label(symbol)));

    if (r.status === "rejected") {
      const td = cell(r.reason.message, "flat");
      td.colSpan = 6;
      tr.append(td);
      return tr;
    }

    const s = r.value;
    const [trend, momentum, rsiCheck] = ["trend", "macd", "rsi"].map((id) => s.checks.find((c) => c.id === id));
    tr.append(
      cell(price.format(s.livePrice)),
      cell(`${s.changePct >= 0 ? "+" : ""}${s.changePct.toFixed(2)}%`, tone(s.changePct)),
      cell(`${s.rsi.toFixed(1)} · ${rsiCheck.note}`, tone(rsiCheck.score)),
      cell(momentum.note, tone(momentum.score)),
      cell(trend.note, tone(trend.score)),
    );
    const td = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `badge ${tone(s.score)}`;
    badge.textContent = s.label;
    badge.title = `Score ${s.score > 0 ? "+" : ""}${s.score} of ±3`;
    td.append(badge);
    tr.append(td);
    return tr;
  }));
}

function cell(text, cls) {
  const td = document.createElement("td");
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

function tone(n) {
  return n > 0 ? "up" : n < 0 ? "down" : "flat";
}

function localGet(key) {
  try { return localStorage.getItem("cryptodash:" + key); } catch (e) { return null; }
}
function localSet(key, value) {
  try { localStorage.setItem("cryptodash:" + key, value); } catch (e) { /* ignore */ }
}

intervalSelect.addEventListener("change", () => {
  interval = intervalSelect.value;
  localSet("signals-interval", interval);
  refresh();
});

document.addEventListener("dashboard:symbol", (e) => {
  for (const tr of body.rows) tr.classList.toggle("is-selected", tr.dataset.symbol === e.detail);
});

refresh();

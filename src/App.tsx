import { useCallback, useEffect, useRef, useState } from "react";
import { PerformanceCard } from "./cards/PerformanceCard";
import { RiskCard } from "./cards/RiskCard";
import { ScannerCard } from "./cards/ScannerCard";
import { StrategyCard } from "./cards/StrategyCard";
import { TradesCard } from "./cards/TradesCard";
import { Header } from "./components/Header";
import { ChevronLeft, ChevronRight } from "./components/Icons";
import { SLOT_LABELS, dashboardConfig } from "./config/dashboard";
import { useDashboard } from "./hooks/useDashboard";
import { useStrategies } from "./hooks/useStrategies";
import { useTheme } from "./hooks/useTheme";
import { SLOTS, type SlotId } from "./types";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function App() {
  const { state, now, reload } = useDashboard();
  const { strategies, save } = useStrategies();
  const { theme, toggle } = useTheme();
  const grid = useRef<HTMLElement>(null);
  const [slide, setSlide] = useState(0);

  const cardState = state.status;
  const common = { state: cardState, error: state.status === "error" ? state.error : undefined, onRetry: reload, now };
  const data = state.data;
  const currency = data?.currency ?? dashboardConfig.reportingCurrency;

  // Slide labels in carousel order (also the DOM order).
  const labels = ["Performance", ...SLOTS.map((s: SlotId) => strategies[s].name || SLOT_LABELS[s]), "Trades", "Scanner", "Risk"];

  const cards = () => [...(grid.current?.children ?? [])] as HTMLElement[];
  const isCarousel = () => grid.current !== null && getComputedStyle(grid.current).overflowX === "auto";

  const onScroll = useCallback(() => {
    const el = grid.current;
    if (!el) return;
    // Cards are positioned relative to the grid, so offsetLeft is in scroll coordinates.
    const pad = parseFloat(getComputedStyle(el).scrollPaddingLeft) || 0;
    const dist = (c: HTMLElement) => Math.abs(Math.min(c.offsetLeft - pad, el.scrollWidth - el.clientWidth) - el.scrollLeft);
    const items = cards();
    let best = 0;
    items.forEach((c, i) => { if (dist(c) < dist(items[best]!)) best = i; });
    setSlide(best);
  }, []);

  const goTo = useCallback((i: number) => {
    const el = grid.current;
    const target = cards()[i];
    if (!el || !target) return;
    const pad = parseFloat(getComputedStyle(el).scrollPaddingLeft) || 0;
    el.scrollTo({ left: target.offsetLeft - pad, behavior: reducedMotion() ? "auto" : "smooth" });
  }, []);

  /** Used by search: bring a card into view and move focus to it. */
  const goToCard = useCallback((cardId: string) => {
    const items = cards();
    const i = items.findIndex((c) => c.dataset.card === cardId);
    if (i === -1) return;
    const card = items[i]!;
    if (isCarousel()) goTo(i);
    else card.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    card.classList.add("card--flash");
    card.setAttribute("tabindex", "-1");
    card.focus({ preventScroll: true });
    setTimeout(() => card.classList.remove("card--flash"), 1200);
  }, [goTo]);

  useEffect(() => {
    const onResize = () => onScroll();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [onScroll]);

  return (
    <div className="shell">
      <Header
        state={state}
        now={now}
        theme={theme}
        onToggleTheme={toggle}
        onReload={reload}
        onGoTo={goToCard}
        strategies={strategies}
      />
      <main className="grid" ref={grid} onScroll={onScroll} aria-label="Dashboard cards">
        <PerformanceCard data={data} {...common} />
        {SLOTS.map((slot) => (
          <StrategyCard
            key={slot}
            slot={slot}
            featured={slot === "featured"}
            runtime={data?.strategies.find((s) => s.slot === slot)}
            config={strategies[slot]}
            onSave={save}
            currency={currency}
            {...common}
          />
        ))}
        <TradesCard data={data} strategies={strategies} {...common} />
        <ScannerCard data={data} strategies={strategies} {...common} />
        <RiskCard data={data} {...common} />
      </main>
      <nav className="carousel-nav" aria-label="Card navigation">
        <button type="button" className="icon-btn" onClick={() => goTo(slide - 1)} disabled={slide === 0} aria-label="Previous card">
          <ChevronLeft />
        </button>
        <div className="carousel-status">
          <span className="carousel-label" aria-live="polite">
            {labels[slide]} <span className="muted">{slide + 1} / {labels.length}</span>
          </span>
          <div className="dots">
            {labels.map((l, i) => (
              <button
                key={l + i}
                type="button"
                className="dot-btn"
                aria-label={`Go to ${l}`}
                aria-current={i === slide ? "true" : undefined}
                onClick={() => goTo(i)}
              />
            ))}
          </div>
        </div>
        <button type="button" className="icon-btn" onClick={() => goTo(slide + 1)} disabled={slide === labels.length - 1} aria-label="Next card">
          <ChevronRight />
        </button>
      </nav>
    </div>
  );
}

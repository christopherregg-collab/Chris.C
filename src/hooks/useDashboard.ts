import { useCallback, useEffect, useRef, useState } from "react";
import { adapter } from "../data/adapter";
import type { DashboardData } from "../types";

const REFRESH_MS = 30_000;
const CLOCK_MS = 15_000;

export type LoadState =
  | { status: "loading"; data?: undefined; error?: undefined }
  | { status: "ready"; data: DashboardData; error?: string }
  | { status: "error"; data?: undefined; error: string };

/**
 * Loads dashboard data, refreshes it every 30 s, and ticks a clock so
 * freshness badges age even between refreshes. A failed refresh keeps the
 * last good data (cards then turn stale on their own) and reports the error.
 */
export function useDashboard() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [now, setNow] = useState(() => Date.now());
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    try {
      const data = await adapter.load(ac.signal);
      if (ac.signal.aborted) return;
      setState({ status: "ready", data });
    } catch (err) {
      if (ac.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      setState((prev) => (prev.status === "ready" ? { ...prev, error: message } : { status: "error", error: message }));
    } finally {
      setNow(Date.now());
    }
  }, []);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    void load();
  }, [load]);

  useEffect(() => {
    void load();
    const refresh = setInterval(() => void load(), REFRESH_MS);
    const clock = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => {
      clearInterval(refresh);
      clearInterval(clock);
      controller.current?.abort();
    };
  }, [load]);

  return { state, now, reload };
}

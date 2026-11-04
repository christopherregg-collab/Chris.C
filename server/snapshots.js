// Equity history. BloFin reports only the current balance, so the server
// records one snapshot per hour to a JSON-lines file:
//   {"t":"2026-11-04T14:00:03.120Z","equity":1234.56,"cashFlow":0}
// cashFlow is the net transfer into the futures account since the previous snapshot.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createClient, credentialsFromEnv, fetchAccount, fetchCashFlowSince } from "./blofin.js";

export const SNAPSHOT_FILE = process.env.SNAPSHOT_FILE || "data/equity.jsonl";
const HOUR = 3_600_000;

export function readSnapshots(file = SNAPSHOT_FILE) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const p = JSON.parse(line);
        return typeof p.t === "string" && Number.isFinite(p.equity) ? [{ t: p.t, equity: p.equity, cashFlow: Number(p.cashFlow) || 0 }] : [];
      } catch {
        return [];
      }
    });
}

export function appendSnapshot(point, file = SNAPSHOT_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(point) + "\n");
}

/** Take a snapshot unless one already exists for the current hour. Returns the new point or null. */
export async function snapshotIfDue(client, { file = SNAPSHOT_FILE, nowMs = Date.now() } = {}) {
  const points = readSnapshots(file);
  const last = points[points.length - 1];
  if (last && Math.floor(Date.parse(last.t) / HOUR) === Math.floor(nowMs / HOUR)) return null;
  const { equity } = await fetchAccount(client);
  const cashFlow = last ? await fetchCashFlowSince(client, Date.parse(last.t)) : 0;
  const point = { t: new Date(nowMs).toISOString(), equity: round2(equity), cashFlow: round2(cashFlow) };
  appendSnapshot(point, file);
  return point;
}

const round2 = (n) => Math.round(n * 100) / 100;

/** Check every minute; records at most one snapshot per hour. */
export function startSnapshotJob(log = console) {
  const creds = credentialsFromEnv();
  if (!creds) {
    log.warn("snapshots: BloFin credentials not set, equity history is not being recorded");
    return () => {};
  }
  const client = createClient(creds);
  const tick = () =>
    snapshotIfDue(client)
      .then((p) => p && log.info(`snapshot ${p.t} equity=${p.equity} cashFlow=${p.cashFlow}`))
      .catch((err) => log.error(`snapshot failed: ${err.message}`));
  tick();
  const id = setInterval(tick, 60_000);
  return () => clearInterval(id);
}

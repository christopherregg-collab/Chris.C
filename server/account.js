// Which BloFin account the dashboard reads: the real one (default) or the DEMO account the
// paper trader uses. Set DASHBOARD_ACCOUNT=demo in .env (deploy/dashboard-account.sh does it).
// Either way the dashboard only reads; it never places orders.

import { BLOFIN_BASE, createClient, credentialsFromEnv } from "./blofin.js";
import { DEMO_BASE, demoCredentialsFromEnv } from "../lib/trader/blofin-exchange.js";

export function dashboardAccount(env = process.env) {
  if (env.DASHBOARD_ACCOUNT === "demo") {
    return {
      kind: "demo",
      label: "BloFin demo account",
      creds: demoCredentialsFromEnv(env),
      base: DEMO_BASE,
      // A separate equity history, so demo and real balances never mix on the chart.
      snapshotFile: env.DEMO_SNAPSHOT_FILE || "data/equity-demo.jsonl",
    };
  }
  return {
    kind: "real",
    label: "BloFin",
    creds: credentialsFromEnv(env),
    base: BLOFIN_BASE,
    snapshotFile: env.SNAPSHOT_FILE || "data/equity.jsonl",
  };
}

export function accountClient(account) {
  return account.creds ? createClient(account.creds, { base: account.base }) : null;
}

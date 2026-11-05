#!/usr/bin/env node
// Asks BloFin for demo trading funds on the DEMO account, then shows the futures balance.
//   bash deploy/demo-funds.sh
import { createTradingClient, demoCredentialsFromEnv } from "../lib/trader/blofin-exchange.js";

const creds = demoCredentialsFromEnv();
if (!creds) {
  console.error("Missing BLOFIN_DEMO_* keys in .env.");
  process.exit(1);
}
const client = createTradingClient(creds); // demo only
const balance = async () => {
  const bal = await client.get("/api/v1/account/balance");
  const usdt = (bal?.details ?? []).find((d) => d.currency === "USDT");
  return `total equity ${bal?.totalEquity ?? "?"}, USDT available ${usdt?.available ?? "0"}`;
};
console.log(`Before: ${await balance()}`);
try {
  const res = await client.post("/api/v1/asset/demo-apply-money", {});
  console.log("BloFin accepted the demo funds request:", JSON.stringify(res));
} catch (err) {
  console.log(`BloFin refused the demo funds request: ${err.message}`);
  console.log("Use BloFin's website instead: switch to Demo Trading and look for a button to get or reset demo funds.");
}
console.log(`After:  ${await balance()}`);

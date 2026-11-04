import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPath, createClient, credentialsFromEnv, sign } from "../server/blofin.js";
import { readSnapshots, snapshotIfDue } from "../server/snapshots.js";
import { buildDashboard } from "../api/dashboard.js";
import { authorized } from "../server/index.js";

test("sign is base64 of the hex HMAC string, as BloFin documents", () => {
  const hex = createHmac("sha256", "s3cret").update("abc").digest("hex");
  assert.equal(sign("s3cret", "abc"), Buffer.from(hex).toString("base64"));
  assert.equal(Buffer.from(sign("s3cret", "abc"), "base64").toString(), hex);
});

test("buildPath drops empty params", () => {
  assert.equal(buildPath("/a", { x: 1, y: undefined, z: "" }), "/a?x=1");
  assert.equal(buildPath("/a"), "/a");
});

test("credentialsFromEnv needs all three values", () => {
  assert.equal(credentialsFromEnv({ BLOFIN_API_KEY: "k", BLOFIN_API_SECRET: "s" }), null);
  assert.deepEqual(credentialsFromEnv({ BLOFIN_API_KEY: "k", BLOFIN_API_SECRET: "s", BLOFIN_API_PASSPHRASE: "p" }), { key: "k", secret: "s", passphrase: "p" });
});

test("client signs path+query, method, timestamp and nonce", async () => {
  let seen;
  const client = createClient(
    { key: "K", secret: "S", passphrase: "P" },
    {
      now: () => 1700000000000,
      nonce: () => "n1",
      fetchImpl: async (url, opts) => {
        seen = { url, headers: opts.headers };
        return { ok: true, status: 200, json: async () => ({ code: "0", msg: "", data: [1] }) };
      },
    },
  );
  assert.deepEqual(await client.get("/api/v1/asset/balances", { accountType: "futures" }), [1]);
  assert.equal(seen.url, "https://openapi.blofin.com/api/v1/asset/balances?accountType=futures");
  assert.equal(seen.headers["ACCESS-SIGN"], sign("S", "/api/v1/asset/balances?accountType=futuresGET1700000000000n1"));
  assert.equal(seen.headers["ACCESS-PASSPHRASE"], "P");
});

test("client throws on a non-zero code", async () => {
  const client = createClient({ key: "K", secret: "S", passphrase: "P" }, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: "152409", msg: "Signature verification failed" }) }),
  });
  await assert.rejects(client.get("/x"), /Signature verification failed/);
});

// A fake BloFin answering the endpoints the dashboard uses.
const NOW = Date.parse("2026-11-04T15:30:00Z");
function fakeClient(overrides = {}) {
  const data = {
    "/api/v1/account/balance": { totalEquity: "1050.5", details: [{ currency: "USDT", available: "800" }] },
    "/api/v1/account/positions": [
      { positionId: "11", instId: "BTC-USDT", positionSide: "net", positions: "-20", averagePrice: "70000", markPrice: "69000", leverage: "5", unrealizedPnl: "20", createTime: String(NOW - 3_600_000) },
      { positionId: "12", instId: "ETH-USDT", positionSide: "long", positions: "0", averagePrice: "1", markPrice: "1", unrealizedPnl: "0", createTime: String(NOW) },
    ],
    "/api/v1/trade/orders-tpsl-pending": [{ positionId: "11", instId: "BTC-USDT", state: "live", slTriggerPrice: "71000", tpTriggerPrice: "65000" }],
    "/api/v1/market/instruments": [{ instId: "BTC-USDT", contractValue: "0.001" }],
    "/api/v1/account/positions-history": [{ historyId: "9", instId: "SOL-USDT", positionSide: "long", side: "buy", createTime: String(NOW - 2 * 86_400_000), updateTime: String(NOW - 86_400_000), realizedPnl: "-12.5" }],
    "/api/v1/asset/bills": (p) => (p.toAccount === "futures" ? [{ currency: "USDT", amount: "100", ts: String(NOW - 600_000) }] : []),
    ...overrides,
  };
  return { get: async (path, params = {}) => (typeof data[path] === "function" ? data[path](params) : data[path]) };
}

const FAKE_SCAN = { asOf: new Date(NOW).toISOString(), criteria: "test", candidates: [{ symbol: "BTC-USD", signal: "Buy", score: 2, updatedAt: new Date(NOW).toISOString() }] };
const fakeScanner = async () => FAKE_SCAN;

test("buildDashboard maps BloFin data into DashboardData", async () => {
  const snapshots = [{ t: "2026-11-04T15:00:00.000Z", equity: 900, cashFlow: 0 }];
  const d = await buildDashboard(fakeClient(), { nowMs: NOW, snapshots, dailyLossCap: 50, scanner: fakeScanner });
  assert.equal(d.mode, "live");
  assert.deepEqual(d.account, { asOf: new Date(NOW).toISOString(), equity: 1050.5, available: 800 });
  assert.equal(d.performance.points.length, 2);
  assert.deepEqual(d.performance.points[1], { t: new Date(NOW).toISOString(), equity: 1050.5, cashFlow: 100 });

  const [pos] = d.strategies[0].positions;
  assert.equal(d.strategies[0].positions.length, 1, "zero-size positions are dropped");
  assert.equal(pos.side, "short");
  assert.equal(pos.size, 0.02);
  assert.equal(pos.stopPrice, 71000);
  assert.equal(pos.targetPrice, 65000);
  assert.equal(d.strategies[0].status, "in_position");

  const closed = d.trades.items.find((t) => t.id === "ph-9");
  assert.equal(closed.realizedPnl, -12.5);
  assert.ok(closed.closedAt);
  assert.ok(d.trades.items.find((t) => t.id === "open-11" && !t.closedAt));
  assert.equal(d.risk.dailyLossCap, 50);
  assert.equal(d.scanner, FAKE_SCAN, "scanner output is passed through");
  assert.equal(d.performance.asOf, new Date(NOW).toISOString(), "recent snapshot: performance is fresh");
});

test("buildDashboard flags overdue equity snapshots via performance.asOf", async () => {
  const old = "2026-11-04T13:00:00.000Z"; // 2.5 hours before NOW
  const d = await buildDashboard(fakeClient(), { nowMs: NOW, snapshots: [{ t: old, equity: 900, cashFlow: 0 }], scanner: fakeScanner });
  assert.equal(d.performance.asOf, old);
  assert.equal(d.account.asOf, new Date(NOW).toISOString(), "other sections stay fresh");
});

test("buildDashboard with no snapshots yet uses the live point as baseline", async () => {
  const d = await buildDashboard(fakeClient({ "/api/v1/account/positions": [] }), { nowMs: NOW, scanner: fakeScanner });
  assert.equal(d.performance.points.length, 1);
  assert.equal(d.performance.points[0].cashFlow, 0);
  assert.equal(d.strategies[0].status, "flat");
});

test("snapshotIfDue records at most one snapshot per hour", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snap-"));
  const file = join(dir, "equity.jsonl");
  try {
    assert.ok(await snapshotIfDue(fakeClient(), { file, nowMs: NOW - 3_600_000 }));
    assert.equal(await snapshotIfDue(fakeClient(), { file, nowMs: NOW - 3_000_000 }), null);
    const next = await snapshotIfDue(fakeClient(), { file, nowMs: NOW });
    assert.equal(next.cashFlow, 100);
    assert.equal(readSnapshots(file).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("basic auth accepts only the configured login", () => {
  const h = (s) => "Basic " + Buffer.from(s).toString("base64");
  assert.equal(authorized(h("me:pw"), "me", "pw"), true);
  assert.equal(authorized(h("me:nope"), "me", "pw"), false);
  assert.equal(authorized(undefined, "me", "pw"), false);
  assert.equal(authorized(h("me:pw"), "", ""), false, "no password configured means locked");
});

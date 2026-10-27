import test from "node:test";
import assert from "node:assert/strict";
import handler, { parseCoinbase, fetchCandles } from "../api/candles.js";

test("parseCoinbase maps rows and sorts oldest first", () => {
  const rows = [
    [7200, 9, 12, 10, 11, 5],
    [3600, 8, 11, 9, 10, 4],
  ];
  assert.deepEqual(parseCoinbase(rows), [
    { time: 3600, open: 9, high: 11, low: 8, close: 10, volume: 4 },
    { time: 7200, open: 10, high: 12, low: 9, close: 11, volume: 5 },
  ]);
});

test("parseCoinbase rejects error payloads", () => {
  assert.throws(() => parseCoinbase({ message: "NotFound" }), /unexpected/);
});

test("fetchCandles builds the Coinbase URL and maps a 404 to 'not listed'", async () => {
  let seen;
  const fake = async (url) => { seen = url; return { ok: false, status: 404 }; };
  await assert.rejects(fetchCandles("BNB", "1h", fake), (e) => e.status === 404 && /not listed/.test(e.message));
  assert.equal(seen, "https://api.exchange.coinbase.com/products/BNB-USD/candles?granularity=3600");
});

function fakeRes() {
  return {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    end(body) { this.body = JSON.parse(body); },
  };
}

test("handler validates input", async () => {
  const res = fakeRes();
  await handler({ url: "/api/candles?base=BTC&interval=4h" }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /interval/);

  const res2 = fakeRes();
  await handler({ url: "/api/candles?base=../etc" }, res2);
  assert.equal(res2.statusCode, 400);
});

test("handler returns candles with a CDN cache header", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => [[3600, 1, 2, 1, 2, 10]],
  }));
  const res = fakeRes();
  await handler({ url: "/api/candles?base=eth&interval=15m" }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.base, "ETH");
  assert.equal(res.body.candles.length, 1);
  assert.match(res.headers["Cache-Control"], /s-maxage=60/);
});

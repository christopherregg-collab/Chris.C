import test from "node:test";
import assert from "node:assert/strict";
import {
  authConfig, checkLogin, createLimiter, createSession, hashPassword, MAX_FAILS_PER_CLIENT,
  parseCookies, readSession, safeNext, SESSION_TTL_SEC, verifyPassword,
} from "../server/auth.js";
import { renderLogin } from "../server/login-page.js";
import { createApp } from "../server/index.js";

const PASSWORD = "correct horse battery staple";
const HASH = hashPassword(PASSWORD);
const ENV = { DASHBOARD_EMAIL: "Owner@Example.com", DASHBOARD_PASSWORD_HASH: HASH, SESSION_SECRET: "s".repeat(64) };

test("password hashes verify only the right password and are salted", () => {
  assert.ok(verifyPassword(PASSWORD, HASH));
  assert.ok(!verifyPassword("wrong", HASH));
  assert.notEqual(hashPassword(PASSWORD), HASH, "same password, different salt");
  assert.ok(!verifyPassword(PASSWORD, "garbage"));
});

test("checkLogin: email is case-insensitive, password exact, unconfigured always fails", () => {
  const cfg = authConfig(ENV);
  assert.ok(checkLogin(cfg, " owner@example.COM ", PASSWORD));
  assert.ok(!checkLogin(cfg, "owner@example.com", PASSWORD.toUpperCase()));
  assert.ok(!checkLogin(cfg, "someone@else.com", PASSWORD));
  assert.ok(!checkLogin(authConfig({}), "", ""));
  assert.ok(checkLogin(authConfig({ DASHBOARD_EMAIL: "a@b.c", DASHBOARD_PASSWORD: "plain-dev-pass" }), "a@b.c", "plain-dev-pass"));
});

test("sessions: valid, expire, reject tampering, and die when the password changes", () => {
  const cfg = authConfig(ENV);
  const now = 1_800_000_000;
  const token = createSession(cfg, now);
  assert.deepEqual(readSession(cfg, token, now + 10), { email: "owner@example.com", expires: now + SESSION_TTL_SEC });
  assert.equal(readSession(cfg, token, now + SESSION_TTL_SEC + 1), null, "expired");

  const [payload, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ e: "owner@example.com", x: now + 10 * SESSION_TTL_SEC })).toString("base64url");
  assert.equal(readSession(cfg, `${forged}.${sig}`, now), null, "payload changed");
  assert.equal(readSession(cfg, `${payload}.x${sig.slice(1)}`, now), null, "signature changed");
  assert.equal(readSession(cfg, "nonsense", now), null);

  const newPassword = authConfig({ ...ENV, DASHBOARD_PASSWORD_HASH: hashPassword("a new password!!") });
  assert.equal(readSession(newPassword, token, now), null, "password change logs out");
  const newSecret = authConfig({ ...ENV, SESSION_SECRET: "t".repeat(64) });
  assert.equal(readSession(newSecret, token, now), null, "secret change logs out");
});

test("safeNext only allows same-site paths", () => {
  assert.equal(safeNext("/markets.html?x=1"), "/markets.html?x=1");
  for (const bad of ["https://evil.com", "//evil.com", "/\\evil.com", "javascript:alert(1)", "", null, "/login", "/logout"]) {
    assert.equal(safeNext(bad), "/", String(bad));
  }
});

test("parseCookies", () => {
  assert.deepEqual(parseCookies("a=1; session=x.y%3D; b"), { a: "1", session: "x.y=" });
});

test("limiter blocks a client after repeated failures, and success resets it", () => {
  const l = createLimiter();
  const t = 1_000_000;
  for (let i = 0; i < MAX_FAILS_PER_CLIENT; i++) l.fail("1.2.3.4", t);
  assert.ok(l.blockedFor("1.2.3.4", t + 1000) > 0);
  assert.equal(l.blockedFor("5.6.7.8", t + 1000), 0, "other clients unaffected");
  assert.equal(l.blockedFor("1.2.3.4", t + 16 * 60_000), 0, "window passes");
  l.fail("9.9.9.9", t); l.succeed("9.9.9.9");
  assert.equal(l.blockedFor("9.9.9.9", t), 0);
});

test("login page escapes what it echoes back", () => {
  const html = renderLogin({ email: '"><script>x</script>', next: "/a\"b", error: "<b>" });
  assert.ok(!html.includes("<script>x"));
  assert.ok(html.includes("&quot;&gt;&lt;script&gt;"));
  assert.ok(html.includes("&lt;b&gt;"));
});

// ---- end to end against the real server

async function withServer(fn) {
  const server = createApp({ env: ENV, failDelayMs: 0 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

const post = (url, fields, headers = {}) =>
  fetch(url, { method: "POST", redirect: "manual", body: new URLSearchParams(fields), headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers } });

test("server: pages redirect to login, API answers 401, login sets a cookie that works", async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/markets.html`, { redirect: "manual" });
    assert.equal(page.status, 303);
    assert.equal(page.headers.get("location"), "/login?next=%2Fmarkets.html");

    const api = await fetch(`${base}/api/dashboard`);
    assert.equal(api.status, 401);
    assert.equal((await api.json()).login, "/login");

    const loginPage = await fetch(`${base}/login`);
    assert.equal(loginPage.status, 200);
    assert.match(await loginPage.text(), /<form method="post" action="\/login"/);
    assert.equal(loginPage.headers.get("cache-control"), "no-store");

    const bad = await post(`${base}/login`, { email: "owner@example.com", password: "nope", next: "/" });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get("set-cookie"), null);
    assert.match(await bad.text(), /don&#39;t match/);

    const good = await post(`${base}/login`, { email: "OWNER@example.com", password: PASSWORD, next: "https://evil.com" });
    assert.equal(good.status, 303);
    assert.equal(good.headers.get("location"), "/", "external next is ignored");
    const cookie = good.headers.get("set-cookie");
    assert.match(cookie, /^session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800$/);
    const session = cookie.split(";")[0];

    // Logged in: the API is reachable (the 404 proves we got past the login check).
    const authed = await fetch(`${base}/api/nope`, { headers: { cookie: session } });
    assert.equal(authed.status, 404);
    const again = await fetch(`${base}/login?next=/markets.html`, { headers: { cookie: session }, redirect: "manual" });
    assert.equal(again.headers.get("location"), "/markets.html", "already logged in skips the form");

    const out = await post(`${base}/logout`, {}, { cookie: session });
    assert.equal(out.status, 303);
    assert.equal(out.headers.get("location"), "/login?loggedout");
    assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal((await fetch(`${base}/logout`)).status, 405, "logout is POST only");
  });
});

test("server: too many failed logins are refused even with the right password", async () => {
  await withServer(async (base) => {
    for (let i = 0; i < MAX_FAILS_PER_CLIENT; i++) {
      assert.equal((await post(`${base}/login`, { email: "owner@example.com", password: "nope" })).status, 401);
    }
    const blocked = await post(`${base}/login`, { email: "owner@example.com", password: PASSWORD });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("set-cookie"), null);
  });
});

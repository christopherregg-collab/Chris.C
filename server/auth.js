// Single-user login for the dashboard: an email address and a password, checked
// on the server, then a signed session cookie.
//
// .env settings:
//   DASHBOARD_EMAIL          the one account that can log in
//   DASHBOARD_PASSWORD_HASH  scrypt hash from `node server/auth.js hash` (preferred)
//   DASHBOARD_PASSWORD       plain password; only used if no hash is set (local dev)
//   SESSION_SECRET           random string that signs session cookies
//
// Sessions are stateless: the cookie holds the email and an expiry, signed with
// HMAC-SHA256. The signing key mixes in the password hash, so changing the
// password logs out every existing session.

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";

export const COOKIE = "session";
export const SESSION_TTL_SEC = 7 * 24 * 3600;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

let fallbackSecret;

export function authConfig(env = process.env) {
  let secret = env.SESSION_SECRET;
  if (!secret) {
    // Works, but every restart logs you out. Set SESSION_SECRET to avoid that.
    fallbackSecret ??= randomBytes(32).toString("hex");
    secret = fallbackSecret;
  }
  return {
    email: (env.DASHBOARD_EMAIL || "").trim().toLowerCase(),
    passwordHash: env.DASHBOARD_PASSWORD_HASH || "",
    password: env.DASHBOARD_PASSWORD || "",
    secret,
    secretIsEphemeral: !env.SESSION_SECRET,
  };
}

export function isConfigured(cfg) {
  return Boolean(cfg.email && (cfg.passwordHash || cfg.password));
}

// ---------------------------------------------------------------- passwords

export function hashPassword(password, salt = randomBytes(16)) {
  const { N, r, p, keylen } = SCRYPT;
  const key = scryptSync(password, salt, keylen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, "base64");
  const actual = scryptSync(String(password), Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(actual, expected);
}

function safeEqual(a, b) {
  // Compare fixed-length digests so neither length nor content leaks through timing.
  const x = createHash("sha256").update(String(a)).digest();
  const y = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(x, y);
}

export function checkLogin(cfg, email, password) {
  if (!isConfigured(cfg)) return false;
  const emailOk = safeEqual(String(email || "").trim().toLowerCase(), cfg.email);
  const passOk = cfg.passwordHash ? verifyPassword(password ?? "", cfg.passwordHash) : safeEqual(password ?? "", cfg.password);
  return emailOk && passOk;
}

// ---------------------------------------------------------------- sessions

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function signingKey(cfg) {
  // Changing the password (or the secret) invalidates every issued cookie.
  return createHash("sha256").update(`${cfg.secret}\n${cfg.passwordHash || cfg.password}`).digest();
}

export function createSession(cfg, nowSec = Math.floor(Date.now() / 1000)) {
  const payload = b64url(JSON.stringify({ e: cfg.email, x: nowSec + SESSION_TTL_SEC }));
  const sig = b64url(createHmac("sha256", signingKey(cfg)).update(payload).digest());
  return `${payload}.${sig}`;
}

export function readSession(cfg, token, nowSec = Math.floor(Date.now() / 1000)) {
  if (!isConfigured(cfg) || typeof token !== "string") return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = b64url(createHmac("sha256", signingKey(cfg)).update(payload).digest());
  if (!safeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (data.e !== cfg.email || !(data.x > nowSec)) return null;
    return { email: data.e, expires: data.x };
  } catch {
    return null;
  }
}

export function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SEC}`;
}

export const CLEAR_COOKIE = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** Only same-site paths are allowed after login, so the form can't redirect elsewhere. */
export function safeNext(next) {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (next === "/login" || next.startsWith("/login?") || next.startsWith("/logout")) return "/";
  return next;
}

// ---------------------------------------------------------------- rate limiting

const WINDOW_MS = 15 * 60_000;
export const MAX_FAILS_PER_CLIENT = 5;
export const MAX_FAILS_TOTAL = 50;

/** Failed-login limiter: per client, plus a global cap against distributed guessing. */
export function createLimiter() {
  const clients = new Map();
  let total = [];
  const prune = (list, now) => list.filter((t) => now - t < WINDOW_MS);
  return {
    /** Seconds until this client may try again, or 0 if allowed. */
    blockedFor(client, now = Date.now()) {
      total = prune(total, now);
      const mine = prune(clients.get(client) ?? [], now);
      clients.set(client, mine);
      const waits = [];
      if (mine.length >= MAX_FAILS_PER_CLIENT) waits.push(mine[0] + WINDOW_MS - now);
      if (total.length >= MAX_FAILS_TOTAL) waits.push(total[0] + WINDOW_MS - now);
      return waits.length ? Math.ceil(Math.max(...waits) / 1000) : 0;
    },
    fail(client, now = Date.now()) {
      clients.set(client, [...prune(clients.get(client) ?? [], now), now]);
      total.push(now);
    },
    succeed(client) {
      clients.delete(client);
    },
  };
}

// ---------------------------------------------------------------- CLI

// `node server/auth.js hash` reads a password on stdin and prints its hash.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename) && process.argv[2] === "hash") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    const password = input.replace(/\r?\n$/, "");
    if (password.length < 12) {
      console.error("Password must be at least 12 characters.");
      process.exit(1);
    }
    console.log(hashPassword(password));
  });
}

// Production server for the Hetzner box: serves the built dashboard (dist/),
// runs the api/*.js handlers, records hourly equity snapshots, and requires a
// login (single user, see server/auth.js) for everything except the login page.
//
//   npm run build:live && npm start
//
// Listens on 127.0.0.1:3000 by default; Caddy in front provides HTTPS.

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { startSnapshotJob } from "./snapshots.js";
import {
  CLEAR_COOKIE, COOKIE, authConfig, checkLogin, createLimiter, createSession, isConfigured,
  parseCookies, readSession, safeNext, sessionCookie,
} from "./auth.js";
import { LOGIN_CSP, renderLogin } from "./login-page.js";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT) || 3000;
const FAIL_DELAY_MS = Number(process.env.LOGIN_FAIL_DELAY_MS ?? 750);

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain",
};

const API = {
  dashboard: () => import("../api/dashboard.js"),
  candles: () => import("../api/candles.js"),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/") rel = "/index.html";
  const file = normalize(join(DIST, rel));
  if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
    res.statusCode = 404;
    return res.end("Not found");
  }
  res.setHeader("Content-Type", TYPES[extname(file)] || "application/octet-stream");
  // "private": everything here is behind the login, so shared caches (Vercel in
  // front of this server) must not store it and serve it to anyone else.
  res.setHeader("Cache-Control", rel.startsWith("/assets/") ? "private, max-age=31536000, immutable" : "private, no-cache");
  createReadStream(file).pipe(res);
}

function readForm(req, limit = 4096) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(Object.assign(new Error("form too large"), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => resolveBody(new URLSearchParams(body)));
    req.on("error", reject);
  });
}

/** The client's address as Caddy reports it (Caddy replaces any X-Forwarded-For it doesn't trust). */
function clientId(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff[xff.length - 1] || req.socket.remoteAddress || "unknown";
}

function sendLogin(res, status, opts) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", LOGIN_CSP);
  res.end(renderLogin(opts));
}

function redirect(res, location, cookie) {
  res.statusCode = 303;
  res.setHeader("Location", location);
  res.setHeader("Cache-Control", "no-store");
  if (cookie) res.setHeader("Set-Cookie", cookie);
  res.end();
}

export function createApp({ env = process.env, limiter = createLimiter(), failDelayMs = FAIL_DELAY_MS } = {}) {
  return createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const cfg = authConfig(env);
    const url = new URL(req.url, "http://localhost");
    const session = readSession(cfg, parseCookies(req.headers.cookie)[COOKIE]);

    try {
      // ---- login / logout (reachable without a session)
      if (url.pathname === "/login") {
        const next = safeNext(url.searchParams.get("next") ?? "/");
        if (req.method === "GET" || req.method === "HEAD") {
          if (session) return redirect(res, next);
          const notice = !isConfigured(cfg)
            ? "Login isn't set up on the server yet (DASHBOARD_EMAIL and a password in .env)."
            : url.searchParams.has("loggedout") ? "You're logged out." : "";
          return sendLogin(res, 200, { next, notice });
        }
        if (req.method !== "POST") { res.statusCode = 405; return res.end(); }

        const client = clientId(req);
        const wait = limiter.blockedFor(client);
        const form = await readForm(req);
        const formNext = safeNext(form.get("next") ?? "/");
        const email = form.get("email") ?? "";
        if (wait) {
          return sendLogin(res, 429, { next: formNext, email, error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? "s" : ""}.` });
        }
        if (checkLogin(cfg, email, form.get("password") ?? "")) {
          limiter.succeed(client);
          console.log(`login ok from ${client}`);
          return redirect(res, formNext, sessionCookie(createSession(cfg)));
        }
        limiter.fail(client);
        console.warn(`login failed from ${client}`);
        await sleep(failDelayMs);
        return sendLogin(res, 401, { next: formNext, email, error: "That email and password don't match." });
      }

      if (url.pathname === "/logout") {
        if (req.method !== "POST") { res.statusCode = 405; return res.end(); }
        return redirect(res, "/login?loggedout", CLEAR_COOKIE);
      }

      // ---- everything else needs a session
      if (!session) {
        if (url.pathname.startsWith("/api/")) {
          res.statusCode = 401;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          return res.end(JSON.stringify({ error: "Not logged in.", login: "/login" }));
        }
        return redirect(res, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
      }

      const api = /^\/api\/([\w-]+)$/.exec(url.pathname);
      if (api) {
        if (req.method !== "GET" || !API[api[1]]) {
          res.statusCode = 404;
          return res.end(JSON.stringify({ error: "not found" }));
        }
        const mod = await API[api[1]]();
        return await mod.default(req, res);
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        return res.end();
      }
      return serveStatic(url.pathname, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.statusCode = err.status || 500;
      res.end(err.status === 413 ? "Request too large" : "Internal error");
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const cfg = authConfig();
  if (!isConfigured(cfg)) console.warn("Login not configured: set DASHBOARD_EMAIL and DASHBOARD_PASSWORD_HASH in .env.");
  if (cfg.secretIsEphemeral) console.warn("SESSION_SECRET not set: sessions end whenever the server restarts.");
  startSnapshotJob();
  createApp().listen(PORT, HOST, () => console.log(`dashboard on http://${HOST}:${PORT}`));
}

// Production server for the Hetzner box: serves the built dashboard (dist/),
// runs the api/*.js handlers, records hourly equity snapshots, and requires a
// password (HTTP Basic auth) on everything.
//
//   npm run build:live && npm start
//
// Listens on 127.0.0.1:3000 by default; Caddy in front provides HTTPS.

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { startSnapshotJob } from "./snapshots.js";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT) || 3000;
const USER = process.env.DASHBOARD_USER || "";
const PASS = process.env.DASHBOARD_PASSWORD || "";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain",
};

const API = {
  dashboard: () => import("../api/dashboard.js"),
  candles: () => import("../api/candles.js"),
};

function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function authorized(header, user = USER, pass = PASS) {
  if (!user || !pass) return false;
  const m = /^Basic (.+)$/.exec(header || "");
  if (!m) return false;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const i = decoded.indexOf(":");
  return i > 0 && safeEqual(decoded.slice(0, i), user) && safeEqual(decoded.slice(i + 1), pass);
}

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/") rel = "/index.html";
  const file = normalize(join(DIST, rel));
  if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
    res.statusCode = 404;
    return res.end("Not found");
  }
  res.setHeader("Content-Type", TYPES[extname(file)] || "application/octet-stream");
  // "private": everything here is behind the password, so shared caches (Vercel in
  // front of this server) must not store it and serve it to anyone else.
  res.setHeader("Cache-Control", rel.startsWith("/assets/") ? "private, max-age=31536000, immutable" : "private, no-cache");
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (!authorized(req.headers.authorization)) {
    res.statusCode = 401;
    res.setHeader("WWW-Authenticate", 'Basic realm="Trading dashboard", charset="UTF-8"');
    return res.end(USER && PASS ? "Password required" : "Set DASHBOARD_USER and DASHBOARD_PASSWORD in .env");
  }
  const url = new URL(req.url, "http://localhost");
  const api = /^\/api\/([\w-]+)$/.exec(url.pathname);
  try {
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
    res.statusCode = 500;
    res.end("Internal error");
  }
});

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (!USER || !PASS) console.warn("DASHBOARD_USER / DASHBOARD_PASSWORD not set: every request will be refused.");
  startSnapshotJob();
  server.listen(PORT, HOST, () => console.log(`dashboard on http://${HOST}:${PORT}`));
}

// The login page, rendered on the server. Self-contained (inline CSS, no
// scripts) because nothing else is served until you're logged in.

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const LOGIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export function renderLogin({ next = "/", email = "", error = "", notice = "" } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Log in · My Trading Bot</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --border: #262b36; --text: #e8eaf0; --muted: #9097a6;
    --accent: #3b5bdb; --accent-hover: #4c6ef5; --error-bg: #3a1d22; --error: #ff8a95;
    --input: #0f1218; --focus: #748ffc;
    color-scheme: dark;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f4f5f8; --panel: #ffffff; --border: #dde1e8; --text: #161a23; --muted: #5d6576;
      --accent: #3b5bdb; --accent-hover: #364fc7; --error-bg: #fdecee; --error: #b4232f;
      --input: #ffffff; --focus: #3b5bdb;
      color-scheme: light;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    display: grid; place-items: center; padding: 24px 16px;
  }
  main { width: 100%; max-width: 380px; }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; font-weight: 600; font-size: 16px; }
  .logo { width: 30px; height: 30px; border-radius: 8px; background: var(--accent); display: grid; place-items: center; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 28px 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { margin: 0 0 22px; color: var(--muted); font-size: 14px; }
  label { display: block; font-size: 13px; font-weight: 500; margin: 0 0 6px; }
  input[type=email], input[type=password] {
    width: 100%; padding: 10px 12px; margin-bottom: 16px; font: inherit; color: var(--text);
    background: var(--input); border: 1px solid var(--border); border-radius: 9px;
  }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  button {
    width: 100%; padding: 11px 14px; margin-top: 4px; font: inherit; font-weight: 600; color: #fff;
    background: var(--accent); border: 0; border-radius: 9px; cursor: pointer;
  }
  button:hover { background: var(--accent-hover); }
  .msg { border-radius: 9px; padding: 10px 12px; font-size: 14px; margin-bottom: 18px; }
  .msg--error { background: var(--error-bg); color: var(--error); }
  .msg--notice { background: transparent; border: 1px solid var(--border); color: var(--muted); }
  .foot { text-align: center; color: var(--muted); font-size: 12px; margin-top: 16px; }
</style>
</head>
<body>
<main>
  <div class="brand">
    <span class="logo" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg></span>
    My Trading Bot
  </div>
  <div class="card">
    <h1>Log in</h1>
    <p class="sub">This dashboard shows a private exchange account.</p>
    ${error ? `<div class="msg msg--error" role="alert">${esc(error)}</div>` : ""}
    ${notice ? `<div class="msg msg--notice" role="status">${esc(notice)}</div>` : ""}
    <form method="post" action="/login" novalidate>
      <input type="hidden" name="next" value="${esc(next)}">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required autofocus value="${esc(email)}">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Log in</button>
    </form>
  </div>
  <p class="foot">Sessions last 7 days on this device.</p>
</main>
</body>
</html>`;
}

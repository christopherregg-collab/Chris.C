# Vercel proxy

Vercel no longer builds or runs this app. `vercel.json` forwards every request to
the Hetzner server (`https://2-29-115-23.sslip.io`), which serves the live
dashboard behind its password. Vercel holds no secrets.

This folder is Vercel's output directory. It must exist, so it holds this file;
`.vercelignore` keeps `api/` from being deployed as Vercel functions, which would
otherwise answer `/api/*` instead of the server.

To move the dashboard back onto Vercel, restore the earlier `vercel.json`
(framework `vite`, build `npm run build`, output `dist`) and delete `.vercelignore`.

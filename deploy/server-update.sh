#!/bin/bash
# Run ON THE SERVER (e.g. in Hetzner's browser console) to update everything from GitHub:
# the dashboard, the backtester and the paper trader. No local computer needed.
#   curl -fsSL -o update.sh raw.githubusercontent.com/christopherregg-collab/Chris.C/claude/inspiring-keller-p0ukdo/deploy/server-update.sh
#   bash update.sh
#
# Keeps .env, data/ (equity history, paper trader state) and any local public/config.js.
# The dashboard is built into a separate folder and swapped in only if the build works,
# so a failed update leaves the running dashboard as it was.
set -euo pipefail
APP="${APP:-/opt/trading-bot}"
BRANCH="${BRANCH:-claude/inspiring-keller-p0ukdo}"
REPO="christopherregg-collab/Chris.C"
export PATH="/opt/node/bin:$PATH"

cd "$APP"
echo "== Downloading the latest code ($BRANCH)"
tmp="$(mktemp -d)"
trap 'rm -r -- "$tmp"' EXIT
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz -C "$tmp" --strip-components=1
mkdir -p "$tmp/data"
cp -r "$tmp/." "$APP/"

echo "== Installing build tools"
npm ci --no-audit --no-fund --loglevel=error

echo "== Building the dashboard"
VITE_DATA_SOURCE=api npx tsc --noEmit
VITE_DATA_SOURCE=api npx vite build --outDir dist.new --emptyOutDir --logLevel warn
if [ -d dist ]; then mv dist dist.old; fi
mv dist.new dist
if [ -d dist.old ]; then rm -r -- dist.old; fi

if [ "${SKIP_SYSTEMD:-0}" = 1 ]; then echo "== SKIP_SYSTEMD=1: built, not restarting"; exit 0; fi
chown -R bot:bot "$APP"
chmod 600 "$APP/.env" 2>/dev/null || true

echo "== Restarting"
install -m 644 deploy/trading-bot.service /etc/systemd/system/trading-bot.service
install -m 644 deploy/paper-trader.service /etc/systemd/system/paper-trader.service
install -m 644 deploy/paper-trader.timer /etc/systemd/system/paper-trader.timer
systemctl daemon-reload
systemctl restart trading-bot
sleep 3
echo "Dashboard: $(systemctl is-active trading-bot)"
if systemctl is-enabled paper-trader.timer >/dev/null 2>&1; then
  echo "Paper trader timer: $(systemctl is-active paper-trader.timer)"
fi
echo "== Done. Reload the dashboard in your browser."

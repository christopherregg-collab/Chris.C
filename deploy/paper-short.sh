#!/bin/bash
# Run ON THE SERVER: start or stop paper trading Big Swing Short (demo experiment) on the DEMO account.
#   bash deploy/paper-short.sh          start (dry run first, then the 5-minute timer)
#   bash deploy/paper-short.sh stop     stop (state and log are kept)
set -euo pipefail
cd /opt/trading-bot
if [ "${1:-}" = "stop" ]; then
  systemctl disable --now paper-short.timer >/dev/null 2>&1 || true
  echo "Big Swing Short (demo experiment) paper trading stopped."
  exit 0
fi
install -m 644 deploy/paper-short.service /etc/systemd/system/paper-short.service
install -m 644 deploy/paper-short.timer /etc/systemd/system/paper-short.timer
systemctl daemon-reload
echo "== Dry run (live prices, no orders)"
runuser -u bot -- /opt/node/bin/node --dns-result-order=ipv4first scripts/paper-trader.js --short --dry-run || true
systemctl enable --now paper-short.timer >/dev/null
echo
echo "== Big Swing Short (demo experiment) paper trading is on: one step every 5 minutes."
echo "Status:  runuser -u bot -- node scripts/paper-trader.js --short --status"

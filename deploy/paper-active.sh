#!/bin/bash
# Run ON THE SERVER: start or stop paper trading Active Swing on the DEMO account.
#   bash deploy/paper-active.sh          start (dry run first, then the 5-minute timer)
#   bash deploy/paper-active.sh stop     stop (state and log are kept)
set -euo pipefail
cd /opt/trading-bot
if [ "${1:-}" = "stop" ]; then
  systemctl disable --now paper-active.timer >/dev/null 2>&1 || true
  echo "Active Swing paper trading stopped."
  exit 0
fi
install -m 644 deploy/paper-active.service /etc/systemd/system/paper-active.service
install -m 644 deploy/paper-active.timer /etc/systemd/system/paper-active.timer
systemctl daemon-reload
echo "== Dry run (live prices, no orders)"
runuser -u bot -- /opt/node/bin/node --dns-result-order=ipv4first scripts/paper-trader.js --active --dry-run || true
systemctl enable --now paper-active.timer >/dev/null
echo
echo "== Active Swing paper trading is on: one step every 5 minutes."
echo "Status:  runuser -u bot -- node scripts/paper-trader.js --active --status"

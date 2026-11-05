#!/bin/bash
# Installs and starts the paper trader timer on the server (runs one step every 5 minutes).
#   deploy/deploy.sh                  first, so the server has the latest code
#   deploy/setup-paper-trader.sh      install + dry run + first real step + enable the timer
#   deploy/setup-paper-trader.sh stop disable the timer (state and log are kept)
# The demo keys (BLOFIN_DEMO_API_KEY/SECRET/PASSPHRASE) must already be in /opt/trading-bot/.env.
set -euo pipefail
SERVER="${SERVER:-root@2.29.115.23}"
KEY="${KEY:-$HOME/.ssh/hetzner_bot}"
SSH="ssh -i $KEY -o IdentitiesOnly=yes"

if [ "${1:-}" = "stop" ]; then
  $SSH "$SERVER" 'systemctl disable --now paper-trader.timer && echo "Paper trader stopped."'
  exit 0
fi

$SSH "$SERVER" '
  set -e
  cd /opt/trading-bot
  grep -q "^BLOFIN_DEMO_API_KEY=." .env || { echo "Add BLOFIN_DEMO_API_KEY, BLOFIN_DEMO_API_SECRET and BLOFIN_DEMO_API_PASSPHRASE to /opt/trading-bot/.env first."; exit 1; }
  install -m 644 deploy/paper-trader.service /etc/systemd/system/paper-trader.service
  install -m 644 deploy/paper-trader.timer /etc/systemd/system/paper-trader.timer
  systemctl daemon-reload
  echo "--- dry run (live prices, no orders) ---"
  sudo -u bot node --dns-result-order=ipv4first scripts/paper-trader.js --dry-run
  echo "--- first step on the demo account ---"
  systemctl start paper-trader.service
  journalctl -u paper-trader.service -n 30 --no-pager
  systemctl enable --now paper-trader.timer
  systemctl list-timers paper-trader.timer --no-pager
'

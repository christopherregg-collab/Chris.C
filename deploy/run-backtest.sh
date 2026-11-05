#!/bin/bash
# Runs the momentum backtest on the server, which can reach BloFin, and copies the
# report back to data/backtest/ on this computer.
#   deploy/run-backtest.sh              download fresh data, then backtest
#   deploy/run-backtest.sh --no-fetch   reuse the data already on the server
# Run deploy/deploy.sh first so the server has the latest backtester code.
set -euo pipefail
SERVER="${SERVER:-root@2.29.115.23}"
KEY="${KEY:-$HOME/.ssh/hetzner_bot}"
SSH="ssh -i $KEY -o IdentitiesOnly=yes"
cd "$(dirname "$0")/.."

FETCH=1
[ "${1:-}" = "--no-fetch" ] && FETCH=0

$SSH "$SERVER" "
  set -e
  cd /opt/trading-bot
  if [ $FETCH = 1 ]; then sudo -u bot node --dns-result-order=ipv4first scripts/fetch-blofin.js; fi
  sudo -u bot node --dns-result-order=ipv4first scripts/backtest.js
"
mkdir -p data/backtest
scp -i "$KEY" -o IdentitiesOnly=yes "$SERVER:/opt/trading-bot/data/backtest/report.*" data/backtest/
echo "Report copied to data/backtest/report.md"

#!/bin/bash
# Run ON THE SERVER: choose which BloFin account the dashboard shows.
#   bash deploy/dashboard-account.sh demo   the DEMO (paper trading) account
#   bash deploy/dashboard-account.sh real   your real account (read-only key)
# The dashboard only ever reads. Each account keeps its own equity history.
set -euo pipefail
ENV=/opt/trading-bot/.env
case "${1:-}" in
  demo|real) ;;
  *) echo "Usage: bash deploy/dashboard-account.sh demo|real"; exit 1 ;;
esac
sed -i '/^DASHBOARD_ACCOUNT=/d' "$ENV"
echo "DASHBOARD_ACCOUNT=$1" >> "$ENV"
systemctl restart trading-bot
sleep 2
echo "Dashboard now shows the $1 account ($(systemctl is-active trading-bot)). Reload it in your browser."

#!/bin/bash
# Run ON THE SERVER to start trading REAL money with the backtested Big Swing rules.
#   bash deploy/go-live.sh         set up keys (first time), smoke-test the real account, start
#   bash deploy/go-live.sh stop    stop live trading (open positions keep their stop-losses on BloFin)
#
# What it does:
#   1. asks for a SEPARATE BloFin key for your real account (trade permission, NO withdrawal,
#      bound to this server's IP) if one isn't saved yet, and turns LIVE_TRADING on in .env;
#   2. runs the smoke test on the real account: one minimum-size BTC trade, opened and closed
#      within about 30 seconds (costs a few cents);
#   3. only if every step passes, starts the live timer (one step every 5 minutes).
set -euo pipefail
APP=/opt/trading-bot
ENV="$APP/.env"
cd "$APP"

if [ "${1:-}" = "stop" ]; then
  systemctl disable --now live-trader.timer >/dev/null 2>&1 || true
  sed -i 's/^LIVE_TRADING=.*/LIVE_TRADING=off/' "$ENV"
  echo "Live trading stopped. Open positions keep their stop-losses on BloFin; close them there if you want out now."
  exit 0
fi

if ! grep -q '^BLOFIN_TRADE_API_KEY=.' "$ENV"; then
  echo "== Real-account trading key"
  echo "In BloFin (NOT demo mode): API Management > create key with Read + Trade, NO withdrawal,"
  echo "IP whitelist 2.29.115.23. Use a different key from the dashboard's read-only one."
  read -rp  "Trade API key: " K < /dev/tty
  read -rsp "Trade API secret (hidden): " S < /dev/tty; echo
  read -rsp "Trade API passphrase (hidden): " P < /dev/tty; echo
  if [ -z "$K" ] || [ -z "$S" ] || [ -z "$P" ]; then echo "All three are needed. Run again."; exit 1; fi
  sed -i '/^BLOFIN_TRADE_API_/d' "$ENV"
  printf 'BLOFIN_TRADE_API_KEY=%s\nBLOFIN_TRADE_API_SECRET=%s\nBLOFIN_TRADE_API_PASSPHRASE=%s\n' "$K" "$S" "$P" >> "$ENV"
  unset K S P
fi
sed -i '/^LIVE_TRADING=/d' "$ENV"
echo "LIVE_TRADING=on" >> "$ENV"
chown bot:bot "$ENV"
chmod 600 "$ENV"

echo
echo "== Smoke test on the REAL account (one minimum-size BTC trade, opened and closed)"
if ! runuser -u bot -- /opt/node/bin/node --dns-result-order=ipv4first --env-file=.env scripts/smoke-test.js --live; then
  sed -i 's/^LIVE_TRADING=.*/LIVE_TRADING=off/' "$ENV"
  echo
  echo "Smoke test failed, so live trading stays OFF. Send the output above to Claude."
  exit 1
fi

install -m 644 deploy/live-trader.service /etc/systemd/system/live-trader.service
install -m 644 deploy/live-trader.timer /etc/systemd/system/live-trader.timer
systemctl daemon-reload
systemctl enable --now live-trader.timer >/dev/null
echo
echo "== LIVE trading is ON: one step every 5 minutes."
echo "Status:  runuser -u bot -- node scripts/paper-trader.js --live --status"
echo "Stop:    bash deploy/go-live.sh stop"

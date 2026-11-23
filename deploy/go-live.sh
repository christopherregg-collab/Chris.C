#!/bin/bash
# Run ON THE SERVER to trade REAL money with one of the bots.
#   bash deploy/go-live.sh short         Big Swing Short (experimental)
#   bash deploy/go-live.sh swing         Big Swing (the default if no bot is named)
#   bash deploy/go-live.sh active        Active Swing
#   bash deploy/go-live.sh stop short    stop one bot (open positions keep their BloFin stops)
#   bash deploy/go-live.sh stop          stop ALL live bots and turn LIVE_TRADING off
#
# Starting a bot:
#   1. asks for a SEPARATE BloFin key for your real account (trade permission, NO withdrawal,
#      bound to this server's IP) if one isn't saved yet, and turns LIVE_TRADING on in .env;
#   2. runs the smoke test on the real account: one minimum-size BTC trade, opened and closed
#      within about 30 seconds (costs a few cents);
#   3. only if every step passes, starts that bot's live timer (one step every 5 minutes).
set -euo pipefail
APP=/opt/trading-bot
ENV="$APP/.env"
cd "$APP"

unit_for() {
  case "$1" in
    swing) echo live-trader ;;
    active) echo live-active ;;
    short) echo live-short ;;
    *) echo "Unknown bot '$1': use swing, active or short." >&2; exit 1 ;;
  esac
}
flags_for() {
  case "$1" in
    swing) echo "--live" ;;
    active) echo "--live --active" ;;
    short) echo "--live --short" ;;
  esac
}

if [ "${1:-}" = "stop" ]; then
  if [ -n "${2:-}" ]; then
    unit=$(unit_for "$2")
    systemctl disable --now "$unit.timer" >/dev/null 2>&1 || true
    echo "Live $2 stopped. Its open positions keep their stop-losses on BloFin; close them there if you want out now."
  else
    for unit in live-trader live-active live-short; do systemctl disable --now "$unit.timer" >/dev/null 2>&1 || true; done
    sed -i 's/^LIVE_TRADING=.*/LIVE_TRADING=off/' "$ENV"
    echo "All live bots stopped and LIVE_TRADING is off. Open positions keep their stop-losses on BloFin; close them there if you want out now."
  fi
  exit 0
fi

BOT="${1:-swing}"
UNIT=$(unit_for "$BOT")

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
WAS_LIVE=$(grep -c '^LIVE_TRADING=on' "$ENV" || true)
sed -i '/^LIVE_TRADING=/d' "$ENV"
echo "LIVE_TRADING=on" >> "$ENV"
chown bot:bot "$ENV"
chmod 600 "$ENV"

echo
echo "== Smoke test on the REAL account (one minimum-size BTC trade, opened and closed)"
if ! runuser -u bot -- /opt/node/bin/node --dns-result-order=ipv4first --env-file=.env scripts/smoke-test.js --live; then
  # Leave live trading as it was for any bot already running; otherwise turn it back off.
  if [ "$WAS_LIVE" = "0" ]; then sed -i 's/^LIVE_TRADING=.*/LIVE_TRADING=off/' "$ENV"; fi
  echo
  echo "Smoke test failed, so the $BOT bot was NOT started. Send the output above to Claude."
  exit 1
fi

install -m 644 "deploy/$UNIT.service" "/etc/systemd/system/$UNIT.service"
install -m 644 "deploy/$UNIT.timer" "/etc/systemd/system/$UNIT.timer"
systemctl daemon-reload
echo
echo "== Dry run of the $BOT bot on live prices (no orders)"
runuser -u bot -- /opt/node/bin/node --dns-result-order=ipv4first scripts/paper-trader.js $(flags_for "$BOT") --dry-run || true
systemctl enable --now "$UNIT.timer" >/dev/null
echo
echo "== LIVE $BOT is ON: one step every 5 minutes, with real money."
echo "Status:  runuser -u bot -- node scripts/paper-trader.js $(flags_for "$BOT") --status"
echo "Log:     journalctl -u $UNIT.service -n 30"
echo "Stop:    bash deploy/go-live.sh stop $BOT      (or: bash deploy/go-live.sh stop   for all)"

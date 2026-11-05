#!/bin/bash
# Run ON THE SERVER (e.g. in Hetzner's browser console) to install or update the paper
# trader without a local computer:
#   curl -fsSL https://raw.githubusercontent.com/christopherregg-collab/Chris.C/claude/inspiring-keller-p0ukdo/deploy/server-install-paper.sh | bash
#
# It downloads the latest backtester/paper-trader code from GitHub (lib/, scripts/, deploy/,
# package.json; the dashboard is left as it is), asks for the BloFin DEMO API keys if they
# aren't set yet (hidden input, saved only in /opt/trading-bot/.env), does a dry run, one
# real step on the demo account, then turns on the 5-minute timer.
set -euo pipefail
APP="${APP:-/opt/trading-bot}"
BRANCH="${BRANCH:-claude/inspiring-keller-p0ukdo}"
REPO="christopherregg-collab/Chris.C"

cd "$APP"
echo "== Downloading the latest code ($BRANCH)"
tmp="$(mktemp -d)"
trap 'rm -r -- "$tmp"' EXIT
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz -C "$tmp" --strip-components=1
for d in lib scripts deploy; do
  mkdir -p "$APP/$d"
  cp -r "$tmp/$d/." "$APP/$d/"
done
cp "$tmp/package.json" "$APP/package.json"
mkdir -p "$APP/data"
touch "$APP/.env"

if ! grep -q '^BLOFIN_DEMO_API_KEY=.' "$APP/.env"; then
  echo
  echo "== BloFin DEMO API keys (from BloFin's demo trading mode, NOT your real account)"
  read -rp  "Demo API key: " K < /dev/tty
  read -rsp "Demo API secret (hidden): " S < /dev/tty; echo
  read -rsp "Demo API passphrase (hidden): " P < /dev/tty; echo
  if [ -z "$K" ] || [ -z "$S" ] || [ -z "$P" ]; then echo "All three are needed. Run the command again."; exit 1; fi
  sed -i '/^BLOFIN_DEMO_API_/d' "$APP/.env"
  printf 'BLOFIN_DEMO_API_KEY=%s\nBLOFIN_DEMO_API_SECRET=%s\nBLOFIN_DEMO_API_PASSPHRASE=%s\n' "$K" "$S" "$P" >> "$APP/.env"
  unset K S P
  echo "Saved to $APP/.env"
fi
chmod 600 "$APP/.env"
if id bot >/dev/null 2>&1; then chown -R bot:bot "$APP"; fi

if [ "${SKIP_SYSTEMD:-0}" = 1 ]; then echo "== SKIP_SYSTEMD=1: files installed, not starting"; exit 0; fi

install -m 644 "$APP/deploy/paper-trader.service" /etc/systemd/system/paper-trader.service
install -m 644 "$APP/deploy/paper-trader.timer" /etc/systemd/system/paper-trader.timer
systemctl daemon-reload

echo
echo "== Dry run (live prices, no orders)"
runuser -u bot -- node --dns-result-order=ipv4first scripts/paper-trader.js --dry-run || true

echo
echo "== First step on the demo account"
systemctl start paper-trader.service || true
journalctl -u paper-trader.service -n 25 --no-pager

systemctl enable --now paper-trader.timer >/dev/null
echo
echo "== Paper trader is on: it runs every 5 minutes."
echo "Status:  cd $APP && runuser -u bot -- node scripts/paper-trader.js --status"
echo "Stop:    systemctl disable --now paper-trader.timer"

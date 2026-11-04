#!/bin/bash
# Build locally and push the app to the server, then restart it.
#   deploy/deploy.sh            (uses SERVER below)
# Never copies .env: credentials are set on the server separately.
set -euo pipefail
SERVER="${SERVER:-root@2.29.115.23}"
KEY="${KEY:-$HOME/.ssh/hetzner_bot}"
SSH="ssh -i $KEY -o IdentitiesOnly=yes"
cd "$(dirname "$0")/.."

npm run build:live
rsync -az --delete -e "$SSH" \
  --exclude .env --exclude '.env.*' --exclude node_modules --exclude data/ --exclude .git \
  ./ "$SERVER:/opt/trading-bot/"
$SSH "$SERVER" '
  set -e
  cd /opt/trading-bot
  install -m 644 deploy/trading-bot.service /etc/systemd/system/trading-bot.service
  mkdir -p data && chown -R bot:bot /opt/trading-bot
  systemctl daemon-reload
  systemctl enable trading-bot >/dev/null 2>&1
  systemctl restart trading-bot
  sleep 2
  systemctl is-active trading-bot
'

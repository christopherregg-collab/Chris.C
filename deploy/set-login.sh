#!/bin/bash
# Set or change the dashboard login. Run it yourself, in a terminal:
#   deploy/set-login.sh                     (email defaults to the one below)
#   deploy/set-login.sh you@example.com
#
# You type the password twice; it's never shown, never sent anywhere in plain
# text, and never written to disk. Only a salted scrypt hash goes to the server.
# Changing the password logs out every existing session.
set -euo pipefail
cd "$(dirname "$0")/.."

EMAIL="${1:-christopherregg@gmail.com}"
SERVER="${SERVER:-root@2.29.115.23}"
KEY="${KEY:-$HOME/.ssh/hetzner_bot}"
NODE="$(command -v node || echo "$HOME/.local/node/bin/node")"

echo "Setting the dashboard login for $EMAIL"
read -rs -p "New password (at least 12 characters): " P1; echo
read -rs -p "Type it again: " P2; echo
if [ "$P1" != "$P2" ]; then echo "The two passwords don't match. Nothing changed."; exit 1; fi
HASH="$(printf '%s' "$P1" | "$NODE" server/auth.js hash)" || { echo "Nothing changed."; exit 1; }
unset P1 P2

# Server: replace the login lines, keep everything else, create SESSION_SECRET once.
printf '%s\n%s\n' "$EMAIL" "$HASH" | ssh -i "$KEY" -o IdentitiesOnly=yes "$SERVER" '
  set -e
  read -r EMAIL; read -r HASH
  f=/opt/trading-bot/.env
  umask 077
  grep -vE "^(DASHBOARD_USER|DASHBOARD_PASSWORD|DASHBOARD_PASSWORD_HASH|DASHBOARD_EMAIL)=" "$f" > "$f.tmp" || true
  grep -q "^SESSION_SECRET=" "$f.tmp" || echo "SESSION_SECRET=$(openssl rand -hex 32)" >> "$f.tmp"
  printf "DASHBOARD_EMAIL=%s\nDASHBOARD_PASSWORD_HASH=%s\n" "$EMAIL" "$HASH" >> "$f.tmp"
  chown bot:bot "$f.tmp"; chmod 600 "$f.tmp"; mv "$f.tmp" "$f"
  systemctl restart trading-bot
  sleep 2
  echo "server: login updated, dashboard $(systemctl is-active trading-bot)"
'

# Local .env (for running the server on this Mac): same login, no plain-text password.
if [ -f .env ]; then
  umask 077
  grep -vE '^(DASHBOARD_USER|DASHBOARD_PASSWORD|DASHBOARD_PASSWORD_HASH|DASHBOARD_EMAIL)=' .env > .env.tmp || true
  printf 'DASHBOARD_EMAIL=%s\nDASHBOARD_PASSWORD_HASH=%s\n' "$EMAIL" "$HASH" >> .env.tmp
  mv .env.tmp .env; chmod 600 .env
  echo "local .env: login updated (old plain-text password removed)"
fi
echo "Done. Log in at https://chrisc-ashen.vercel.app with $EMAIL."

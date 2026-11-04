#!/bin/bash
# Opens the dashboard on the server through an encrypted SSH tunnel.
# The dashboard is never exposed to the internet; only your SSH key can reach it.
# Login: DASHBOARD_USER / DASHBOARD_PASSWORD from .env in this folder.
SERVER="${SERVER:-root@2.29.115.23}"
KEY="${KEY:-$HOME/.ssh/hetzner_bot}"
PORT="${PORT:-3300}"

if ! nc -z localhost "$PORT" 2>/dev/null; then
  ssh -i "$KEY" -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
    -f -N -L "$PORT:127.0.0.1:3000" "$SERVER" || exit 1
fi
echo "Dashboard: http://localhost:$PORT  (stop the tunnel with: pkill -f '$PORT:127.0.0.1:3000')"
open "http://localhost:$PORT"

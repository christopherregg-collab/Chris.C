#!/bin/bash
# Run ON THE SERVER: request demo funds for the DEMO account and show the balance.
set -euo pipefail
cd /opt/trading-bot
runuser -u bot -- /opt/node/bin/node --dns-result-order=ipv4first --env-file=.env scripts/demo-funds.js

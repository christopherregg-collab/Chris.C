#!/bin/bash
# Run ON THE SERVER: the order smoke test on the DEMO account (about 30 seconds).
#   bash deploy/smoke-test.sh            BTC-USDT
#   bash deploy/smoke-test.sh ETH-USDT   another coin
set -euo pipefail
cd /opt/trading-bot
runuser -u bot -- /opt/node/bin/node --dns-result-order=ipv4first --env-file=.env scripts/smoke-test.js --symbol "${1:-BTC-USDT}"

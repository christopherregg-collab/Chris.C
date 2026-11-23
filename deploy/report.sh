#!/bin/bash
# Run ON THE SERVER: print the weekly bots report now.
cd /opt/trading-bot
runuser -u bot -- /opt/node/bin/node scripts/weekly-report.js

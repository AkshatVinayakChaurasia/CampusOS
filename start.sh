#!/usr/bin/env bash
# Start the Campus OS server and open the dashboard.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed. Get it from https://nodejs.org"; exit 1; }
node server.js &
SRV=$!
sleep 1
URL="http://127.0.0.1:4173"
(command -v xdg-open >/dev/null && xdg-open "$URL") || (command -v open >/dev/null && open "$URL") || echo "Open $URL in your browser"
wait $SRV

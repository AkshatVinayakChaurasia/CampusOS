#!/usr/bin/env bash
# Start the Campus OS terminal shell.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed. Get it from https://nodejs.org"; exit 1; }
exec node campus.js "$@"

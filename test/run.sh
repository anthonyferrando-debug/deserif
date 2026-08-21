#!/usr/bin/env bash
# Headless end-to-end check: serves test/site over http, loads the extension into
# Chromium, and compares what got replaced against test/report.py expectations.
# Content scripts do not run on file:// in headless mode, hence the http server.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
EXT="$(dirname "$HERE")"
CHROME="${CHROME:-chromium-browser}"
PORT="${PORT:-8765}"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$HERE/site" >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
sleep 1
rm -rf "$HERE/profile"
"$CHROME" --headless=new --no-sandbox --disable-gpu --user-data-dir="$HERE/profile" \
  --load-extension="$EXT" --disable-extensions-except="$EXT" --virtual-time-budget=6000 \
  --dump-dom "http://127.0.0.1:$PORT/index.html" 2>/dev/null \
  | grep -o '<pre id="CDBG">.*</pre>' | sed 's/<pre id="CDBG">//;s/<\/pre>//' \
  | python3 "$HERE/report.py"

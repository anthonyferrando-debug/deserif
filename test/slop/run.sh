#!/usr/bin/env bash
# Headless end-to-end check for the Facebook AI-slop blocker (slop.js + background.js).
# facebook.com is HSTS-preloaded, so the fake feed is served over TLS on a fixed
# port with a throwaway self-signed cert, and *.fbcdn.net is mapped to the same
# server. The extension is pointed at mock_api.py, a stand-in for the Claude API
# that fingerprints the images it receives, and drive.py steers Chromium over CDP
# and checks what got hidden, revealed, cached and sent.
# Needs: chromium (CHROME=... to override), openssl, python3 with Pillow and websocket-client.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
EXT="$(cd "$HERE/../.." && pwd)"
CHROME="${CHROME:-chromium-browser}"
TLS_PORT="${TLS_PORT:-8443}"
API_PORT="${API_PORT:-8787}"
CDP_PORT="${CDP_PORT:-9333}"
python3 -c 'import PIL, websocket' 2>/dev/null || { echo "needs Pillow and websocket-client: pip install pillow websocket-client"; exit 1; }
[ -f "$HERE/cert.pem" ] || openssl req -x509 -newkey rsa:2048 -nodes -keyout "$HERE/key.pem" -out "$HERE/cert.pem" -days 30 \
  -subj "/CN=www.facebook.com" -addext "subjectAltName=DNS:www.facebook.com,DNS:*.fbcdn.net" >/dev/null 2>&1
rm -f "$HERE/api.log"
rm -rf "$HERE/profile"
python3 "$HERE/https_srv.py" "$TLS_PORT" "$HERE" "$HERE/site" & P1=$!
python3 "$HERE/mock_api.py" "$API_PORT" "$HERE/site/v/t39.30808-6" "$HERE/api.log" & P2=$!
sleep 1
"$CHROME" --headless=new --no-sandbox --disable-gpu --window-size=900,900 --user-data-dir="$HERE/profile" \
  --load-extension="$EXT" --disable-extensions-except="$EXT" --ignore-certificate-errors \
  --host-resolver-rules="MAP www.facebook.com 127.0.0.1, MAP *.fbcdn.net 127.0.0.1" --testing-fixed-https-port="$TLS_PORT" \
  --remote-debugging-port="$CDP_PORT" --remote-allow-origins='*' about:blank >/dev/null 2>&1 & P3=$!
trap 'kill $P1 $P2 $P3 2>/dev/null || true' EXIT
for i in $(seq 1 50); do curl -s "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null && break; sleep 0.2; done
python3 "$HERE/drive.py" "$CDP_PORT" "$API_PORT" "$HERE"

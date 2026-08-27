#!/usr/bin/env bash
# Headless end-to-end check for the Facebook AI-image blocker (slop.js).
# facebook.com is HSTS-preloaded, so the fake feed is served over TLS on a fixed
# port with a throwaway self-signed cert, and *.fbcdn.net is mapped to the same
# server. drive.py steers Chromium over CDP and checks what got hidden, revealed
# and restored. Nothing talks to any API.
# Needs: chromium (CHROME=... to override), openssl, python3 with websocket-client.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
EXT="$(cd "$HERE/../.." && pwd)"
CHROME="${CHROME:-chromium-browser}"
TLS_PORT="${TLS_PORT:-8443}"
CDP_PORT="${CDP_PORT:-9333}"
python3 -c 'import websocket' 2>/dev/null || { echo "needs websocket-client: pip install websocket-client"; exit 1; }
[ -f "$HERE/cert.pem" ] || openssl req -x509 -newkey rsa:2048 -nodes -keyout "$HERE/key.pem" -out "$HERE/cert.pem" -days 30 \
  -subj "/CN=www.facebook.com" -addext "subjectAltName=DNS:www.facebook.com,DNS:*.fbcdn.net" >/dev/null 2>&1
rm -rf "$HERE/profile"
python3 "$HERE/https_srv.py" "$TLS_PORT" "$HERE" "$HERE/site" & P1=$!
sleep 1
"$CHROME" --headless=new --no-sandbox --disable-gpu --window-size=900,900 --user-data-dir="$HERE/profile" \
  --load-extension="$EXT" --disable-extensions-except="$EXT" --ignore-certificate-errors \
  --host-resolver-rules="MAP www.facebook.com 127.0.0.1, MAP *.fbcdn.net 127.0.0.1" --testing-fixed-https-port="$TLS_PORT" \
  --remote-debugging-port="$CDP_PORT" --remote-allow-origins='*' about:blank >/dev/null 2>&1 & P2=$!
trap 'kill $P1 $P2 2>/dev/null || true' EXIT
for i in $(seq 1 50); do curl -s "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null && break; sleep 0.2; done
python3 "$HERE/drive.py" "$CDP_PORT" "$HERE"

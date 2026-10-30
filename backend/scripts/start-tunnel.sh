#!/usr/bin/env bash
# Make the backend on this Mac reachable from the iPhone over cellular, and tell the app where.
#
# Starts a Cloudflare quick tunnel (no account) to http://localhost:8000, waits for its
# https://*.trycloudflare.com address, checks /health through it, then opens
# heynavi://backend?url=<address> on the paired iPhone, which saves it in the app's settings.
# The address changes every time this starts, so run it again after each restart.
#
# Usage: backend/scripts/start-tunnel.sh [DEVICE_UDID]     (Ctrl-C stops the tunnel)
# Needs: brew install cloudflared; the backend running on port 8000; the iPhone unlocked and on
# the same Wi-Fi as the Mac for the hand-off (the tunnel itself then works over cellular).
#
# The tunnel URL is public but unguessable; every /v1 route still needs the app token.
set -euo pipefail

udid="${1:-${HEYNAVI_DEVICE_ID:-}}"
log="$(mktemp -t heynavi-tunnel)"
trap 'kill "$pid" 2>/dev/null || true; rm -f "$log"' EXIT

cloudflared tunnel --no-autoupdate --url http://localhost:8000 >"$log" 2>&1 &
pid=$!

url=""
for _ in $(seq 1 60); do
  url="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -1 || true)"
  [[ -n "$url" ]] && break
  sleep 0.5
done
[[ -n "$url" ]] || { echo "No tunnel address after 30 s. cloudflared said:" >&2; tail -20 "$log" >&2; exit 1; }
echo "Tunnel: $url"

for _ in $(seq 1 20); do
  curl -sf -m 5 "$url/health" >/dev/null && break
  sleep 1
done
curl -sf -m 5 "$url/health" >/dev/null && echo "Health check through the tunnel: ok" || echo "Health check through the tunnel failed (DNS may still be propagating)" >&2

if [[ -n "$udid" ]]; then
  encoded="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$url")"
  if xcrun devicectl device process launch --device "$udid" --payload-url "heynavi://backend?url=$encoded" \
      com.heynavi.hackathon2026 >/dev/null 2>&1; then
    echo "Sent the address to the iPhone."
  else
    echo "Could not reach the iPhone; open heynavi://backend?url=$encoded on it yourself." >&2
  fi
else
  echo "No device given: pass the iPhone UDID to send it the address."
fi

echo "Tunnel running. Ctrl-C to stop."
wait "$pid"

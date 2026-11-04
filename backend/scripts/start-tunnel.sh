#!/usr/bin/env bash
# Make the backend on this Mac reachable from the iPhone over cellular, and tell the app where.
#
# Starts a Cloudflare quick tunnel (no account) to http://localhost:8000, waits for its
# https://*.trycloudflare.com address, checks /health through it, then opens
# heynavi://backend?url=<address> on the paired iPhone, which saves it in the app's settings.
# The address changes every time a tunnel starts.
#
# Watchdog: quick tunnels come with no uptime promise, and one lost its address after about two
# days while cloudflared kept running (2026-11-02). So the script checks /health through the
# tunnel every HEYNAVI_TUNNEL_CHECK_S seconds (default 30). When cloudflared has exited, or the
# address fails 3 checks in a row while the backend itself answers, it starts a new tunnel and
# sends the new address to the iPhone, retrying the hand-off at every check until the phone takes
# it. The phone must be unlocked and reachable (cable or the Mac's Wi-Fi) for that: out on
# cellular it cannot get the new address until it is back.
#
# Usage: backend/scripts/start-tunnel.sh [DEVICE_UDID]     (Ctrl-C stops the tunnel)
# Needs: brew install cloudflared; the backend running on port 8000; the iPhone unlocked and on
# the same Wi-Fi as the Mac for the hand-off (the tunnel itself then works over cellular).
#
# The tunnel URL is public but unguessable; every /v1 route still needs the app token.
set -euo pipefail

udid="${1:-${HEYNAVI_DEVICE_ID:-}}"
check_every="${HEYNAVI_TUNNEL_CHECK_S:-30}"
fails_to_restart=3
log="$(mktemp -t heynavi-tunnel)"
pid=""
url=""
healthy=0
trap 'stop_tunnel; rm -f "$log"' EXIT
trap 'exit 130' INT TERM

stamp() { date '+%H:%M:%S'; }

# /health through the tunnel, resolved with public DNS: the Mac's own resolver keeps answering
# "no such host" for a new address for minutes, which made every first check fail.
tunnel_ok() {
  local host="${1#https://}" ip
  ip="$(dig +short +time=3 +tries=1 @1.1.1.1 "$host" A 2>/dev/null | grep -E '^[0-9.]+$' | head -1 || true)"
  [[ -n "$ip" ]] || return 1
  curl -sf -m 8 --resolve "$host:443:$ip" "https://$host/health" >/dev/null
}

backend_ok() { curl -sf -m 5 http://localhost:8000/health >/dev/null; }

stop_tunnel() {
  [[ -n "$pid" ]] || return 0
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  kill -9 "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  pid=""
}

# Starts cloudflared and waits for its address. Returns 1 (with cloudflared stopped) if none comes.
start_tunnel() {
  : >"$log"
  cloudflared tunnel --no-autoupdate --url http://localhost:8000 >"$log" 2>&1 &
  pid=$!
  url=""
  for _ in $(seq 1 60); do
    # A quick tunnel's name is hyphenated words. Error lines also mention https://api.trycloudflare.com,
    # which is not a tunnel: on a network that blocks the tunnel it was taken as the address (2026-11-03).
    url="$(grep -Eo 'https://[a-z0-9]+(-[a-z0-9]+)+\.trycloudflare\.com' "$log" | head -1 || true)"
    [[ -n "$url" ]] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if [[ -z "$url" ]]; then
    echo "$(stamp) No tunnel address after 30 s. cloudflared said:" >&2
    tail -20 "$log" >&2
    stop_tunnel
    return 1
  fi
  echo "$(stamp) Tunnel: $url (cloudflared pid $pid)"
  # One verdict from the loop: a second check right after the first can catch the new tunnel
  # before it is fully up and report a working tunnel as failed (2026-11-02). Only a healthy
  # address is sent to the iPhone; otherwise the watch loop sends it once it answers.
  healthy=0
  for _ in $(seq 1 30); do
    if tunnel_ok "$url"; then
      healthy=1
      break
    fi
    sleep 1
  done
  if [[ $healthy -eq 1 ]]; then
    echo "$(stamp) Health check through the tunnel: ok"
  else
    echo "$(stamp) Health check through the tunnel failed (DNS may still be propagating)" >&2
  fi
}

# Opens the app on the iPhone with the address. Returns 1 when the phone could not be reached.
send_to_phone() {
  local encoded
  encoded="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$url")"
  if [[ -z "$udid" ]]; then
    echo "$(stamp) No device given: open heynavi://backend?url=$encoded on the iPhone, or pass its UDID."
    return 0
  fi
  if xcrun devicectl device process launch --device "$udid" --payload-url "heynavi://backend?url=$encoded" \
      com.heynavi.hackathon2026 >/dev/null 2>&1; then
    echo "$(stamp) Sent the address to the iPhone."
    return 0
  fi
  echo "$(stamp) Could not reach the iPhone (locked or away?); trying again at the next check. Or open heynavi://backend?url=$encoded on it." >&2
  return 1
}

start_tunnel || exit 1
sent=0
if [[ $healthy -eq 1 ]] && send_to_phone; then sent=1; fi
echo "$(stamp) Tunnel running, checked every ${check_every} s. Ctrl-C to stop."

fails=0
while true; do
  # In the background, so Ctrl-C and TaskStop end the script at once instead of after the nap.
  sleep "$check_every" &
  wait $! || true

  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    reason="cloudflared is not running"
  elif tunnel_ok "$url"; then
    fails=0
    if [[ $sent -eq 0 ]] && send_to_phone; then sent=1; fi
    continue
  elif ! backend_ok; then
    # Not the tunnel's fault: a new address would not help.
    echo "$(stamp) The backend on port 8000 is not answering; leaving the tunnel as it is." >&2
    continue
  else
    fails=$((fails + 1))
    echo "$(stamp) Check through the tunnel failed ($fails of $fails_to_restart)." >&2
    [[ $fails -ge $fails_to_restart ]] || continue
    reason="its address stopped answering"
  fi

  echo "$(stamp) Starting a new tunnel: $reason."
  stop_tunnel
  fails=0
  sent=0
  if start_tunnel && [[ $healthy -eq 1 ]] && send_to_phone; then sent=1; fi
done

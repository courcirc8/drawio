#!/usr/bin/env bash
# correct-session.sh — open the netlist-correction page to Eric's tailnet for a
# session: start the drawio API server on 127.0.0.1:8770 if it is not running,
# check the tailscale serve mapping (tailnet only, never Funnel), print the URL.
#
# One-time setup by a human (root needed; nothing is exposed to the Internet):
#   sudo tailscale serve --bg --https=8443 http://127.0.0.1:8770
# Undo: sudo tailscale serve --https=8443 off
# Stop the session server: kill the PID printed below.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BATCH=${1:-rf-1}
export PATH="$HOME/.local/node/bin:$PATH"
if ! curl -sf -o /dev/null http://127.0.0.1:8770/health; then
  (cd "$HERE" && nohup node server.js --port 8770 > /tmp/drawio-correct-session.log 2>&1 &)
  for _ in $(seq 40); do curl -sf -o /dev/null http://127.0.0.1:8770/health && break; sleep 0.5; done
fi
PID=$(ss -ltnp 2>/dev/null | grep '127.0.0.1:8770' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
echo "drawio server on 127.0.0.1:8770 (pid ${PID:-?})"
if tailscale funnel status 2>/dev/null | grep -q '8443'; then echo "REFUSING: 8443 is on Funnel (Internet)"; exit 1; fi
if tailscale serve status 2>/dev/null | grep -q ':8443'; then
  HOST=$(tailscale status --self --json | python3 -c "import json,sys;print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))")
  echo "URL: https://${HOST}:8443/correct?batch=${BATCH}"
else
  echo "tailscale serve is not set up yet. Once, as root:"
  echo "  sudo tailscale serve --bg --https=8443 http://127.0.0.1:8770"
fi

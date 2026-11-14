#!/usr/bin/env bash
# Stop the local omp auth gateway started by start.sh.
set -euo pipefail

STATE_DIR="${ARC_GATEWAY_STATE_DIR:-$HOME/.local/share/arcspirits-agent-gateway}"
PID_FILE="$STATE_DIR/gateway.pid"

if [ ! -f "$PID_FILE" ]; then
	echo "gateway not running (no pid file)"
	exit 0
fi
pid="$(cat "$PID_FILE")"
if ! ps -p "$pid" -o command= 2>/dev/null | grep -q "auth-gateway serve"; then
	echo "gateway not running (stale pid $pid)"
	rm -f "$PID_FILE"
	exit 0
fi

kill -TERM "$pid"
for _ in $(seq 1 20); do
	ps -p "$pid" >/dev/null 2>&1 || break
	sleep 0.5
done
if ps -p "$pid" >/dev/null 2>&1; then
	echo "gateway did not stop after 10 s; sending SIGKILL"
	kill -KILL "$pid" 2>/dev/null || true
fi
rm -f "$PID_FILE"
echo "gateway stopped (pid $pid)"

#!/bin/bash
# Stop the league cleanly: running games are abandoned (kept and marked, played again later),
# after-game notebook calls may finish (stopGraceSec), then the process exits. Waits for it.
#
#   scripts/agent-harness/league/stop.sh [league dir]      (default ~/arcspirits-harness/league)
set -euo pipefail
dir="${1:-$HOME/arcspirits-harness/league}"
pidfile="$dir/league.pid"
if [[ ! -f "$pidfile" ]] || ! kill -0 "$(cat "$pidfile")" 2>/dev/null; then
	echo "the league is not running"
	rm -f "$pidfile"
	exit 0
fi
pid="$(cat "$pidfile")"
kill -TERM "$pid"
for _ in $(seq 1 180); do
	kill -0 "$pid" 2>/dev/null || break
	sleep 1
done
if kill -0 "$pid" 2>/dev/null; then
	echo "the league did not end in 180 s; killing it (pid $pid)"
	kill -KILL "$pid" || true
	rm -f "$pidfile"
fi
echo "league stopped (pid $pid)"

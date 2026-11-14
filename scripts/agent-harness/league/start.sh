#!/bin/bash
# Start the league detached: it survives a closed ssh session (nohup) and keeps the Mac awake
# while it runs (caffeinate -i). Log: <dir>/league.log. Status: status.sh. Stop: stop.sh.
#
#   scripts/agent-harness/league/start.sh [league dir]     (default ~/arcspirits-harness/league)
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
here="$(cd "$(dirname "$0")" && pwd)"
lab="$(cd "$here/../../.." && pwd)"
dir="${1:-$HOME/arcspirits-harness/league}"
[[ -f "$dir/league.json" ]] || { echo "no league.json in $dir (create it with: npx tsx $here/league.ts --dir $dir --init)"; exit 1; }
if [[ -f "$dir/league.pid" ]] && kill -0 "$(cat "$dir/league.pid")" 2>/dev/null; then
	echo "the league already runs (pid $(cat "$dir/league.pid"))"
	exit 1
fi
rm -f "$dir/league.pid"
cd "$lab"
# league.ts ignores SIGHUP itself (Node resets nohup's "ignore" when it starts).
nohup caffeinate -i node --import tsx "$here/league.ts" --dir "$dir" < /dev/null >> "$dir/league.log" 2>&1 &
disown $! 2>/dev/null || true
for _ in $(seq 1 60); do
	[[ -f "$dir/league.pid" ]] && break
	sleep 0.5
done
if [[ -f "$dir/league.pid" ]] && kill -0 "$(cat "$dir/league.pid")" 2>/dev/null; then
	echo "league started (pid $(cat "$dir/league.pid")); status: $here/status.sh $dir"
else
	echo "the league did not start; last lines of $dir/league.log:"
	tail -5 "$dir/league.log"
	exit 1
fi

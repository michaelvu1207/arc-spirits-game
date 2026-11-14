#!/bin/bash
# Prints the tournament state: batch, games done, standings, quota, and whether the process is alive.
#   ~/arcspirits-harness/tournament/status.sh [run-name]      (default run-1)
ROOT="$HOME/arcspirits-harness"
RUN="${1:-run-1}"
DIR="$ROOT/tournament/$RUN"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -f "$DIR/STATUS.md" ] || { echo "no tournament at $DIR"; exit 1; }
cat "$DIR/STATUS.md"
pid=$(node -e "console.log(require('$DIR/status.json').pid)")
if kill -0 "$pid" 2>/dev/null; then echo "process: ALIVE (pid $pid)"; else echo "process: NOT RUNNING (last pid $pid)"; fi
if tmux has-session -t "arc-$RUN" 2>/dev/null; then echo "tmux session: arc-$RUN"; else echo "tmux session: none"; fi
echo
[ -f "$DIR/standings.md" ] && sed -n '/^## Entrants/,/^## By model/p' "$DIR/standings.md" | head -18
[ -f "$DIR/standings.md" ] && sed -n '/^## By model/,$p' "$DIR/standings.md" | head -24
echo "--- last events"
tail -6 "$DIR/events.log" 2>/dev/null

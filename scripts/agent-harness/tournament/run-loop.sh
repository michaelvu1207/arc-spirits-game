#!/bin/bash
# Runs the tournament; on a crash (state "error") it waits and starts again (up to 5 times).
# A clean stop (quota guard, usage limit, signal) or the end of the tournament ends the loop.
DIR="$1"; shift
cd "$HOME/arcspirits-harness/game" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# Keep the Mac awake (idle sleep; system sleep on AC power) while this loop runs.
caffeinate -is -w $$ &
for attempt in 1 2 3 4 5 6; do
  echo "$(date -u +%FT%TZ) run-loop: start $attempt" >> "$DIR/run.log"
  npx tsx scripts/agent-harness/tournament.ts --dir "$DIR" "$@" >> "$DIR/run.log" 2>&1
  state=$(node -e "try{console.log(require('$DIR/status.json').state)}catch{console.log('unknown')}")
  echo "$(date -u +%FT%TZ) run-loop: exit, state $state" >> "$DIR/run.log"
  case "$state" in done|stopped) exit 0 ;; esac
  sleep 120
done

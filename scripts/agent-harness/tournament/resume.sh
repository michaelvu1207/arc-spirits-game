#!/bin/bash
# Start or resume the Arc Spirits AI tournament as a detached tmux session (survives ssh logout).
# Finished games (results/*.json) are kept and skipped; a cut-off game is played again.
#   ~/arcspirits-harness/tournament/resume.sh [run-name]      (default run-1)
# Settings: ~/arcspirits-harness/tournament/settings.env (no secrets in it; the token stays in its file).
set -euo pipefail
ROOT="$HOME/arcspirits-harness"
RUN="${1:-run-1}"
DIR="$ROOT/tournament/$RUN"
SESSION="arc-$RUN"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# shellcheck source=/dev/null
[ -f "$ROOT/tournament/settings.env" ] && source "$ROOT/tournament/settings.env"
: "${GW_URLS:=http://127.0.0.1:4610/v1}" "${GW_LABELS:=berkeley}"
: "${GW_TOKEN_FILES:?set GW_TOKEN_FILES in settings.env (one token file per URL, same order)}"
: "${GW_HISTORY:=reasoning}" "${SEED:=2026}" "${QUOTA_MAX:=off}"
: "${STEP_GAMES:=3,5,7,10}" "${STEP_MIN:=5}" "${STEP_HITS:=3}"
: "${CALL_CAP:=40}" "${CALLS_PER_MIN:=120}" "${MAX_CALLS_PER_MIN:=300}"
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "already running: tmux session $SESSION (attach: tmux attach -t $SESSION; detach: Ctrl-b d)"
  exit 0
fi
mkdir -p "$DIR"
# tmux runs the command directly (several arguments: no shell quoting).
tmux new-session -d -s "$SESSION" -c "$ROOT/game" "$ROOT/tournament/run-loop.sh" "$DIR" \
  --catalog "$ROOT/design-data/game" --source-file "$ROOT/SOURCE.json" \
  --gw-urls "$GW_URLS" --gw-labels "$GW_LABELS" --gw-token-files "$GW_TOKEN_FILES" \
  --gw-history "$GW_HISTORY" --seed "$SEED" --quota-max-percent "$QUOTA_MAX" \
  --step-games "$STEP_GAMES" --step-min "$STEP_MIN" --step-hits "$STEP_HITS" \
  --max-concurrent-calls "$CALL_CAP" --calls-per-min "$CALLS_PER_MIN" --max-calls-per-min "$MAX_CALLS_PER_MIN" \
  ${EXTRA_ARGS:-}
sleep 3
echo "started: tmux session $SESSION; folder $DIR"
"$ROOT/tournament/status.sh" "$RUN" | head -12

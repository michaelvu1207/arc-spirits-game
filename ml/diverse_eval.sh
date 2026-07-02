#!/usr/bin/env bash
# Measure the diversity frontier: by default pick the LATEST checkpoint of each archetype lane
# (eco/hunt/pure/expl) — plus an optional corruption reference (REF) — and report each one's
# behavioral fingerprint + true-VP strength (_diversity) head-to-head, then cross-archetype ELO.
# Set EVAL_ALL=1 to evaluate every checkpoint in the pool instead. Run at each 12h-loop check-in.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null 2>&1
POOL="${POOL:-/data/share8/michaelvuaprilexperimentation/diverse_pool}"
REF="${REF:-/data/share8/michaelvuaprilexperimentation/league/seed_champion.json}"  # a corruption-line reference, if present

if [ "${EVAL_ALL:-0}" = "1" ]; then
  FILES="$POOL"  # whole pool via DIV_DIR
  USE_DIR=1
else
  sel=""
  for p in eco hunt pure good expl; do
    f=$(ls -t "$POOL/${p}_it"*.json 2>/dev/null | head -1)
    [ -n "$f" ] && sel="${sel:+$sel,}$f"
  done
  [ -f "$REF" ] && sel="${sel:+$sel,}$REF"
  FILES="$sel"
  USE_DIR=0
fi
echo "=== diverse_eval $(date) ==="
echo "files: $FILES"

run_div () { # $1 = seats
  if [ "$USE_DIR" = "1" ]; then
    DIV=1 DIV_DIR="$POOL" DIV_GAMES="${DIV_GAMES:-200}" DIV_SEATS="$1" DIV_MAXROUNDS=30 \
      npx vitest run src/lib/play/ml/_diversity.test.ts --disable-console-intercept 2>&1 | grep -E "\[div\]"
  else
    DIV=1 DIV_FILES="$FILES" DIV_GAMES="${DIV_GAMES:-300}" DIV_SEATS="$1" DIV_MAXROUNDS=30 \
      npx vitest run src/lib/play/ml/_diversity.test.ts --disable-console-intercept 2>&1 | grep -E "\[div\]"
  fi
}

for sp in 4 3 2; do
  echo "--- DIVERSITY @ ${sp}p ---"
  run_div "$sp"
done

echo "--- ELO (cross-archetype) ---"
if [ "$USE_DIR" = "1" ]; then
  ELO=1 ELO_DIR="$POOL" ELO_GAMES="${ELO_GAMES:-1500}" ELO_MAXROUNDS=30 ELO_K=16 \
    npx vitest run src/lib/play/ml/_elo.test.ts --disable-console-intercept 2>&1 | grep -E "\[elo\]"
else
  ELO=1 ELO_FILES="$FILES" ELO_GAMES="${ELO_GAMES:-1200}" ELO_MAXROUNDS=30 ELO_K=16 \
    npx vitest run src/lib/play/ml/_elo.test.ts --disable-console-intercept 2>&1 | grep -E "\[elo\]"
fi
echo "=== diverse_eval DONE $(date) ==="

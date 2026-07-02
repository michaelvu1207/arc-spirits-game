#!/usr/bin/env bash
# FINAL PORTFOLIO REPORT. Evaluates each archetype in its NATIVE selection mode (value lanes under
# 'value', explorer under 'policy', corruption champion under 'hybrid') at 4p+3p vs a heuristic
# field, on the TRUE VP objective — so the economy/monster vs corruption comparison is apples-to-
# apples. fieldVP column = best VP among the heuristic opponents (the bar to beat). Writes
# /tmp/report.txt. Usage: diverse_report.sh [games]
set -u
BASE=/data/share8/michaelvuaprilexperimentation; WS=$BASE/arc-bot; POOL=$BASE/diverse_pool
cd "$WS"; export NVM_DIR="$HOME/.nvm"; set +u; . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null 2>&1; set -u
G="${1:-30}"
REPORT=/tmp/report.txt
echo "=== DIVERSE PORTFOLIO REPORT $(date) games=$G/policy ===" > "$REPORT"

run() { # $1=label $2=files $3=selection $4=seats
  [ -z "$2" ] && return
  rm -f ml/diversity_result.json
  DIV=1 DIV_OPP=heur DIV_SELECTION="$3" DIV_FILES="$2" DIV_GAMES="$G" DIV_SEATS="$4" DIV_MAXROUNDS=30 \
    node ./node_modules/.bin/vitest run src/lib/play/ml/_diversity.test.ts --disable-console-intercept > /tmp/rep_vitest.log 2>&1
  echo "--- $1 (selection=$3, ${4}p) ---" >> "$REPORT"
  python3 -c "
import json
try:
    d=json.load(open('ml/diversity_result.json'))
    for r in d: print(f\"  {r['name'][:18]:18} VP={r['avgVP']:5.1f} win%={r['winPct']:3.0f} r30%={r['reach30Pct']:3.0f} status={r['avgStatus']:.2f} barrier={r['avgBarrier']:4.1f} dice={r['avgDice']:.1f} fieldVP={r['fieldBestVP']:.1f} {r['line']}\")
except Exception as e: print('  ERR', e)
" >> "$REPORT" 2>&1
}

ECO=$(ls -t $POOL/eco_it*.json 2>/dev/null | head -1)
HUNT=$(ls -t $POOL/hunt_it*.json 2>/dev/null | head -1)
GOOD=$(ls -t $POOL/good_it*.json 2>/dev/null | head -1)
EXPL=$(ls -t $POOL/expl_it*.json 2>/dev/null | head -1)
CHAMP=$BASE/league/seed_champion.json
VLANES=""; for f in "$ECO" "$HUNT" "$GOOD"; do [ -n "$f" ] && VLANES="${VLANES:+$VLANES,}$f"; done

for sp in 4 3; do run "value-lanes eco/hunt/good" "$VLANES" value "$sp"; done
run "explorer (policy head)" "$EXPL" policy 4
[ -f "$CHAMP" ] && run "corruption champion (hybrid)" "$CHAMP" hybrid 4
echo "REPORT_DONE $(date)" >> "$REPORT"
cat "$REPORT"

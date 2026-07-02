#!/usr/bin/env bash
# Minimal, robust VP/diversity probe: latest checkpoint per lane (eco/hunt/good/expl) vs a heuristic
# field (fast, no all-neural stalls). Writes a clean table to /tmp/probe_result.txt. Usage: probe.sh [games] [seats]
set -u
BASE=/data/share8/michaelvuaprilexperimentation; WS=$BASE/arc-bot; POOL=$BASE/diverse_pool
cd "$WS"; export NVM_DIR="$HOME/.nvm"; set +u; . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null 2>&1; set -u
G="${1:-10}"; S="${2:-4}"; SEL="${3:-value}"   # SEL = focus selection mode (lanes train under 'value'; use 'policy' for the expl lane / 'hybrid' for the corruption champion)
sel=""; for p in eco hunt good expl; do f=$(ls -t $POOL/${p}_it*.json 2>/dev/null | head -1); [ -n "$f" ] && sel="${sel:+$sel,}$f"; done
echo "PROBE games=$G seats=$S selection=$SEL files=$(echo $sel | tr ',' ' ' | xargs -n1 basename | tr '\n' ' ') $(date +%H:%M:%S)" > /tmp/probe_result.txt
rm -f ml/diversity_result.json
DIV=1 DIV_OPP=heur DIV_SELECTION="$SEL" DIV_FILES="$sel" DIV_GAMES="$G" DIV_SEATS="$S" DIV_MAXROUNDS=30 \
  node ./node_modules/.bin/vitest run src/lib/play/ml/_diversity.test.ts --disable-console-intercept > /tmp/probe_vitest.log 2>&1
echo "vitest_exit=$?" >> /tmp/probe_result.txt
python3 -c "
import json
try:
    d=json.load(open('ml/diversity_result.json'))
    for r in d: print(f\"{r['name'][:16]:16} VP={r['avgVP']:5.1f} win%={r['winPct']:3.0f} r30%={r['reach30Pct']:3.0f} status={r['avgStatus']:.2f} barrier={r['avgBarrier']:4.1f} dice={r['avgDice']:.1f} spir={r['avgSpirits']:.1f} rnds={r['avgRounds']:.0f} {r['line']}\")
except Exception as e:
    print('NO JSON:', e)
" >> /tmp/probe_result.txt 2>&1
echo "PROBE_DONE $(date +%H:%M:%S)" >> /tmp/probe_result.txt

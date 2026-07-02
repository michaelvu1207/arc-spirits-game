#!/usr/bin/env bash
# Parallel league self-play generation. Args: GAMES_PER_SHARD SHARDS PREFIX
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
PER="${1:-50}"; SHARDS="${2:-24}"; PREFIX="${3:-lg}"
rm -f "/tmp/lg_${PREFIX}"_*.log
pids=()
for k in $(seq 0 $((SHARDS-1))); do
  SEED0=$(( k*100000 + 1 )); OUT="$ROOT/ml/data/${PREFIX}_${k}.jsonl"
  LEAGUE=1 LEARNER="${LEARNER:-ml/weights/policy.json}" LEAGUE_DIR="${LEAGUE_DIR:-ml/league}" \
    GEN_GAMES="$PER" GEN_SEATS="${GEN_SEATS:-4}" GEN_MAXROUNDS="${GEN_MAXROUNDS:-40}" GEN_SEED0="$SEED0" GEN_OUT="$OUT" \
    GEN_SAMPLE="${GEN_SAMPLE:-1}" GEN_TEMP="${GEN_TEMP:-1.0}" GEN_SELECTION="${GEN_SELECTION:-hybrid}" \
    GEN_ANCHOR_P="${GEN_ANCHOR_P:-0.2}" GEN_ANCHOR="${GEN_ANCHOR:-pvphunter}" GEN_ITER="${GEN_ITER:-0}" \
    GEN_FORBID="${GEN_FORBID:-}" GEN_MAX_STATUS_LEVEL="${GEN_MAX_STATUS_LEVEL:-}" GEN_SHAPING="${GEN_SHAPING:-}" GEN_GAMMA="${GEN_GAMMA:-}" \
    npx vitest run src/lib/play/ml/_league.test.ts --disable-console-intercept > "/tmp/lg_${PREFIX}_${k}.log" 2>&1 &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
TOTAL=$(cat "$ROOT"/ml/data/${PREFIX}_*.jsonl 2>/dev/null | wc -l | tr -d ' ')
node -e "require('fs').writeFileSync('ml/data/meta.json', JSON.stringify({obs_dim:62,act_dim:52,samples:$TOTAL,prefix:'$PREFIX',mode:'league'},null,2))"
echo "LEAGUE_SHARDS_DONE total=$TOTAL"; grep -h "\[league\] DONE" /tmp/lg_${PREFIX}_*.log | tail -3

#!/usr/bin/env bash
# Parallel self-play data generation. Args: MODE GAMES_PER_SHARD SHARDS PREFIX [EXTRA_ENV...]
set -e
MODE="${1:-heur}"; PER="${2:-75}"; SHARDS="${3:-4}"; PREFIX="${4:-cold}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# Drop stale shard logs for this prefix so the end-of-run grep can't report a previous run.
rm -f "/tmp/gen_${PREFIX}"_*.log
pids=()
for k in $(seq 0 $((SHARDS-1))); do
  SEED0=$(( k*100000 + 1 ))
  OUT="$ROOT/ml/data/${PREFIX}_${k}.jsonl"
  GEN=1 GEN_MODE="$MODE" GEN_GAMES="$PER" GEN_SEATS="${GEN_SEATS:-4}" \
    GEN_MAXROUNDS="${GEN_MAXROUNDS:-90}" GEN_SEED0="$SEED0" GEN_OUT="$OUT" \
    GEN_SAMPLE="${GEN_SAMPLE:-}" GEN_ITER="${GEN_ITER:-0}" \
    GEN_FIELD="${GEN_FIELD:-pvphunter,pvphunter,medium,aggressive,cultivator,survivor,fighter,hard}" \
    GEN_RECORD_PROFILE="${GEN_RECORD_PROFILE:-pvphunter}" \
    GEN_FORBID="${GEN_FORBID:-}" GEN_MAX_STATUS_LEVEL="${GEN_MAX_STATUS_LEVEL:-}" \
    GEN_SELECTION="${GEN_SELECTION:-value}" GEN_SHAPING="${GEN_SHAPING:-}" GEN_GAMMA="${GEN_GAMMA:-}" \
    npx vitest run src/lib/play/ml/_gen.test.ts --disable-console-intercept \
    > "/tmp/gen_${PREFIX}_${k}.log" 2>&1 &
  pids+=($!)
done
echo "launched ${SHARDS} shards: ${pids[*]}"
for p in "${pids[@]}"; do wait "$p"; done
# Merge per-shard sample counts; write a single meta.json (dims are fixed by the encoder).
TOTAL=$(cat "$ROOT"/ml/data/${PREFIX}_*.jsonl 2>/dev/null | wc -l | tr -d ' ')
node -e "require('fs').writeFileSync('ml/data/meta.json', JSON.stringify({obs_dim:62,act_dim:52,samples:$TOTAL,prefix:'$PREFIX',mode:'$MODE'},null,2))"
echo "ALL_SHARDS_DONE total_samples=$TOTAL"
grep -h "\[gen\] DONE" /tmp/gen_${PREFIX}_*.log

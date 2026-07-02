#!/usr/bin/env bash
# Parallel-sharded frozen gauntlet: same 800 games, N processes, one merged
# result. Execution wrapper only — gauntlet version unaffected.
#
#   scripts/fast-gauntlet.sh <WEIGHTS_PATH> [SHARDS=32] [OUT_JSON]
#
# Env passthrough: GAUNTLET_GAMES (smoke), GAUNTLET_PROFILE instead of weights
# is NOT supported here (use the serial runner for profiles).
set -euo pipefail
cd "$(dirname "$0")/.."

W="${1:?usage: fast-gauntlet.sh WEIGHTS [SHARDS] [OUT]}"
N="${2:-32}"
SLUG=$(echo "$W" | sed 's/\.json$//' | tr '/' '\n' | grep -v '^$' | tail -2 | paste -sd- - | tr -cs 'a-z0-9._-' '-' | sed 's/^-*//;s/-*$//')
OUT="${3:-ml/gauntlet_results/${SLUG}.json}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "[fast-gauntlet] $W → $N shards"
PIDS=()
for ((k = 0; k < N; k++)); do
  GAUNTLET=1 GAUNTLET_WEIGHTS="$W" GAUNTLET_SHARD="$k/$N" \
    GAUNTLET_OUT="$TMP/shard-$k.json" \
    npx vitest run src/lib/play/ml/gauntlet/_gauntlet.test.ts >"$TMP/log-$k.txt" 2>&1 &
  PIDS+=($!)
done
FAIL=0
for pid in "${PIDS[@]}"; do wait "$pid" || FAIL=1; done
if [[ $FAIL -ne 0 ]]; then
  echo "[fast-gauntlet] a shard FAILED; first failing log:" >&2
  for ((k = 0; k < N; k++)); do
    [[ -f "$TMP/shard-$k.json" ]] || { tail -20 "$TMP/log-$k.txt" >&2; break; }
  done
  exit 1
fi
node scripts/merge-gauntlet-shards.mjs --out "$OUT" "$TMP"/shard-*.json

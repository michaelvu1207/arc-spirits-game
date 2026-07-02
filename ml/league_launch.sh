#!/usr/bin/env bash
# Stop heuristic lanes -> seed a shared league pool from their champions -> validate the net-vs-net
# generator -> refresh lane code -> launch 4 league learners (one per GPU) training vs the shared pool.
set -u
BASE=/data/share8/michaelvuaprilexperimentation
WS=$BASE/arc-bot; POOL=$BASE/league
export NVM_DIR=$HOME/.nvm; . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null 2>&1

echo "=== stop heuristic lanes ==="
for p in $(pgrep -f "bash ml/superhuman.sh"); do kill -9 "$p" 2>/dev/null; done
sleep 2
for p in $(pgrep -f "vitest|run_gen.sh"); do c=$(readlink /proc/$p/cwd 2>/dev/null); case "$c" in */lane[0-3]) kill -9 "$p" 2>/dev/null;; esac; done
sleep 1
echo "superhuman procs left: $(pgrep -f 'bash ml/superhuman.sh' | wc -l)"

echo "=== seed shared pool ==="
mkdir -p "$POOL"; rm -f "$POOL"/*.json "$POOL"/.*.tmp 2>/dev/null
for i in 0 1 2 3; do latest=$(ls -t "$BASE"/lane$i/ckpt/policy_it*.json 2>/dev/null | head -1); [ -n "$latest" ] && cp "$latest" "$POOL/seed_lane$i.json"; done
cp "$WS/ml/weights/policy.json" "$POOL/seed_champion.json"
echo "pool: $(ls "$POOL"/*.json 2>/dev/null | wc -l) models"

echo "=== validate net-vs-net generator (4 games) ==="
cd "$WS"
OUT=$(LEAGUE=1 LEARNER=ml/weights/policy.json LEAGUE_DIR="$POOL" GEN_GAMES=4 GEN_MAXROUNDS=40 GEN_OUT=/tmp/lgtest.jsonl \
  npx vitest run src/lib/play/ml/_league.test.ts --disable-console-intercept 2>&1)
if echo "$OUT" | grep -q "\[league\] DONE"; then
  echo "  OK: $(echo "$OUT" | grep '\[league\] DONE')"
else
  echo "  VALIDATION FAILED:"; echo "$OUT" | tail -18; exit 1
fi

echo "=== refresh lanes (latest code, learner=champion, fresh data) ==="
for i in 0 1 2 3; do
  L=$BASE/lane$i
  rsync -a --exclude node_modules --exclude 'ml/.venv' --exclude 'ml/data' --exclude ckpt --exclude logs \
    --exclude 'ml/weights' --exclude 'ml/league' --exclude static --exclude build --exclude .svelte-kit "$WS/" "$L/" >/dev/null 2>&1
  rm -rf "$L/node_modules" "$L/ml/.venv" "$L/static"
  ln -sfn "$WS/node_modules" "$L/node_modules"; ln -sfn "$WS/ml/.venv" "$L/ml/.venv"; [ -d "$WS/static" ] && ln -sfn "$WS/static" "$L/static"
  mkdir -p "$L/ml/data" "$L/ml/weights" "$L/ckpt" "$L/logs"; rm -f "$L"/ml/data/*.jsonl
  cp "$WS/ml/weights/policy.json" "$L/ml/weights/policy.json"
done
echo "lanes refreshed"

echo "=== launch 4 league learners (shared pool $POOL) ==="
launch () { local i=$1; shift; cd "$BASE/lane$i"; \
  env CUDA_VISIBLE_DEVICES=$i LANE=L$i ITERS=16 SHARDS=22 GEN_PER=50 KEEP=5 EPOCHS=12 BATCH=8192 LEAGUE_DIR="$POOL" "$@" \
  nohup bash ml/league.sh > logs/league.log 2>&1 < /dev/null & echo "  L$i gpu=$i: $*"; }
launch 0 BETA=3.0 ANCHOR_P=0.20 TEMP0=1.10
launch 1 BETA=4.0 ANCHOR_P=0.10 TEMP0=1.10
launch 2 BETA=3.0 ANCHOR_P=0.35 TEMP0=1.10
launch 3 BETA=2.5 ANCHOR_P=0.15 TEMP0=1.40
sleep 3
echo "LEAGUE_LAUNCHED procs=$(pgrep -f 'bash ml/league.sh' | wc -l)"

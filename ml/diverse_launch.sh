#!/usr/bin/env bash
# Launch the DIVERSITY league: 4 lanes (one per free GPU 0-3) sharing one cross-archetype pool.
# Each lane cold-starts from a non-pvphunter teacher → archetype-shaped, SHARDED league self-play
# with selection=policy. Lanes vary by shaping, table size, patience, exploration, guardian variety,
# and a hard never-PvP constraint (FORBID=initiatePvp) on the monster/Good lanes. Archives any prior
# pool (preserves the portfolio) and restarts fresh.
set -u
BASE=/data/share8/michaelvuaprilexperimentation
WS=$BASE/arc-bot; POOL=$BASE/diverse_pool
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null 2>&1
STAMP=$(date +%m%d_%H%M%S)

echo "=== stop old league + prior diverse lanes ==="
for p in $(pgrep -f "bash ml/league.sh"); do kill -9 "$p" 2>/dev/null; done
for p in $(pgrep -f "bash ml/diverse_lane.sh"); do kill -9 "$p" 2>/dev/null; done
for p in $(pgrep -f "vitest|train.py"); do c=$(readlink /proc/$p/cwd 2>/dev/null); case "$c" in */lane[0-3]|*/dlane[0-3]) kill -9 "$p" 2>/dev/null;; esac; done
sleep 2
echo "lane procs left: $(pgrep -f 'bash ml/diverse_lane.sh' | wc -l)"

echo "=== archive prior pool, start fresh ==="
if [ -n "$(ls "$POOL"/*.json 2>/dev/null)" ]; then
  mkdir -p "$BASE/diverse_archive/$STAMP"; cp "$POOL"/*.json "$BASE/diverse_archive/$STAMP/" 2>/dev/null
  echo "archived $(ls "$BASE/diverse_archive/$STAMP"/*.json 2>/dev/null | wc -l) checkpoints → diverse_archive/$STAMP"
fi
mkdir -p "$POOL"; rm -f "$POOL"/*.json "$POOL"/.*.tmp 2>/dev/null
echo "pool cleared"

echo "=== set up 4 lane working dirs ==="
for i in 0 1 2 3; do
  L=$BASE/dlane$i
  rsync -a --exclude node_modules --exclude 'ml/.venv' --exclude 'ml/data' --exclude ckpt --exclude logs \
    --exclude 'ml/weights' --exclude 'ml/league' --exclude 'ml/diverse_pool' --exclude 'ml/sizes*' --exclude 'ml/ladder*' \
    --exclude static --exclude build --exclude .svelte-kit "$WS/" "$L/" >/dev/null 2>&1
  rm -rf "$L/node_modules" "$L/ml/.venv" "$L/static"
  ln -sfn "$WS/node_modules" "$L/node_modules"; ln -sfn "$WS/ml/.venv" "$L/ml/.venv"; [ -d "$WS/static" ] && ln -sfn "$WS/static" "$L/static"
  mkdir -p "$L/ml/data" "$L/ml/weights" "$L/ckpt" "$L/logs"
  rm -f "$L"/ml/data/*.jsonl "$L/ml/weights/policy.json"
done
echo "lane dirs ready"

echo "=== launch 4 diversity lanes (shared pool $POOL, sharded gen) ==="
launch () { local i=$1; shift; cd "$BASE/dlane$i"; \
  env CUDA_VISIBLE_DEVICES=$i LEAGUE_DIR="$POOL" ITERS=400 GEN_PER=120 SHARDS=3 COLD_GAMES=200 KEEP=4 EPOCHS=12 BATCH=8192 SHUFFLE_G=1 "$@" \
  nohup bash ml/diverse_lane.sh > logs/lane.log 2>&1 < /dev/null & echo "  dlane$i gpu=$i: $*"; }
# Economist: patient 4p build/economy, corruption-neutral, guardian variety
launch 0 LANE=eco   SHAPING=banker   SELECTION=value STATUS_SHAPE_ENV=0 HUNT_BONUS=0.3 SEATS=4 GAMMA=0.999 TEMP0=0.9 BETA=2.5 COLD_FIELD="medium,cultivator,survivor,fighter" COLD_RECORD=cultivator ANCHOR=cultivator ANCHOR_P=0.25
# Hunter: value-lookahead grabs MONSTER VP, FORBID PvP → must earn VP from monsters/economy (your hypothesis, hard test)
launch 1 LANE=hunt  SHAPING=banker   SELECTION=value STATUS_SHAPE_ENV=0 HUNT_BONUS=0.4 SEATS=4 GAMMA=0.99  TEMP0=0.9 BETA=3.0 FORBID=initiatePvp COLD_FIELD="aggressive,fighter,medium,hard,cultivator" COLD_RECORD=aggressive ANCHOR=cultivator ANCHOR_P=0.25
# Pure-Good: value-lookahead + FORBID PvP, small 3p table — the cleanest "can Good win?" test
launch 2 LANE=good  SHAPING=ascend   SELECTION=value STATUS_SHAPE_ENV=0 HUNT_BONUS=0.3 SEATS=3 GAMMA=0.999 TEMP0=0.9 BETA=3.0 FORBID=initiatePvp COLD_FIELD="medium,cultivator,fighter" COLD_RECORD=cultivator ANCHOR=cultivator ANCHOR_P=0.30
# Explorer: PURE-POLICY head, near-zero shaping, MAX temp, records ALL, NO forbid (free to discover) — contrast lane
launch 3 LANE=expl  SHAPING=ascend   SELECTION=value  STATUS_SHAPE_ENV=0 HUNT_BONUS=0.3 SEATS=4 GAMMA=0.999 TEMP0=1.1 BETA=2.5 COLD_FIELD="medium,aggressive,cultivator,survivor,fighter,pvphunter" COLD_RECORD= ANCHOR=pvphunter ANCHOR_P=0.25
sleep 3
echo "DIVERSE_LAUNCHED lanes=$(pgrep -f 'bash ml/diverse_lane.sh' | wc -l) $(date)"

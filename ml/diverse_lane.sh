#!/usr/bin/env bash
# One DIVERSITY lane. Cold-starts from a NON-pvphunter teacher (or all-seat record), then iterates
# league self-play with selection=policy (NO hard-coded initiatePvp / STATUS_SHAPE) + a per-lane
# archetype shaping preset (status<=0). NEW: SHARDED parallel generation (uses the idle cores), plus
# per-lane diversity levers — guardian/origin variety (GEN_SHUFFLE_GUARDIANS / GEN_GUARDIANS) and an
# optional hard never-PvP constraint (FORBID=initiatePvp → must win via monsters/economy). Snapshots
# each checkpoint into the SHARED cross-archetype pool. Trains from scratch each iter (random init).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null 2>&1
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0}"

LANE="${LANE:-eco}"; SHAPING="${SHAPING:-economy}"; SEATS="${SEATS:-4}"
GAMMA="${GAMMA:-0.99}"; TEMP0="${TEMP0:-1.3}"; BETA="${BETA:-3.0}"
ITERS="${ITERS:-400}"; GEN_PER="${GEN_PER:-180}"; SHARDS="${SHARDS:-6}"; COLD_GAMES="${COLD_GAMES:-200}"
KEEP="${KEEP:-4}"; EPOCHS="${EPOCHS:-12}"; BATCH="${BATCH:-8192}"
COLD_FIELD="${COLD_FIELD:-medium,cultivator,survivor,fighter}"
COLD_RECORD="${COLD_RECORD-cultivator}"   # ${VAR-default}: explicit empty string (record ALL) is honored
ANCHOR="${ANCHOR:-medium}"; ANCHOR_P="${ANCHOR_P:-0.25}"
FORBID="${FORBID:-}"                       # e.g. "initiatePvp" → no PvP-VP, forces monster/economy line
SELECTION="${SELECTION:-value}"            # 'value' = VP-grabbing lookahead (scores monster/economy VP); 'policy' = pure learned head
STATUS_SHAPE_ENV="${STATUS_SHAPE_ENV:-0}"  # neuralBot value-lookahead corruption pull; 0 = no corruption bias
HUNT_BONUS="${HUNT_BONUS:-0}"              # explicit monster-kill reward (ARC_HUNT_BONUS); drives the monster/economy line
GUARDIANS="${GUARDIANS:-}"                  # fixed lineup for origin specialization (else shuffle)
SHUFFLE_G="${SHUFFLE_G:-1}"
POOL="${LEAGUE_DIR:-ml/diverse_pool}"
W=ml/weights/policy.json
PER_SHARD=$(( (GEN_PER + SHARDS - 1) / SHARDS ))
mkdir -p "$POOL" ml/data logs ckpt ml/weights
echo "DLANE lane=$LANE shaping=$SHAPING seats=$SEATS gamma=$GAMMA temp0=$TEMP0 forbid='${FORBID}' guardians='${GUARDIANS}' shards=$SHARDS gpu=$CUDA_VISIBLE_DEVICES pool=$POOL $(date)"

# ---- cold start (only if this lane has no learner yet) ----
if [ ! -f "$W" ]; then
  echo "[$LANE] COLD START field=$COLD_FIELD record='${COLD_RECORD}' $(date +%H:%M:%S)"
  GEN=1 GEN_MODE=heur ARC_HUNT_BONUS="$HUNT_BONUS" GEN_GAMES="$COLD_GAMES" GEN_SEATS="$SEATS" GEN_MAXROUNDS=30 \
    GEN_FIELD="$COLD_FIELD" GEN_RECORD_PROFILE="$COLD_RECORD" GEN_SHAPING="$SHAPING" GEN_GAMMA="$GAMMA" \
    GEN_GUARDIANS="$GUARDIANS" GEN_SHUFFLE_GUARDIANS="$SHUFFLE_G" \
    GEN_OUT="ml/data/${LANE}_cold.jsonl" GEN_SEED0=11 \
    npx vitest run src/lib/play/ml/_gen.test.ts --disable-console-intercept > "logs/${LANE}_cold_gen.log" 2>&1
  ml/.venv/bin/python ml/train.py --data ml/data --out "$W" --epochs "$EPOCHS" --beta "$BETA" --batch-size "$BATCH" > "logs/${LANE}_cold_train.log" 2>&1
  cp "$W" "$POOL/.${LANE}_it0.tmp" && mv "$POOL/.${LANE}_it0.tmp" "$POOL/${LANE}_it0.json"
  cp "$W" "ckpt/${LANE}_it0.json"
  echo "[$LANE] cold done samples=$(grep -c '' ml/data/${LANE}_cold.jsonl 2>/dev/null) $(date +%H:%M:%S)"
fi

# ---- league iterations: archetype-shaped, selection=policy, SHARDED gen, shared pool ----
for it in $(seq 1 "$ITERS"); do
  TEMP=$(python3 -c "print(round(max(0.7, ${TEMP0} - 0.01*$it),3))")
  echo "===== [$LANE] ITER $it temp=$TEMP pool=$(ls "$POOL"/*.json 2>/dev/null | wc -l) shards=$SHARDS $(date +%H:%M:%S) ====="
  pids=()
  for sh in $(seq 0 $((SHARDS-1))); do
    LEAGUE=1 GEN_SELECTION="$SELECTION" ARC_STATUS_SHAPE="$STATUS_SHAPE_ENV" ARC_HUNT_BONUS="$HUNT_BONUS" GEN_SHAPING="$SHAPING" LEARNER="$W" LEAGUE_DIR="$POOL" \
      GEN_GAMES="$PER_SHARD" GEN_SEATS="$SEATS" GEN_MAXROUNDS=30 GEN_ANCHOR="$ANCHOR" GEN_ANCHOR_P="$ANCHOR_P" \
      GEN_TEMP="$TEMP" GEN_GAMMA="$GAMMA" GEN_SAMPLE=1 GEN_FORBID="$FORBID" GEN_GUARDIANS="$GUARDIANS" GEN_SHUFFLE_GUARDIANS="$SHUFFLE_G" \
      GEN_OUT="ml/data/${LANE}it${it}_s${sh}.jsonl" GEN_ITER="$it" GEN_SEED0=$((1000 + it*131 + sh*97777)) \
      npx vitest run src/lib/play/ml/_league.test.ts --disable-console-intercept > "logs/${LANE}_gen_${it}_s${sh}.log" 2>&1 &
    pids+=($!)
  done
  wait "${pids[@]}"
  WR=$(grep -hoE "learnerWin=[0-9.]+%" logs/${LANE}_gen_${it}_s*.log 2>/dev/null | tail -1)
  # prune league data older than KEEP iters (keep the cold-start anchor file for stability)
  for f in ml/data/${LANE}it*.jsonl; do n=$(echo "$f" | sed -E "s/.*${LANE}it([0-9]+)_s[0-9]+\.jsonl/\1/"); [ -n "$n" ] && [ "$n" -lt "$((it-KEEP+1))" ] && rm -f "$f"; done
  ml/.venv/bin/python ml/train.py --data ml/data --out "$W" --epochs "$EPOCHS" --beta "$BETA" --batch-size "$BATCH" > "logs/${LANE}_train_$it.log" 2>&1
  cp "$W" "$POOL/.${LANE}_it${it}.tmp" && mv "$POOL/.${LANE}_it${it}.tmp" "$POOL/${LANE}_it${it}.json"
  cp "$W" "ckpt/${LANE}_it${it}.json"
  echo "[$LANE] ITER $it $WR pool=$(ls "$POOL"/*.json 2>/dev/null | wc -l)"
done
echo "DLANE_DONE $LANE $(date)"

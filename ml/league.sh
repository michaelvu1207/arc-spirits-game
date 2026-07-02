#!/usr/bin/env bash
# League: learner plays a growing pool of rival/past-self checkpoints -> AWR -> snapshot to pool ->
# arena rank. Repeats; when the newest checkpoint stops beating the field, the league has converged.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null 2>&1
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0}"
LANE="${LANE:-L}"; ITERS="${ITERS:-12}"; SHARDS="${SHARDS:-24}"; GEN_PER="${GEN_PER:-50}"
KEEP="${KEEP:-5}"; EPOCHS="${EPOCHS:-12}"; BETA="${BETA:-3.0}"; BATCH="${BATCH:-8192}"
ANCHOR_P="${ANCHOR_P:-0.2}"; POOL="${LEAGUE_DIR:-ml/league}"
mkdir -p "$POOL" ml/data logs ckpt
echo "LEAGUE lane=$LANE iters=$ITERS shards=$SHARDS pool=$POOL gpu=$CUDA_VISIBLE_DEVICES anchorP=$ANCHOR_P $(date)"
for it in $(seq 1 "$ITERS"); do
  TEMP=$(python3 -c "print(round(max(0.6, ${TEMP0:-1.15} - 0.03*$it),3))")
  echo "===== $LANE ITER $it temp=$TEMP pool=$(ls "$POOL"/*.json 2>/dev/null | wc -l) $(date +%H:%M:%S) ====="
  GEN_TEMP="$TEMP" GEN_ANCHOR_P="$ANCHOR_P" LEAGUE_DIR="$POOL" GEN_MAXROUNDS="${GEN_MAXROUNDS:-30}" \
    ./ml/league_gen.sh "$GEN_PER" "$SHARDS" "${LANE}it$it" > "logs/${LANE}_gen_$it.log" 2>&1
  WR=$(grep -oE "learnerWin=[0-9.]+%" "logs/${LANE}_gen_$it.log" | tail -1)
  for f in ml/data/${LANE}it*.jsonl; do n=$(echo "$f" | sed -E "s/.*${LANE}it([0-9]+)_.*/\1/"); [ -n "$n" ] && [ "$n" -lt "$((it-KEEP+1))" ] && rm -f "$f"; done
  ml/.venv/bin/python ml/train.py --data ml/data --out ml/weights/policy.json --epochs "$EPOCHS" --beta "$BETA" --batch-size "$BATCH" > "logs/${LANE}_train_$it.log" 2>&1
  cp ml/weights/policy.json "$POOL/.${LANE}_it${it}.tmp" && mv "$POOL/.${LANE}_it${it}.tmp" "$POOL/${LANE}_it${it}.json"
  cp ml/weights/policy.json "ckpt/${LANE}_it${it}.json"
  echo "$LANE ITER $it $WR pool=$(ls "$POOL"/*.json 2>/dev/null | wc -l)"
done
echo "LEAGUE_DONE $LANE $(date)"

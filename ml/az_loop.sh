#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# AlphaZero self-play iteration loop for the Arc Spirits planning bot.
#
#   gen (neural ISMCTS self-play, CPU, sharded) → train (alphazero, GPU) → export → eval → repeat
#
# The planner plans the multi-round navigation skeleton with MCTS over the engine forward model;
# the value net (trained on game OUTCOMES) is the leaf evaluator, the policy net the PUCT prior.
# Search is the policy-improvement operator: each iteration's visit distributions train the next net.
#
# A100 NOTE: gen is CPU-bound (engine sim) → shard across cores; train is GPU. Use GPUs 0-3 ONLY
# (4-7 = CARLA). Set CUDA_VISIBLE_DEVICES=0,1,2,3 before launching.
#
# Usage:
#   bash ml/az_loop.sh                      # defaults
#   AZ_OUTER=12 AZ_GAMES=400 AZ_SHARDS=12 AZ_MCTS=200 bash ml/az_loop.sh
# ─────────────────────────────────────────────────────────────────────────────
set -u

cd "$(dirname "$0")/.." || exit 1

# Node 22 (vitest needs native WebSocket; A100 default node may be v20). Load nvm if present.
set +u
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null 2>&1
set -u
echo "[az_loop] node=$(node -v 2>/dev/null)"

# ── config ───────────────────────────────────────────────────────────────────
OUTER=${AZ_OUTER:-10}              # number of gen→train iterations
GAMES=${AZ_GAMES:-300}             # self-play games per iteration (split across shards)
SHARDS=${AZ_SHARDS:-8}             # parallel gen processes (≈ CPU cores − 2)
MCTS=${AZ_MCTS:-200}               # MCTS iterations per decision (sharper pi = more)
HORIZON=${AZ_HORIZON:-30}
EPOCHS=${AZ_EPOCHS:-6}
WINDOW=${AZ_WINDOW:-3}             # replay-buffer window (keep last N iterations of data)
FIELD=${AZ_PROFILES:-${AZ_FIELD:-pvphunter,medium,cultivator,survivor}}  # GEN opponent field (diverse incl. champion)
PLANNER_PROFILE=${AZ_PLANNER_PROFILE:-cultivator}                         # planner within-round (clean economy)
EVAL_FIELD=${AZ_EVAL_FIELD:-pvphunter,medium,cultivator,survivor}
HIDDEN=${ARC_HIDDEN:-256,256}      # trunk width
VHIDDEN=${ARC_VALUE_HIDDEN:-128}   # value-head width (planning wants value capacity)
DATA=ml/data_az
WEIGHTS=ml/weights/policy.json
PYTHON=${PYTHON:-ml/.venv/bin/python}

mkdir -p "$DATA" ml/weights ml/logs
echo "[az_loop] OUTER=$OUTER GAMES=$GAMES SHARDS=$SHARDS MCTS=$MCTS WINDOW=$WINDOW HIDDEN=$HIDDEN/$VHIDDEN"
echo "[az_loop] gen field=$FIELD  eval field=$EVAL_FIELD  weights=$WEIGHTS"

for it in $(seq 1 "$OUTER"); do
  echo ""
  echo "════════ ITERATION $it / $OUTER ════════"

  # valueWeight schedule. The leaf = valueW·V_net + (1−valueW)·heuristic-playout-outcome.
  # We KEEP a heuristic-playout safety net (cap < 1.0) so a still-noisy value net can never collapse
  # search to a degenerate constant (observed when valueW jumps to 1.0 with an under-trained net).
  # Gently anneal toward the value net as it improves; eval per-iter shows when it's safe to raise.
  # Override with AZ_VALUEW to force a fixed weight.
  if [ -n "${AZ_VALUEW:-}" ]; then VALUEW=$AZ_VALUEW;
  elif [ "$it" -le 2 ]; then VALUEW=0.4;
  elif [ "$it" -le 5 ]; then VALUEW=0.6;
  else VALUEW=0.8; fi

  # ── 1. GEN (sharded, parallel) ────────────────────────────────────────────
  per=$(( (GAMES + SHARDS - 1) / SHARDS ))
  echo "[az_loop] gen: $SHARDS shards × $per games, MCTS=$MCTS valueW=$VALUEW"
  pids=()
  for s in $(seq 0 $((SHARDS - 1))); do
    AZ=1 AZ_GAMES=$per AZ_ITERS=$MCTS AZ_HORIZON=$HORIZON AZ_VALUEW=$VALUEW \
      AZ_SAMPLE=1 AZ_TEMP=1 AZ_ITER=$it AZ_PROFILES="$FIELD" AZ_PLANNER_PROFILE="$PLANNER_PROFILE" \
      AZ_SEED0=$((4000000 + it * 1000000 + s * 100000)) \
      AZ_OUT="$DATA/iter${it}_shard${s}.jsonl" AZ_WEIGHTS="$WEIGHTS" \
      npx vitest run src/lib/play/ml/_azgen.test.ts --disable-console-intercept \
      > "ml/logs/gen_it${it}_s${s}.log" 2>&1 &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p"; done
  n=$(cat "$DATA"/iter${it}_shard*.jsonl 2>/dev/null | wc -l)
  echo "[az_loop] gen done: $n samples this iter"

  # ── 2. PRUNE replay buffer to the last $WINDOW iterations ──────────────────
  old=$((it - WINDOW))
  if [ "$old" -ge 1 ]; then rm -f "$DATA"/iter${old}_shard*.jsonl; fi
  # Derive dimensions from the generated rows so encoder bumps cannot poison training.
  read -r OBS_DIM ACT_DIM < <(node scripts/read-ml-sample-dims.mjs "$DATA")
  printf '{"obs_dim":%s,"act_dim":%s}' "$OBS_DIM" "$ACT_DIM" > "$DATA/meta.json"

  # ── 3. TRAIN (alphazero: pi cross-entropy + outcome value MSE) ─────────────
  echo "[az_loop] train: epochs=$EPOCHS hidden=$HIDDEN value=$VHIDDEN"
  ARC_HIDDEN="$HIDDEN" ARC_VALUE_HIDDEN="$VHIDDEN" \
    "$PYTHON" ml/train.py --data "$DATA" --out "$WEIGHTS" \
    --mode alphazero --epochs "$EPOCHS" 2>&1 | tee "ml/logs/train_it${it}.log" | grep -E "Epoch|Loaded|exported"

  # ── 4. EVAL vs the corruption-champion field ───────────────────────────────
  echo "[az_loop] eval vs [$EVAL_FIELD]"
  AZEVAL=1 AZEVAL_GAMES=${AZ_EVAL_GAMES:-24} AZEVAL_ITERS="${AZ_EVAL_MCTS:-$MCTS}" AZEVAL_VALUEW="$VALUEW" \
    AZEVAL_FIELD="$EVAL_FIELD" AZEVAL_PLANNER_PROFILE="$PLANNER_PROFILE" AZEVAL_WEIGHTS="$WEIGHTS" \
    npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept 2>&1 \
    | grep -E "azeval" | tee -a "ml/logs/eval_it${it}.log"

  cp "$WEIGHTS" "ml/weights/az_iter${it}.json"
  echo "[az_loop] iteration $it complete → snapshot ml/weights/az_iter${it}.json"
done

echo ""
echo "[az_loop] ALL DONE. Per-iteration eval in ml/logs/eval_it*.log; weights ml/weights/az_iter*.json"

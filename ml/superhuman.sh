#!/usr/bin/env bash
# Autonomous self-play loop: net-vs-FIELD generation (annealed exploration) -> prune stale data ->
# AWR retrain on GPU -> checkpoint -> eval vs the hard roster. Drives toward a bot that beats ALL
# heuristic profiles and wins (most VP at the 30-round cap, ideally reaching the 30-VP target early).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null 2>&1
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0}"

START="${START:-1}"; ITERS="${ITERS:-15}"; SHARDS="${SHARDS:-28}"; GEN_PER="${GEN_PER:-60}"
EVAL_GAMES="${EVAL_GAMES:-40}"; KEEP="${KEEP:-6}"; EPOCHS="${EPOCHS:-12}"; BETA="${BETA:-3.0}"; BATCH="${BATCH:-8192}"
ROSTER="${ROSTER:-pvphunter,hard,medium,mixed,aggressive,cultivator}"
BIGROSTER="${BIGROSTER:-pvphunter,godly,insane,mythic,extrahard,hard,paragon,cursed,rushpatient,corruption,medium,mixed}"
FIELD="${FIELD:-pvphunter,pvphunter,medium,aggressive,cultivator,survivor,fighter,hard}"  # training opponents
SEL="${SEL:-hybrid}"   # gen selection: hybrid (fast) | value (1-ply lookahead) | policy
LANE="${LANE:-main}"
mkdir -p logs ckpt ml/data
echo "SUPERHUMAN_LOOP lane=$LANE start=$START iters=$ITERS shards=$SHARDS gen_per=$GEN_PER sel=$SEL field=[$FIELD] beta=$BETA gpu=$CUDA_VISIBLE_DEVICES $(date)"

for it in $(seq "$START" "$((START+ITERS-1))"); do
  TEMP=$(python3 -c "print(round(max(${TFLOOR:-0.7}, ${TEMP0:-1.25} - ${TDECAY:-0.025}*$it),3))")
  echo "===== ITER $it temp=$TEMP $(date +%H:%M:%S) ====="
  # 1) self-play generation: current net (neural seat) vs the heuristic FIELD, sampled for exploration
  GEN_MAXROUNDS="${GEN_MAXROUNDS:-30}" GEN_SELECTION="$SEL" GEN_SAMPLE=1 GEN_TEMP="$TEMP" GEN_FIELD="$FIELD" ./ml/run_gen.sh neural "$GEN_PER" "$SHARDS" "it$it" > "logs/gen_$it.log" 2>&1
  WR=$(grep -oE "neuralWinRate=[0-9.]+%" "logs/gen_$it.log" | tail -1)
  SAMP=$(cat ml/data/it${it}_*.jsonl 2>/dev/null | wc -l)
  # 2) prune stale self-play data: keep cold_* prior + last KEEP iterations
  for f in ml/data/it*.jsonl; do
    n=$(echo "$f" | sed -E 's/.*\/it([0-9]+)_.*/\1/')
    [ -n "$n" ] && [ "$n" -lt "$((it-KEEP+1))" ] && rm -f "$f"
  done
  # 3) AWR retrain on GPU (winners up-weighted via VP return-to-go)
  ml/.venv/bin/python ml/train.py --data ml/data --out ml/weights/policy.json --epochs "$EPOCHS" --beta "$BETA" --batch-size "$BATCH" > "logs/train_$it.log" 2>&1
  TOP1=$(grep -oE "top1_acc=[0-9.]+" "logs/train_$it.log" | tail -1)
  cp ml/weights/policy.json "ckpt/policy_it$it.json"
  # 4) eval (full hard roster every 5th iter, else the fast set)
  if [ "$((it % 5))" -eq 0 ]; then RSET="$BIGROSTER"; else RSET="$ROSTER"; fi
  EVAL=1 EVAL_GAMES="$EVAL_GAMES" EVAL_OPPONENTS="$RSET" EVAL_SELECTION=hybrid EVAL_MAXROUNDS="${EVAL_MAXROUNDS:-30}" \
    npx vitest run src/lib/play/ml/_eval.test.ts --disable-console-intercept > "logs/eval_$it.log" 2>&1
  cp ml/eval_result.json "ckpt/eval_it$it.json" 2>/dev/null || true
  echo "ITER $it genWR=$WR samples=$SAMP $TOP1 temp=$TEMP"
  grep "\[eval\] neural" "logs/eval_$it.log" || echo "  (eval produced no lines — check logs/eval_$it.log)"
done
echo "SUPERHUMAN_LOOP_DONE $(date)"

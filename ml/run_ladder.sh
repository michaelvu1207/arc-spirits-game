#!/usr/bin/env bash
# Train the 16-model ladder smallest->largest (4 GPUs, waves of 4), ELO after every wave so the
# capacity curve builds live. All models <=500K params (fast to train + arena). Run detached.
set -u
BASE=/data/share8/michaelvuaprilexperimentation; WS=$BASE/arc-bot; cd "$WS"
export NVM_DIR=$HOME/.nvm; . "$NVM_DIR/nvm.sh" 2>/dev/null; nvm use 22 >/dev/null 2>&1
DATA="${DATA:-ml/sizes_data_1m}"; EPOCHS="${EPOCHS:-30}"; BETA="${BETA:-3.0}"; ELO_GAMES="${ELO_GAMES:-400}"
echo "LADDER start data=$DATA samples=$(wc -l < $DATA/*.jsonl 2>/dev/null) $(date)"
# stop the old giant sweep (train_sizes.sh + its train.py), spare the league
for p in $(pgrep -f train_sizes.sh); do kill -9 "$p" 2>/dev/null; done
for p in $(pgrep -f ml/train.py); do tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | grep -q 'ml/sizes/' && kill -9 "$p" 2>/dev/null; done
sleep 3
rm -rf ml/ladder ml/ladder_elo; mkdir -p ml/ladder ml/ladder_elo logs
# strong fixed anchors for ELO grounding
cp ml/weights/policy.json ml/ladder_elo/zzchampion.json 2>/dev/null
for f in "$BASE"/league/seed_lane0.json "$BASE"/league/seed_lane2.json; do [ -f "$f" ] && cp "$f" ml/ladder_elo/zz$(basename "$f"); done
CFG=(s01:16:8 s02:20:8 s03:26,26:8 s04:34,34:11 s05:44,44:14 s06:58,58:19 s07:76,76:25 s08:100,100:33 \
     s09:130,130:43 s10:170,170:56 s11:222,222:74 s12:290,290:96 s13:360,360:120 s14:430,430:143 s15:510,510:170 s16:640,640:213)
for w in 0 4 8 12; do
  echo "===== WAVE @$w (sizes $((w+1))-$((w+4))) $(date +%H:%M:%S) ====="
  pids=()
  for j in 0 1 2 3; do
    idx=$((w+j)); [ $idx -ge 16 ] && break
    IFS=: read -r nm th vh <<< "${CFG[$idx]}"
    ( CUDA_VISIBLE_DEVICES=$j ARC_HIDDEN=$th ARC_VALUE_HIDDEN=$vh ml/.venv/bin/python -u ml/train.py \
        --data "$DATA" --out "ml/ladder/$nm.json" --epochs "$EPOCHS" --beta "$BETA" --batch-size 8192 > "logs/ladder_$nm.log" 2>&1
      cp "ml/ladder/$nm.json" "ml/ladder_elo/$nm.json" ) &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p"; done
  echo "  trained=$(ls ml/ladder/*.json 2>/dev/null | wc -l)/16  top1: $(for n in s$(printf %02d $((w+1))) s$(printf %02d $((w+2))) s$(printf %02d $((w+3))) s$(printf %02d $((w+4))); do echo -n "$n=$(grep -oE 'top1_acc=[0-9.]+' logs/ladder_$n.log 2>/dev/null | tail -1 | cut -d= -f2) "; done)"
  echo "  --- ELO after wave @$w ---"
  ELO=1 ELO_DIR=ml/ladder_elo ELO_GAMES="$ELO_GAMES" npx vitest run src/lib/play/ml/_elo.test.ts --disable-console-intercept > "logs/ladder_elo_w$w.log" 2>&1
  grep -E '\[elo\] #|BEST PER SIZE' "logs/ladder_elo_w$w.log"
done
echo "LADDER_DONE $(date)"

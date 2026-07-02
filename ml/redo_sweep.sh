#!/usr/bin/env bash
set -u
WS=/data/share8/michaelvuaprilexperimentation/arc-bot; cd "$WS"
export NVM_DIR=$HOME/.nvm; . "$NVM_DIR/nvm.sh" 2>/dev/null; nvm use 22 >/dev/null 2>&1
echo "redo start $(date)"
# kill size sweep (train_sizes.sh + its train.py children), spare the league
for p in $(pgrep -f train_sizes.sh); do kill -9 "$p" 2>/dev/null; done
for p in $(pgrep -f ml/train.py); do tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | grep -q 'ml/sizes' && kill -9 "$p" 2>/dev/null; done
sleep 4
echo "after kill: size train.py=$(for p in $(pgrep -f ml/train.py); do tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | grep -c 'ml/sizes'; done | paste -sd+ | bc 2>/dev/null || echo 0)"
# subsample 1M shuffled samples into one file (fast to load)
mkdir -p ml/sizes_data_1m
cat ml/sizes_data/*.jsonl 2>/dev/null | shuf -n 1000000 > ml/sizes_data_1m/data.jsonl
echo "1M set: $(wc -l < ml/sizes_data_1m/data.jsonl) samples"
# relaunch sweep on the small set
DATA=ml/sizes_data_1m nohup bash ml/train_sizes.sh > logs/train_sizes.log 2>&1 < /dev/null &
echo "relaunched sweep pid=$! $(date)"

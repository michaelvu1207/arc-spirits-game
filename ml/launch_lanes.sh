#!/usr/bin/env bash
# Launch 4 population-based training lanes, one per GPU, each with a distinct recipe.
# All detached (nohup) so they survive SSH disconnects. Champions are cross-evaluated later.
set -u
WS="${WS:-/data/share8/michaelvuaprilexperimentation/arc-bot}"
COMMON_ITERS="${ITERS:-14}"

launch () {
  local i="$1"; shift
  cd "$WS/../lane$i" || return 1
  mkdir -p logs
  env CUDA_VISIBLE_DEVICES="$i" LANE="lane$i" START=1 ITERS="$COMMON_ITERS" SHARDS=24 GEN_PER=60 \
      EVAL_GAMES=32 KEEP=6 EPOCHS=12 BATCH=8192 \
      ROSTER="pvphunter,hard,extrahard,medium,mixed,aggressive,cultivator" "$@" \
      nohup bash ml/superhuman.sh > logs/superhuman.log 2>&1 < /dev/null &
  echo "launched lane$i gpu=$i pid=$! extra=[$*]"
}

# lane0 — balanced workhorse (standard diverse field)
launch 0 SEL=hybrid BETA=3.0 TEMP0=1.2 TFLOOR=0.7 TDECAY=0.03 \
  FIELD=pvphunter,pvphunter,medium,aggressive,cultivator,survivor,fighter,hard
# lane1 — pvp-crack: pvphunter-heavy field + winners-only AWR to beat the holdout
launch 1 SEL=hybrid BETA=4.0 TEMP0=1.2 TFLOOR=0.7 TDECAY=0.03 \
  FIELD=pvphunter,pvphunter,pvphunter,medium,aggressive,cultivator
# lane2 — strong-field: train against the tougher heuristic tiers
launch 2 SEL=hybrid BETA=3.0 TEMP0=1.2 TFLOOR=0.7 TDECAY=0.03 \
  FIELD=pvphunter,hard,extrahard,paragon,cursed,rushpatient,corruption,aggressive
# lane3 — explore: hot sampling + 1-ply value lookahead + broad field to discover new lines
launch 3 SEL=value BETA=2.0 TEMP0=1.6 TFLOOR=0.95 TDECAY=0.02 \
  FIELD=pvphunter,medium,aggressive,cultivator,survivor,fighter,hard,paragon,cursed,corruption

sleep 3
echo ALL_LANES_LAUNCHED
pgrep -fa superhuman.sh | wc -l

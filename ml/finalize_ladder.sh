#!/usr/bin/env bash
# Wait for the 16-size ladder to finish, then run ONE definitive high-game ELO over all 16 trained
# models + anchors so every model gets ~hundreds of games (stable ratings, unlike the noisy per-wave
# 400-game passes). Writes ml/ladder_final_elo.json + logs/final_elo.log.
set -u
BASE=/data/share8/michaelvuaprilexperimentation
WS=$BASE/arc-bot
cd "$WS"
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null 2>&1

echo "FINALIZE waiting for LADDER_DONE $(date)"
for i in $(seq 1 360); do
  grep -q LADDER_DONE logs/ladder.log 2>/dev/null && { echo "LADDER_DONE seen at iter=$i $(date)"; break; }
  sleep 15
done

# Make sure every trained size is present in the ELO dir alongside the anchors (zz*).
cp ml/ladder/*.json ml/ladder_elo/ 2>/dev/null
echo "models in ml/ladder_elo: $(ls ml/ladder_elo/*.json 2>/dev/null | wc -l)  ($(ls ml/ladder_elo/*.json 2>/dev/null | xargs -n1 basename | tr '\n' ' '))"

# Definitive ELO: many games so each of ~18 models plays ~hundreds (stable). 4 seats/game.
ELO=1 ELO_DIR=ml/ladder_elo ELO_GAMES="${ELO_GAMES:-2500}" ELO_MAXROUNDS=40 ELO_K="${ELO_K:-16}" \
  npx vitest run src/lib/play/ml/_elo.test.ts --disable-console-intercept > logs/final_elo.log 2>&1
cp ml/elo_result.json ml/ladder_final_elo.json 2>/dev/null

echo "FINALIZE_DONE $(date)"
grep -E "\[elo\]" logs/final_elo.log | tail -70

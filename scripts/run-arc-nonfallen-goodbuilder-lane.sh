#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

RUN_ID="${RUN_ID:-nonfallen-goodbuilder-$(date -u +%Y%m%dT%H%M%SZ)}" \
GPU="${GPU:-4}" \
MIN_FREE_MB="${MIN_FREE_MB:-10000}" \
MINE_GAMES="${MINE_GAMES:-48}" \
MINE_ITERS="${MINE_ITERS:-24}" \
MINE_HORIZON="${MINE_HORIZON:-16}" \
MINE_MIN_DECISION_VP="${MINE_MIN_DECISION_VP:-4}" \
MINE_NEAR_MIN_VP="${MINE_NEAR_MIN_VP:-10}" \
MINE_SUCCESS_VP="${MINE_SUCCESS_VP:-15}" \
MINE_MAX_STATUS_LEVEL="${MINE_MAX_STATUS_LEVEL:-2}" \
EPOCHS="${EPOCHS:-10}" \
BATCH="${BATCH:-4096}" \
EVAL_GAMES="${EVAL_GAMES:-16}" \
EVAL_ITERS="${EVAL_ITERS:-24}" \
EVAL_HORIZON="${EVAL_HORIZON:-16}" \
PURE_NAV_GATE="${PURE_NAV_GATE:-good-nonfallen-farm-build}" \
TARGET_STATUS_CAP="${TARGET_STATUS_CAP:-2}" \
TARGET_FORBID_TYPES="${TARGET_FORBID_TYPES:-initiatePvp}" \
BASE_GOOD_STACK="${BASE_GOOD_STACK:-ml/stacks/neural-field-good-nonfallen-targets.json}" \
bash "$SCRIPT_DIR/run-arc-allseat-goodbuilder-lane.sh"

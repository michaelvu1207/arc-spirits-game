#!/usr/bin/env bash
set -euo pipefail

HOST="${ARC_BOT_GPU_HOST:-ubuntu@216.151.21.122}"
REMOTE_DIR="${ARC_BOT_REMOTE_DIR:-/data/share8/michaelvuaprilexperimentation/arc-bot}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RSYNC_FLAGS=(-az)
if [[ "${ARC_BOT_SYNC_DELETE:-}" == "1" ]]; then
	# Deletion is opt-in: the remote workspace also owns expensive league/replay
	# artifacts and one-off investigation files that a normal source sync must not
	# erase merely because they do not exist in the local checkout.
	RSYNC_FLAGS+=(--delete)
fi
if [[ -n "${ARC_BOT_SYNC_DRY_RUN:-}" ]]; then
	RSYNC_FLAGS+=(--dry-run --itemize-changes)
fi

rsync "${RSYNC_FLAGS[@]}" \
  --exclude '.git/' \
	--exclude '.agents/' \
	--exclude '.claude/' \
	--exclude '.codex/' \
	--exclude '.vercel/' \
  --exclude 'node_modules/' \
  --exclude '.svelte-kit/' \
  --exclude 'build/' \
	--exclude 'test-results/' \
	--exclude 'playwright-report/' \
	--exclude '__pycache__/' \
	--exclude '.pytest_cache/' \
	--exclude '.DS_Store' \
	--exclude 'godot/' \
  --exclude 'ml/.venv/' \
  --exclude 'ml/data/' \
  --exclude 'ml/data_*/' \
  --exclude 'ml/data_az/' \
  --exclude 'ml/logs/' \
  --exclude 'ml/meta_runs/' \
  --exclude 'ml/weights/' \
	--exclude 'ml/league_*/' \
	--exclude 'ml/v13_finalists/' \
	--exclude 'ml/benchmarks/' \
	--exclude 'ml/research/runs/' \
	--filter 'protect ml/gauntlet_results/***' \
  "$ROOT_DIR/" \
  "$HOST:$REMOTE_DIR/"

if [[ -n "${ARC_BOT_SYNC_DRY_RUN:-}" ]]; then
	exit 0
fi

if [[ -n "${ARC_BOT_SYNC_META_RUNS:-}" ]]; then
  ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" "mkdir -p '$REMOTE_DIR/ml/meta_runs'"
  IFS=',' read -r -a meta_runs <<< "$ARC_BOT_SYNC_META_RUNS"
  for run in "${meta_runs[@]}"; do
    run="$(echo "$run" | xargs)"
    [[ -z "$run" ]] && continue
    if [[ "$run" == *"/"* || "$run" == *".."* ]]; then
      echo "refusing unsafe meta run name: $run" >&2
      exit 2
    fi
    if [[ ! -d "$ROOT_DIR/ml/meta_runs/$run" ]]; then
      echo "missing local meta run: ml/meta_runs/$run" >&2
      exit 2
    fi
    rsync -az "$ROOT_DIR/ml/meta_runs/$run/" "$HOST:$REMOTE_DIR/ml/meta_runs/$run/"
  done
fi

if [[ -n "${ARC_BOT_PULL_META_RUNS:-}" ]]; then
  mkdir -p "$ROOT_DIR/ml/meta_runs"
  IFS=',' read -r -a meta_runs <<< "$ARC_BOT_PULL_META_RUNS"
  for run in "${meta_runs[@]}"; do
    run="$(echo "$run" | xargs)"
    [[ -z "$run" ]] && continue
    if [[ "$run" == *"/"* || "$run" == *".."* ]]; then
      echo "refusing unsafe meta run name: $run" >&2
      exit 2
    fi
    rsync -az "$HOST:$REMOTE_DIR/ml/meta_runs/$run/" "$ROOT_DIR/ml/meta_runs/$run/"
  done
fi

ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" "cd '$REMOTE_DIR' && test -s docs/bot-testing-criteria.md && test -s package.json && pwd"

#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPERIMENT="$ROOT/ml/experiments/v32-onpolicy-solo"
LEAGUE_ROOT="${1:?league root required}"
TARGET_GEN="${2:-8}"
SCRATCH_BASE="${ARC_V32_SCREEN_SCRATCH:-/dev/shm/arc-v32-screen}"

cd "$ROOT"
node scripts/lock-v32-inputs.mjs verify "$EXPERIMENT/artifacts/screen-lock.json"
LEAGUE_ROOT="$(cd "$(dirname "$LEAGUE_ROOT")" && pwd)/$(basename "$LEAGUE_ROOT")"
case "$LEAGUE_ROOT" in "$EXPERIMENT"/league/*) ;; *) echo "root outside V32 experiment" >&2; exit 2;; esac
RELATIVE="${LEAGUE_ROOT#"$EXPERIMENT/league/"}"
SCRATCH="$SCRATCH_BASE/$RELATIVE"
mkdir -p "$SCRATCH/data" "$LEAGUE_ROOT/artifacts"
df -Pk "$SCRATCH" | awk 'NR==2 && $4 < 16*1024*1024 {exit 1}'
if [[ ! -e "$LEAGUE_ROOT/data" ]]; then
  ln -s "$SCRATCH/data" "$LEAGUE_ROOT/data"
fi
test -L "$LEAGUE_ROOT/data"
test "$(readlink -f "$LEAGUE_ROOT/data")" = "$(readlink -f "$SCRATCH/data")"

if [[ ! -f "$LEAGUE_ROOT/state.json" ]]; then
  nice -n 10 node scripts/run-league.mjs init --root "$LEAGUE_ROOT"
fi
finalize_generation() {
  local gen="$1"
  local audit="$LEAGUE_ROOT/artifacts/gen${gen}-audit.json"
  if [[ ! -e "$audit" ]]; then
    env PYTHONPATH=ml nice -n 10 ml/.venv/bin/python ml/audit_v32_generation.py \
      --root "$LEAGUE_ROOT" --gen "$gen" --out "$audit"
  fi
  while IFS= read -r -d '' file; do
    zstd -q -T2 "$file" -o "$file.zst"
    zstd -q -t "$file.zst"
    rm "$file"
  done < <(find "$LEAGUE_ROOT/data/gen$gen" -type f -name '*.jsonl' -print0)
}
while :; do
  CURRENT="$(node -e "const s=require(process.argv[1]);process.stdout.write(String(s.gen))" "$LEAGUE_ROOT/state.json")"
  for (( completed=1; completed<=CURRENT; completed++ )); do
    finalize_generation "$completed"
  done
  (( CURRENT >= TARGET_GEN )) && break
  GEN=$((CURRENT + 1))
  AUDIT="$LEAGUE_ROOT/artifacts/gen${GEN}-audit.json"
  test ! -e "$AUDIT"
  nice -n 10 node scripts/run-league.mjs run --root "$LEAGUE_ROOT" --gens 1
  finalize_generation "$GEN"
done
printf 'V32 root complete root=%s gen=%s\n' "$LEAGUE_ROOT" "$TARGET_GEN"

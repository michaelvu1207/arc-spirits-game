#!/bin/bash
# Start one simulation job, detached: it survives a closed ssh session (nohup) and keeps the Mac
# awake while it runs (caffeinate -i). Prints one JSON line: {"runId", "runDir", "statusFile", "pid"}.
#
#   scripts/agent-harness/sim/run-sim.sh --data <design dir> [--baseline <design dir>] \
#       [--games 4] [--model gw:gpt-6.1-sol] [--effort low] \
#       [--strategies fire,moon-evil,barrier-hunter,free] [--seed 1] [--run-id <id>] \
#       [--parallel-games 2] [--max-concurrent-calls 8] [--max-decisions 3000] [--runs-root <dir>]
#
# Progress and result: <runDir>/status.json (scripts/agent-harness/sim/status.sh [run-id]).
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
here="$(cd "$(dirname "$0")" && pwd)"
game="$(cd "$here/../../.." && pwd)"

run_id=""
runs_root="$HOME/arcspirits-harness/runs"
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
	case "${args[$i]}" in
		--run-id) run_id="${args[$((i + 1))]:-}" ;;
		--runs-root) runs_root="${args[$((i + 1))]:-}" ;;
	esac
done
if [[ -z "$run_id" ]]; then
	run_id="sim-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 3)"
	args+=(--run-id "$run_id")
fi
run_dir="$runs_root/$run_id"
if [[ -e "$run_dir" ]]; then
	echo "{\"error\": \"$run_dir already exists\"}"
	exit 1
fi
mkdir -p "$run_dir"
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# A first status at once, so a caller can poll right after this script returns.
printf '{\n  "runId": "%s",\n  "state": "queued",\n  "gamesDone": 0,\n  "gamesTotal": 0,\n  "started": "%s",\n  "updated": "%s",\n  "message": "queued"\n}\n' \
	"$run_id" "$now" "$now" > "$run_dir/status.json"

cd "$game"
nohup caffeinate -i node --import tsx "$here/sim.ts" "${args[@]}" \
	< /dev/null > "$run_dir/sim.log" 2>&1 &
pid=$!
disown "$pid" 2>/dev/null || true
echo "{\"runId\": \"$run_id\", \"runDir\": \"$run_dir\", \"statusFile\": \"$run_dir/status.json\", \"pid\": $pid}"

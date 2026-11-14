#!/bin/bash
# Print the status.json of a simulation run: the given run id, or the newest run.
#
#   scripts/agent-harness/sim/status.sh [run-id] [--runs-root <dir>]
set -euo pipefail
runs_root="$HOME/arcspirits-harness/runs"
run_id=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		--runs-root) runs_root="$2"; shift 2 ;;
		*) run_id="$1"; shift ;;
	esac
done
if [[ -z "$run_id" ]]; then
	newest="$(ls -t "$runs_root"/*/status.json 2>/dev/null | head -n 1 || true)"
	if [[ -z "$newest" ]]; then
		echo "{\"error\": \"no runs in $runs_root\"}"
		exit 1
	fi
	cat "$newest"
	exit 0
fi
file="$runs_root/$run_id/status.json"
if [[ ! -f "$file" ]]; then
	echo "{\"error\": \"no status for run $run_id\"}"
	exit 1
fi
cat "$file"

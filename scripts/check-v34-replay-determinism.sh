#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPERIMENT_REL="ml/experiments/v34-latency-first-expert-iteration"
STRENGTH_PROTOCOL_REL="$EXPERIMENT_REL/strength-protocol.json"
OUT="${1:-}"
IMPLEMENTATION_COMMIT="${2:-}"
GPU="${3:-${ARC_V34_PREFLIGHT_GPU:-5}}"
if [[ -z "$OUT" || ! "$IMPLEMENTATION_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
	echo "usage: check-v34-replay-determinism.sh OUT_JSON IMPLEMENTATION_COMMIT [GPU]" >&2
	exit 2
fi
case "$GPU" in
	0|5|6|7) ;;
	*) echo "V34 replay determinism GPU must be 0, 5, 6, or 7; GPU 4 is forbidden" >&2; exit 2 ;;
esac

cd "$ROOT"
test ! -e "$OUT"
POLICY_REL="$(node -e "const x=require('./$STRENGTH_PROTOCOL_REL');process.stdout.write(x.base.checkpointPath)")"
CATALOG_REL="$(node -e "const x=require('./$STRENGTH_PROTOCOL_REL');process.stdout.write(x.base.catalogPath)")"
SEED0="$(node -e "const x=require('./$EXPERIMENT_REL/protocol.json');process.stdout.write(String(x.previewCalibration.seed0))")"
GAMES=64
SCRATCH="$(mktemp -d /dev/shm/arc-v34-replay-preflight.XXXXXX)"
SOCKET="$SCRATCH/infer.sock"
SERVER_PID=""

cleanup() {
	if [[ -n "$SERVER_PID" ]]; then
		kill -TERM "$SERVER_PID" 2>/dev/null || true
		for _ in $(seq 1 100); do
			kill -0 "$SERVER_PID" 2>/dev/null || break
			sleep 0.1
		done
		kill -KILL "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
		SERVER_PID=""
	fi
	rm -rf "$SCRATCH"
}
trap cleanup EXIT INT TERM

gpu_uuid="$(nvidia-smi --id="$GPU" --query-gpu=uuid --format=csv,noheader | tr -d '[:space:]')"
test -n "$gpu_uuid"
compute_apps="$(nvidia-smi --query-compute-apps=gpu_uuid --format=csv,noheader)"
if printf '%s\n' "$compute_apps" | tr -d ' \t\r' | grep -Fxq "$gpu_uuid"; then
	echo "V34 replay preflight GPU $GPU is occupied" >&2
	exit 2
fi

env CUDA_VISIBLE_DEVICES="$GPU" nice -n 19 ml/.venv/bin/python ml/infer_server.py \
	--weights "$POLICY_REL" --socket "$SOCKET" --device cuda --window-ms 2 --max-batch 512 \
	--stats-interval 5 > "$SCRATCH/infer.log" 2>&1 &
SERVER_PID=$!
ready=false
for _ in $(seq 1 120); do
	if [[ -S "$SOCKET" ]]; then ready=true; break; fi
	kill -0 "$SERVER_PID" 2>/dev/null || break
	sleep 1
done
if [[ "$ready" != true ]]; then
	echo "V34 replay preflight inference server did not become ready" >&2
	exit 1
fi

common_args=(
	scripts/evaluate-solo-checkpoint.mjs
	--weights "$POLICY_REL" --catalog "$CATALOG_REL" --source-commit "$IMPLEMENTATION_COMMIT"
	--infer-socket "$SOCKET" --policy-obs-version 2 --games "$GAMES" --seed0 "$SEED0"
	--max-rounds 30 --max-status-level 2 --sample --temperature 0.55 --include-games
)
env ARC_INFER_WIRE=binary TMPDIR="$SCRATCH" nice -n 19 node "${common_args[@]}" \
	--workers 24 --out "$SCRATCH/workers-24.json" > "$SCRATCH/workers-24.stdout" 2> "$SCRATCH/workers-24.stderr"
env ARC_INFER_WIRE=binary TMPDIR="$SCRATCH" nice -n 19 node "${common_args[@]}" \
	--workers 8 --out "$SCRATCH/workers-8.json" > "$SCRATCH/workers-8.stdout" 2> "$SCRATCH/workers-8.stderr"

kill -TERM "$SERVER_PID"
wait "$SERVER_PID"
SERVER_PID=""

node --input-type=module - "$SCRATCH/workers-24.json" "$SCRATCH/workers-8.json" \
	"$SCRATCH/infer.log" "$OUT" "$IMPLEMENTATION_COMMIT" "$GPU" <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const [primaryPath, replayPath, inferLogPath, out, implementationCommit, gpuText] = process.argv.slice(2);
const primary = JSON.parse(readFileSync(primaryPath, 'utf8'));
const replay = JSON.parse(readFileSync(replayPath, 'utf8'));
const inferLog = readFileSync(inferLogPath, 'utf8');
const assert = (ok, message) => { if (!ok) throw new Error(message); };
assert(primary.schemaVersion === 'solo-heldout-v2' && replay.schemaVersion === primary.schemaVersion,
	'replay preflight report schema mismatch');
assert(primary.seed0 === replay.seed0 && primary.games === 64 && replay.games === 64,
	'replay preflight seed contract mismatch');
assert(primary.stalls === 0 && replay.stalls === 0, 'replay preflight encountered a stall');
assert(JSON.stringify(primary.inference) === JSON.stringify(replay.inference),
	'replay preflight inference provenance mismatch');
const primaryBySeed = new Map(primary.perGame.map((row) => [row.seed, row]));
const replayBySeed = new Map(replay.perGame.map((row) => [row.seed, row]));
assert(primaryBySeed.size === 64 && replayBySeed.size === 64,
	'replay preflight seed coverage mismatch');
const mismatches = [];
for (const [seed, row] of primaryBySeed) {
	if (JSON.stringify(row) !== JSON.stringify(replayBySeed.get(seed))) mismatches.push(seed);
}
const servingLines = inferLog.split(/\r?\n/).filter((line) => line.startsWith('[infer] serving ')).length;
const shutdownLines = inferLog.split(/\r?\n/).filter((line) => line === '[infer] shut down').length;
const reloadLines = inferLog.split(/\r?\n/).filter((line) => /\[infer\] reloaded weights/.test(line)).length;
const errorLines = inferLog.split(/\r?\n/).filter((line) =>
	/(Traceback|reload FAILED|RuntimeError|Exception|CUDA error:|\bError:)/.test(line)).length;
assert(mismatches.length === 0, `replay preflight mismatched seeds: ${mismatches.join(',')}`);
assert(servingLines === 1 && shutdownLines === 1 && reloadLines === 0 && errorLines === 0,
	'replay preflight inference lifecycle mismatch');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const result = {
	schemaVersion: 'arc-v34-replay-determinism-preflight-v1',
	passed: true,
	implementationCommit,
	gpu: Number(gpuText),
	seed0: primary.seed0,
	games: 64,
	primaryWorkers: primary.performance.workers,
	replayWorkers: replay.performance.workers,
	sameInferenceProcess: true,
	comparedBySeed: true,
	mismatches: 0,
	checkpointSha256: primary.weightsSha256,
	catalogSha256: primary.catalogSha256,
	inference: primary.inference,
	lifecycle: { servingLines, shutdownLines, reloadLines, errorLines },
	inputs: {
		primaryReportSha256: sha256(primaryPath),
		replayReportSha256: sha256(replayPath),
		inferLogSha256: sha256(inferLogPath)
	}
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify(result));
NODE

trap - EXIT INT TERM
rm -rf "$SCRATCH"

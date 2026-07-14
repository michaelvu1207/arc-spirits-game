#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPERIMENT="$ROOT/ml/experiments/v34-latency-first-expert-iteration"
OUT_DIR="${1:-$EXPERIMENT/artifacts/strength-preflight}"
IMPLEMENTATION_COMMIT="${2:-}"
if [[ ! "$IMPLEMENTATION_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
	echo "usage: run-v34-strength-preflight.sh [OUT_DIR] EXACT_40_CHARACTER_IMPLEMENTATION_COMMIT" >&2
	exit 2
fi
cd "$ROOT"
test ! -e "$OUT_DIR/result.json"
mkdir -p "$OUT_DIR"

source_code=0
node scripts/verify-v34-source-lock.mjs > "$OUT_DIR/source-lock.log" 2>&1 || source_code=$?
evidence_code=0
node scripts/verify-v34-strength-chain.mjs evidence > "$OUT_DIR/evidence-chain.log" 2>&1 || evidence_code=$?
protocol_code=0
node scripts/validate-v34-strength-protocol.mjs > "$OUT_DIR/strength-protocol.log" 2>&1 || protocol_code=$?
python_code=0
PYTHONPATH=ml ml/v34_stats_env/.venv/bin/python -m unittest ml.test_analyze_v34_phase2 \
	> "$OUT_DIR/python-fixtures.log" 2>&1 || python_code=$?
recorder_code=0
node scripts/test-v34-phase2-condition.mjs \
	> "$OUT_DIR/recorder-fixtures.log" 2>&1 || recorder_code=$?
replay_code=0
bash scripts/check-v34-replay-determinism.sh "$OUT_DIR/replay-determinism-audit.json" \
	"$IMPLEMENTATION_COMMIT" "${ARC_V34_PREFLIGHT_GPU:-5}" \
	> "$OUT_DIR/replay-determinism.log" 2>&1 || replay_code=$?
vitest_code=0
npm test -- --run \
	src/lib/play/ml/actions.informationSafety.test.ts \
	src/lib/play/ml/_gumbelPlanner.test.ts \
	src/lib/play/ml/_heuristicRolloutPlanner.test.ts \
	src/lib/play/ml/_actorpool.test.ts \
	src/lib/play/ml/inferenceClient.test.ts \
	src/lib/play/ml/driver.ppo.test.ts > "$OUT_DIR/vitest.log" 2>&1 || vitest_code=$?
typecheck_code=0
npm run check > "$OUT_DIR/typecheck.log" 2>&1 || typecheck_code=$?
node_code=0
node --check \
	scripts/v34-strength-tooling-files.mjs \
	scripts/validate-v34-strength-protocol.mjs \
	scripts/verify-v34-strength-chain.mjs \
	scripts/lock-v34-strength-inputs.mjs \
	scripts/record-v34-strength-preflight.mjs \
	scripts/record-v34-phase2-condition.mjs \
	scripts/test-v34-phase2-condition.mjs > "$OUT_DIR/node-syntax.log" 2>&1 || node_code=$?
shell_code=0
bash -n scripts/run-v34-strength-preflight.sh scripts/run-v34-phase2-screen.sh \
	scripts/check-v34-replay-determinism.sh \
	> "$OUT_DIR/shell-syntax.log" 2>&1 || shell_code=$?
determinization_code=0
node scripts/check-v34-determinization.mjs --samples 100000 --seed0 956400000 \
	--out "$OUT_DIR/determinization-audit.json" \
	> "$OUT_DIR/determinization.log" 2>&1 || determinization_code=$?
resources_code=0
node --input-type=module - "$OUT_DIR/resources.log" <<'NODE' || resources_code=$?
import { execFileSync } from 'node:child_process';
import { statfsSync, writeFileSync } from 'node:fs';
const out = process.argv[2];
const strength = JSON.parse(await (await import('node:fs/promises')).readFile(
	'ml/experiments/v34-latency-first-expert-iteration/strength-protocol.json', 'utf8'));
const systems = JSON.parse(await (await import('node:fs/promises')).readFile(
	'ml/experiments/v34-latency-first-expert-iteration/artifacts/systems-eligibility.json', 'utf8'));
const freeBytes = (target) => {
	const value = statfsSync(target, { bigint: true });
	return Number(value.bavail * value.bsize);
};
const scratchFreeBytes = freeBytes('/dev/shm');
const persistentFreeBytes = freeBytes('ml/experiments/v34-latency-first-expert-iteration/artifacts');
const persistentRequiredBytes = (1 + systems.eligibleCandidateArms.length) * 1024 ** 3;
let freeEligibleGpus = [];
let gpuProbeError = null;
try {
	const gpuRows = execFileSync('nvidia-smi', [
		'--query-gpu=index,uuid', '--format=csv,noheader,nounits'
	], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
	const occupied = new Set(execFileSync('nvidia-smi', [
		'--query-compute-apps=gpu_uuid', '--format=csv,noheader,nounits'
	], { encoding: 'utf8' }).trim().split('\n').map((value) => value.trim()).filter(Boolean));
	freeEligibleGpus = gpuRows.map((row) => row.split(',').map((value) => value.trim()))
		.filter(([index, uuid]) => strength.runtime.eligibleGpus.includes(Number(index)) && !occupied.has(uuid))
		.map(([index]) => Number(index));
} catch (error) {
	gpuProbeError = String(error?.message ?? error);
}
const passed = scratchFreeBytes >= strength.runtime.minimumScratchFreeBytes &&
	persistentFreeBytes >= persistentRequiredBytes && freeEligibleGpus.length > 0 &&
	!freeEligibleGpus.includes(strength.runtime.excludedGpu);
const result = {
	schemaVersion: 'arc-v34-strength-resource-preflight-v1',
	scratchFreeBytes,
	scratchRequiredBytes: strength.runtime.minimumScratchFreeBytes,
	persistentFreeBytes,
	persistentRequiredBytes,
	eligibleGpus: strength.runtime.eligibleGpus,
	excludedGpu: strength.runtime.excludedGpu,
	freeEligibleGpus,
	gpuProbeError,
	passed
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
if (!passed) process.exitCode = 1;
NODE

node scripts/record-v34-strength-preflight.mjs "$OUT_DIR/result.json" "$IMPLEMENTATION_COMMIT" \
	"$OUT_DIR/source-lock.log" "$OUT_DIR/evidence-chain.log" \
	"$OUT_DIR/strength-protocol.log" "$OUT_DIR/python-fixtures.log" \
	"$OUT_DIR/recorder-fixtures.log" "$OUT_DIR/replay-determinism.log" \
	"$OUT_DIR/vitest.log" "$OUT_DIR/typecheck.log" "$OUT_DIR/node-syntax.log" \
	"$OUT_DIR/shell-syntax.log" "$OUT_DIR/determinization.log" "$OUT_DIR/resources.log" \
	"$source_code" "$evidence_code" "$protocol_code" "$python_code" "$recorder_code" "$replay_code" "$vitest_code" \
	"$typecheck_code" "$node_code" "$shell_code" "$determinization_code" "$resources_code"
chmod 0444 "$OUT_DIR"/*.log "$OUT_DIR/determinization-audit.json" \
	"$OUT_DIR/replay-determinism-audit.json" "$OUT_DIR/result.json"

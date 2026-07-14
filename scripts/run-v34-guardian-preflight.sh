#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPERIMENT="$ROOT/ml/experiments/v34-latency-first-expert-iteration"
OUT_DIR="${1:-$EXPERIMENT/artifacts/guardian/preflight}"
IMPLEMENTATION_COMMIT="${2:-}"
if [[ ! "$IMPLEMENTATION_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
	echo "usage: run-v34-guardian-preflight.sh [OUT_DIR] EXACT_40_CHARACTER_IMPLEMENTATION_COMMIT" >&2
	exit 2
fi
cd "$ROOT"
test ! -e "$OUT_DIR"
test ! -e "$EXPERIMENT/artifacts/phase2-analysis.json"
test ! -e "$EXPERIMENT/artifacts/guardian/authorization.json"
test ! -e "$EXPERIMENT/artifacts/guardian/execution-lock.json"
mkdir -p "$OUT_DIR"

protocol_code=0
node scripts/validate-v34-guardian-protocol.mjs > "$OUT_DIR/protocol.log" 2>&1 || protocol_code=$?
strength_code=0
node scripts/verify-v34-strength-chain.mjs phase2 > "$OUT_DIR/strength-chain.log" 2>&1 || strength_code=$?
python_code=0
PYTHONPATH=ml ml/v34_stats_env/.venv/bin/python -m unittest ml.test_analyze_v34_guardian \
	> "$OUT_DIR/python-fixtures.log" 2>&1 || python_code=$?
recorder_code=0
node scripts/test-v34-guardian-condition.mjs \
	> "$OUT_DIR/recorder-fixtures.log" 2>&1 || recorder_code=$?
assignment_code=0
node --input-type=module - > "$OUT_DIR/assignment.log" 2>&1 <<'NODE' || assignment_code=$?
import { createJiti } from 'jiti';
import { readFileSync } from 'node:fs';
const protocol = JSON.parse(readFileSync(
	'ml/experiments/v34-latency-first-expert-iteration/guardian-execution-protocol.json', 'utf8'));
const jiti = createJiti(import.meta.url);
const { guardianIndexForSeed } = await jiti.import('./src/lib/play/ml/evalSchedule.ts');
const { seed0, seedMax, games, guardians, assignment } = protocol.guardian;
const counts = Array(guardians.length).fill(0);
let mismatches = 0;
for (let seed = seed0; seed <= seedMax; seed += 1) {
	const actual = guardianIndexForSeed(seed, guardians.length);
	if (actual !== seed % guardians.length) mismatches += 1;
	counts[actual] += 1;
}
const passed = seedMax - seed0 + 1 === games && mismatches === 0 &&
	JSON.stringify(counts) === JSON.stringify(assignment.expectedCountsInGuardianOrder);
const result = {
	schemaVersion: 'arc-v34-guardian-assignment-preflight-v1',
	seed0, seedMax, games,
	algorithm: assignment.algorithm,
	countsInGuardianOrder: counts,
	expectedCountsInGuardianOrder: assignment.expectedCountsInGuardianOrder,
	mismatches,
	passed
};
console.log(JSON.stringify(result));
if (!passed) process.exitCode = 1;
NODE
replay_code=0
bash scripts/check-v34-replay-determinism.sh "$OUT_DIR/replay-determinism-audit.json" \
	"$IMPLEMENTATION_COMMIT" "${ARC_V34_PREFLIGHT_GPU:-5}" \
	> "$OUT_DIR/replay-determinism.log" 2>&1 || replay_code=$?
vitest_code=0
npm test -- --run \
	src/lib/play/ml/actions.informationSafety.test.ts \
	src/lib/play/ml/evalSchedule.test.ts \
	src/lib/play/ml/_gumbelPlanner.test.ts \
	src/lib/play/ml/_heuristicRolloutPlanner.test.ts \
	src/lib/play/ml/_actorpool.test.ts \
	src/lib/play/ml/inferenceClient.test.ts \
	src/lib/play/ml/driver.ppo.test.ts > "$OUT_DIR/vitest.log" 2>&1 || vitest_code=$?
typecheck_code=0
npm run check > "$OUT_DIR/typecheck.log" 2>&1 || typecheck_code=$?
node_code=0
while IFS= read -r file; do
	[[ "$file" == *.mjs ]] || continue
	node --check "$file"
done < <(node --input-type=module -e \
	"import {V34_GUARDIAN_TOOLING_FILES as f} from './scripts/v34-guardian-tooling-files.mjs'; console.log(f.join('\\n'))") \
	> "$OUT_DIR/node-syntax.log" 2>&1 || node_code=$?
shell_code=0
bash -n scripts/run-v34-guardian-preflight.sh scripts/run-v34-guardian-confirmation.sh \
	scripts/check-v34-replay-determinism.sh \
	> "$OUT_DIR/shell-syntax.log" 2>&1 || shell_code=$?
resources_code=0
node --input-type=module - > "$OUT_DIR/resources.log" 2>&1 <<'NODE' || resources_code=$?
import { execFileSync } from 'node:child_process';
import { readFileSync, statfsSync } from 'node:fs';
const protocol = JSON.parse(readFileSync(
	'ml/experiments/v34-latency-first-expert-iteration/guardian-execution-protocol.json', 'utf8'));
const freeBytes = (target) => {
	const value = statfsSync(target, { bigint: true });
	return Number(value.bavail * value.bsize);
};
const scratchFreeBytes = freeBytes('/dev/shm');
const persistentFreeBytes = freeBytes('ml/experiments/v34-latency-first-expert-iteration/artifacts');
const minimumPersistentRequiredBytes = protocol.runtime.minimumPersistentFreeBytes +
	protocol.runtime.persistentBytesPerRemainingCondition;
const worstCasePersistentRequiredBytes = protocol.runtime.minimumPersistentFreeBytes +
	(1 + protocol.guardian.registeredCandidateSlots.length) *
	protocol.runtime.persistentBytesPerRemainingCondition;
const memoryText = readFileSync('/proc/meminfo', 'utf8');
const memoryMatch = memoryText.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
const memoryAvailableBytes = memoryMatch ? Number(memoryMatch[1]) * 1024 : 0;
let gpuProbeError = null;
let freeEligibleGpus = [];
try {
	const gpuRows = execFileSync('nvidia-smi', [
		'--query-gpu=index,uuid', '--format=csv,noheader,nounits'
	], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
	const occupied = new Set(execFileSync('nvidia-smi', [
		'--query-compute-apps=gpu_uuid', '--format=csv,noheader,nounits'
	], { encoding: 'utf8' }).trim().split('\n').map((value) => value.trim()).filter(Boolean));
	freeEligibleGpus = gpuRows.map((row) => row.split(',').map((value) => value.trim()))
		.filter(([index, uuid]) => protocol.runtime.eligibleGpus.includes(Number(index)) &&
			Number(index) !== protocol.runtime.excludedGpu && !occupied.has(uuid))
		.map(([index]) => Number(index));
} catch (error) {
	gpuProbeError = String(error?.message ?? error);
}
const passed = scratchFreeBytes >= protocol.runtime.minimumScratchFreeBytes &&
	persistentFreeBytes >= minimumPersistentRequiredBytes &&
	memoryAvailableBytes >= protocol.runtime.minimumAvailableMemoryBytes &&
	freeEligibleGpus.length > 0 && gpuProbeError === null;
const result = {
	schemaVersion: 'arc-v34-guardian-resource-preflight-v1',
	scratchFreeBytes,
	scratchRequiredBytes: protocol.runtime.minimumScratchFreeBytes,
	persistentFreeBytes,
	minimumPersistentRequiredBytes,
	worstCasePersistentRequiredBytes,
	worstCasePersistentPassed: persistentFreeBytes >= worstCasePersistentRequiredBytes,
	memoryAvailableBytes,
	memoryRequiredBytes: protocol.runtime.minimumAvailableMemoryBytes,
	eligibleGpus: protocol.runtime.eligibleGpus,
	excludedGpu: protocol.runtime.excludedGpu,
	freeEligibleGpus,
	gpuProbeError,
	passed
};
console.log(JSON.stringify(result));
if (!passed) process.exitCode = 1;
NODE

node scripts/record-v34-guardian-preflight.mjs "$OUT_DIR/result.json" "$IMPLEMENTATION_COMMIT" \
	"$OUT_DIR/protocol.log" "$OUT_DIR/strength-chain.log" "$OUT_DIR/python-fixtures.log" \
	"$OUT_DIR/recorder-fixtures.log" "$OUT_DIR/assignment.log" \
	"$OUT_DIR/replay-determinism.log" "$OUT_DIR/vitest.log" "$OUT_DIR/typecheck.log" \
	"$OUT_DIR/node-syntax.log" "$OUT_DIR/shell-syntax.log" "$OUT_DIR/resources.log" \
	"$protocol_code" "$strength_code" "$python_code" "$recorder_code" "$assignment_code" \
	"$replay_code" "$vitest_code" "$typecheck_code" "$node_code" "$shell_code" "$resources_code"
chmod 0444 "$OUT_DIR"/*.log "$OUT_DIR/replay-determinism-audit.json" "$OUT_DIR/result.json"

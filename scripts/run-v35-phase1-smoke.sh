#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPERIMENT="$ROOT/ml/experiments/v35-weco-recursive-autoresearch"
LOCK="$EXPERIMENT/artifacts/phase1-source-lock-amendment2.json"
OUT="$EXPERIMENT/artifacts/phase1-replicate-a-smoke.json"

cd "$ROOT"
node scripts/lock-v35-phase1.mjs verify "$LOCK"
test "$(node -e 'const x=require(process.argv[1]);process.stdout.write(String(x.valid))' \
  "$EXPERIMENT/artifacts/phase1-seed-inventory.json")" = "true"
test ! -e "$OUT"

for arm in control-uniform late-reweighted p30-credit025; do
  league="$EXPERIMENT/league/rep-a/$arm"
  mkdir -p "$league/artifacts"
  "$ROOT/scripts/run-v35-root.sh" "$league" 1 \
    > "$league/artifacts/smoke-orchestrator.log" 2>&1
done

node - "$EXPERIMENT" "$OUT" <<'NODE'
const fs = require('fs');
const path = require('path');
const [experiment, out] = process.argv.slice(2);
const arms = ['control-uniform', 'late-reweighted', 'p30-credit025'];
const audits = arms.map((arm) => {
  const file = path.join(experiment, 'league', 'rep-a', arm, 'artifacts', 'gen1-audit.json');
  const audit = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (audit.valid !== true || audit.generation !== 1 || audit.replicate !== 'a' || audit.arm !== arm) {
    throw new Error(`invalid smoke audit ${file}`);
  }
  return {
    arm,
    audit: path.relative(process.cwd(), file),
    checkpointSha256: audit.checkpointSha256,
    behaviorLogpMaxAbsError: audit.behaviorLogpMaxAbsError,
    behaviorReach30Calibration: audit.behaviorReach30Calibration,
    epochMetrics: audit.epochMetrics,
    rawGenerationCommitment: audit.rawGenerationCommitment,
  };
});
fs.writeFileSync(out, JSON.stringify({
  schemaVersion: 'arc-v35-phase1-smoke-v1',
  valid: true,
  replicate: 'a',
  generation: 1,
  promotionEligible: false,
  audits,
}, null, 2) + '\n');
console.log(out);
NODE

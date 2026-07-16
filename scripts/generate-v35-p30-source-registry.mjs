#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repo);

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
	.split('\n')
	.filter(Boolean);
const explicitlyNew = [
	'ml/audit_v35_p30_generation.py',
	'ml/calibrate_v35_p30_power.py',
	'ml/freeze_v35_p30_source.py',
	'ml/issue_v35_p30_analysis_bundle.py',
	'ml/issue_v35_p30_evaluation_authorization.py',
	'ml/issue_v35_p30_generation_authorization.py',
	'ml/issue_v35_p30_pair_integrity.py',
	'ml/experiments/v35-weco-recursive-autoresearch/p30-long-horizon/plan.md',
	'ml/experiments/v35-weco-recursive-autoresearch/p30-long-horizon/runtime/usr.bin.bwrap.apparmor',
	'ml/run_v35_p30_evaluation_attempt.py',
	'ml/run_v35_p30_local_custody.py',
	'ml/run_v35_p30_role.py',
	'ml/sign_v35_p30_launch_permit_local.py',
	'ml/run_v35_p30_analyzer_rehearsal.py',
	'ml/run_v35_p30_analysis_review_local.py',
	'ml/run_v35_p30_campaign.py',
	'ml/test_audit_v35_p30_generation.py',
	'ml/test_v35_p30_analysis_launch_capability.py',
	'ml/test_v35_p30_analysis_manifest.py',
	'ml/test_v35_p30_authorized_execution.py',
	'ml/test_v35_p30_crypto.py',
	'ml/test_v35_p30_durable_nonexecutor_signing.py',
	'ml/test_v35_p30_evaluation_attempt.py',
	'ml/test_v35_p30_key_custody.py',
	'ml/test_v35_p30_launch_permit.py',
	'ml/test_v35_p30_analysis_review_local.py',
	'ml/test_v35_p30_pre_child_recovery.py',
	'ml/test_v35_p30_recovery.py',
	'ml/test_v35_p30_recovery_scheduler.py',
	'ml/test_v35_p30_two_stage_custody.py',
	'ml/v35_p30_analysis_review.py',
	'ml/v35_p30_authorized_execution.py',
	'ml/v35_p30_crypto.py',
	'ml/v35_p30_key_custody.py',
	'ml/v35_p30_recovery.py',
	'ml/v35_p30_statistics.py',
	'scripts/generate-v35-p30-source-registry.mjs',
	'scripts/install-v35-p30-bwrap-profile.sh',
	'scripts/run-v35-p30-root.sh'
];
const selected = new Set([
	'package.json',
	'package-lock.json',
	'tsconfig.json',
	'ml/experiments/v35-weco-recursive-autoresearch/artifacts/phase1-development-analysis.json',
	'ml/experiments/v35-weco-recursive-autoresearch/artifacts/phase1-development-reports.json',
	'ml/experiments/v35-weco-recursive-autoresearch/p30-long-horizon/confirmation-gates.proposed.json',
	'ml/catalog.json',
	'ml/requirements.txt',
	'ml/league/configs/fair-v35-late-credit-base.json',
	'server/protocol.ts',
	...explicitlyNew
]);
for (const replicate of ['a', 'b', 'c']) {
	for (const arm of ['control-uniform', 'p30-credit025', 'late-reweighted']) {
		selected.add(
			`ml/experiments/v35-weco-recursive-autoresearch/development/rep-${replicate}-${arm}/attempt-1/report.json`
		);
	}
}
for (const file of tracked) {
	if (
		/^ml\/[^/]+\.py$/.test(file) ||
		file.startsWith('scripts/') ||
		file.startsWith('src/lib/play/')
	) {
		selected.add(file);
	}
}
const files = [...selected].sort();
for (const file of files) {
	if (!existsSync(file) || !statSync(file).isFile()) {
		throw new Error(`P30 source registry input is missing or not a file: ${file}`);
	}
}
const output =
	'ml/experiments/v35-weco-recursive-autoresearch/p30-long-horizon/source-registry.proposed.json';
writeFileSync(
	output,
	JSON.stringify(
		{
			schemaVersion: 'arc-v35-p30-source-registry-v1',
			purpose: 'complete-runtime-and-evaluation-source-closure',
			promotionEligible: false,
			files
		},
		null,
		2
	) + '\n'
);
console.log(`${output} files=${files.length}`);

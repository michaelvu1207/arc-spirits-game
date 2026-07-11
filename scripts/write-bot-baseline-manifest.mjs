#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

function argValue(name, fallback = '') {
	const prefix = `${name}=`;
	const eq = process.argv.find((arg) => arg.startsWith(prefix));
	if (eq) return eq.slice(prefix.length);
	const i = process.argv.indexOf(name);
	return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function argValues(name) {
	const prefix = `${name}=`;
	const out = [];
	for (let i = 2; i < process.argv.length; i++) {
		const arg = process.argv[i];
		if (arg.startsWith(prefix)) out.push(arg.slice(prefix.length));
		else if (arg === name && i + 1 < process.argv.length) out.push(process.argv[++i]);
	}
	return out;
}

function runGit(args) {
	try {
		return execFileSync('git', args, { encoding: 'utf8' }).trim();
	} catch {
		return null;
	}
}

function sha256(file) {
	if (!file || !existsSync(file)) return null;
	return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function readJson(file) {
	if (!file || !existsSync(file)) return null;
	return JSON.parse(readFileSync(file, 'utf8'));
}

function fileInfo(path) {
	if (!path || !existsSync(path)) return { path, exists: false };
	const stat = statSync(path);
	return {
		path,
		exists: true,
		bytes: stat.size,
		sha256: sha256(path),
		mtime: stat.mtime.toISOString()
	};
}

function contractVersion() {
	const file = resolve('src/lib/play/bots/contract.ts');
	if (!existsSync(file)) return null;
	const match = readFileSync(file, 'utf8').match(/BOT_CONTRACT_VERSION\s*=\s*['"]([^'"]+)['"]/);
	return match?.[1] ?? null;
}

function checkpointRecord(spec) {
	const [name, rawPath] = spec.includes('=') ? spec.split(/=(.*)/s, 2) : ['', spec];
	const path = resolve(rawPath);
	const json = readJson(path);
	return {
		name: name || rawPath,
		...fileInfo(path),
		...(json
			? {
					format: json.format ?? null,
					obs_dim: json.obs_dim ?? null,
					act_dim: json.act_dim ?? null,
					params: json.params ?? null,
					aux_heads: Object.keys(json.aux_heads ?? {})
				}
			: {})
	};
}

const runId = argValue('--run-id', process.env.RUN_ID ?? '');
const label = argValue('--label', runId || 'bot-baseline');
const weightsPath = argValue('--weights', process.env.WEIGHTS ?? '');
const evalSummaryPath = argValue('--eval-summary', '');
const outPath = argValue(
	'--out',
	runId ? `ml/meta_runs/${runId}/baseline-manifest.json` : 'ml/meta_runs/baseline-manifest.json'
);
const catalogPath = argValue('--catalog', 'ml/catalog.json');
const notes = argValue('--notes', '');
const packageJson = readJson(resolve('package.json')) ?? {};
const weights = readJson(resolve(weightsPath));
const liveWeights = readJson(resolve('src/lib/play/ml/policy-weights.json'));
const evalSummary = readJson(resolve(evalSummaryPath));
const statusShort = runGit(['status', '--short']) ?? '';

const manifest = {
	label,
	run_id: runId || null,
	generated_at: new Date().toISOString(),
	notes: notes || null,
	reproducibility: {
		source_commit: runGit(['rev-parse', 'HEAD']),
		source_branch: runGit(['rev-parse', '--abbrev-ref', 'HEAD']),
		source_dirty: statusShort.length > 0,
		source_status_short: statusShort.split('\n').filter(Boolean)
	},
	project: {
		name: packageJson.name ?? null,
		version: packageJson.version ?? null,
		contract_version: contractVersion()
	},
	catalog: fileInfo(resolve(catalogPath)),
	weights: {
		...fileInfo(resolve(weightsPath)),
		format: weights?.format ?? null,
		obs_dim: weights?.obs_dim ?? null,
		act_dim: weights?.act_dim ?? null,
		params: weights?.params ?? null,
		aux_heads: Object.keys(weights?.aux_heads ?? {})
	},
	eval_summary: {
		...fileInfo(resolve(evalSummaryPath)),
		summary: evalSummary
	},
	checkpoints: argValues('--checkpoint').map(checkpointRecord),
	gates: {
		current_dims: liveWeights
			? { obs_dim: liveWeights.obs_dim, act_dim: liveWeights.act_dim }
			: null,
		dims_match_live_contract:
			weights && liveWeights
				? weights.obs_dim === liveWeights.obs_dim && weights.act_dim === liveWeights.act_dim
				: false,
		full_control: evalSummary ? evalSummary.control === 'full' : null,
		verdict: evalSummary?.verdict ?? null
	}
};

mkdirSync(dirname(resolve(outPath)), { recursive: true });
writeFileSync(resolve(outPath), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(resolve(outPath));

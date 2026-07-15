#!/usr/bin/env node
/**
 * Outcome-blind V34 B1 strategic-snapshot collector.
 *
 * The collector owns the complete solo reducer loop and exact command/deadline trace.  Policy
 * inference is deliberately injected: the provider receives encoded observations, public legal
 * commands, and candidate features, never the authoritative state or future target shard.  This
 * file does not guess how to load a checkpoint.  CLI execution therefore fails closed unless an
 * explicit --policy-module implements the interface documented by validatePolicyProvider().
 */
import { createHash } from 'node:crypto';
import {
	closeSync,
	createReadStream,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeSync
} from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createJiti } from 'jiti';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const jiti = createJiti(import.meta.url, { alias: { $lib: path.join(ROOT, 'src', 'lib') } });

const runtime = await jiti.import(path.join(ROOT, 'src', 'lib', 'play', 'runtime.ts'));
const types = await jiti.import(path.join(ROOT, 'src', 'lib', 'play', 'types.ts'));
const actionsModule = await jiti.import(path.join(ROOT, 'src', 'lib', 'play', 'ml', 'actions.ts'));
const encodeModule = await jiti.import(path.join(ROOT, 'src', 'lib', 'play', 'ml', 'encode.ts'));
const encodeV2Module = await jiti.import(
	path.join(ROOT, 'src', 'lib', 'play', 'ml', 'encodeV2.ts')
);
const neuralBotModule = await jiti.import(
	path.join(ROOT, 'src', 'lib', 'play', 'ml', 'neuralBot.ts')
);
const evalScheduleModule = await jiti.import(
	path.join(ROOT, 'src', 'lib', 'play', 'ml', 'evalSchedule.ts')
);
const botPolicyModule = await jiti.import(
	path.join(ROOT, 'src', 'lib', 'play', 'server', 'botPolicy.ts')
);
const snapshotModule = await jiti.import(
	path.join(ROOT, 'src', 'lib', 'play', 'ml', 'expertIteration', 'snapshot.ts')
);

const { applyDeadlineAdvance, applyGameCommand, createLobbyState } = runtime;
const { SEAT_COLORS, VP_TO_WIN } = types;
const { legalActionsWithNext, policyPreviewState } = actionsModule;
const { encodeAction, encodeObs } = encodeModule;
const { encodeEntityObsV2, flattenObsV2 } = encodeV2Module;
const { selectableCandidateIndices } = neuralBotModule;
const { guardianIndexForSeed } = evalScheduleModule;
const { botActorFor, botSeatNeedsToAct } = botPolicyModule;
const {
	assertFeatureShardSafe,
	botSamplingSeed,
	buildOutcomeBlindSnapshot,
	canonicalJson,
	closeDeterministicSingletons,
	commandTraceEvent,
	deadlineTraceEvent,
	replaySnapshotTrace,
	sha256Canonical
} = snapshotModule;

export const COLLECTION_SCHEMA = 'arc-v34-teacher-snapshot-collection-v1';
export const FEATURE_SCHEMA = 'arc-v34-teacher-snapshot-feature-v1';
export const TARGET_SCHEMA = 'arc-v34-teacher-snapshot-target-v1';
export const TRACE_MANIFEST_SCHEMA = 'arc-v34-teacher-snapshot-trace-manifest-v1';
export const POLICY_CONFIG_SCHEMA = 'arc-v34-bound-raw-policy-v1';
export const POLICY_BINDING_SCHEMA = 'arc-v34-policy-provider-binding-v1';

const REQUIRED_CONFIG_KEYS = new Set([
	'schemaVersion',
	'policyObservationVersion',
	'actionSelector',
	'decisionSelection',
	'temperature',
	'progressFilter',
	'optionHead',
	'guardianSchedule',
	'maxStatusLevel',
	'maxRounds',
	'forcedClosureMaxSteps',
	'maxTicks',
	'samplingStream',
	'weakEngineThreshold'
]);
const SHA256_RE = /^[0-9a-f]{64}$/;

function requireCondition(condition, message) {
	if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
	requireCondition(
		value && typeof value === 'object' && !Array.isArray(value),
		`${label} must be an object`
	);
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	requireCondition(
		canonicalJson(actual) === canonicalJson(wanted),
		`${label} keys must be exactly ${wanted.join(', ')}; got ${actual.join(', ')}`
	);
}

function safeInteger(value, label, minimum = 0) {
	requireCondition(
		Number.isSafeInteger(value) && value >= minimum,
		`${label} must be a safe integer >= ${minimum}`
	);
	return value;
}

function finiteNumber(value, label, minimum = -Infinity, maximum = Infinity) {
	requireCondition(
		Number.isFinite(value) && value >= minimum && value <= maximum,
		`${label} must be finite in [${minimum}, ${maximum}]`
	);
	return value;
}

function sha256Bytes(payload) {
	return createHash('sha256').update(payload).digest('hex');
}

function sha256File(file) {
	return sha256Bytes(readFileSync(file));
}

function fileRecord(file, relativeTo = undefined) {
	const resolved = path.resolve(file);
	const stat = lstatSync(resolved);
	requireCondition(stat.isFile() && !stat.isSymbolicLink(), `expected a regular file: ${resolved}`);
	return {
		path: relativeTo ? path.relative(relativeTo, resolved).replaceAll(path.sep, '/') : resolved,
		bytes: stat.size,
		sha256: sha256File(resolved)
	};
}

function canonicalLine(value) {
	return `${canonicalJson(value)}\n`;
}

function pathEntryExists(file) {
	try {
		lstatSync(file);
		return true;
	} catch (error) {
		if (error?.code === 'ENOENT') return false;
		throw error;
	}
}

function atomicWriteNew(file, payload) {
	requireCondition(!pathEntryExists(file), `refusing to overwrite ${file}`);
	mkdirSync(path.dirname(file), { recursive: true });
	const temporary = path.join(
		path.dirname(file),
		`.${path.basename(file)}.tmp-${process.pid}-${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 12)}`
	);
	const fd = openSync(temporary, 'wx', 0o644);
	try {
		writeSync(fd, payload);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		// Hard-link publication is atomic and fails if any file or dangling symlink won the path.
		linkSync(temporary, file);
	} finally {
		unlinkSync(temporary);
	}
}

function artifactPayload(rows) {
	return rows.map(canonicalLine).join('');
}

function codeUnitCompare(left, right) {
	return left === right ? 0 : left < right ? -1 : 1;
}

function writeAll(fd, payload) {
	const bytes = Buffer.from(payload);
	let offset = 0;
	while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

function heapPush(heap, value, compare) {
	heap.push(value);
	let index = heap.length - 1;
	while (index > 0) {
		const parent = Math.floor((index - 1) / 2);
		if (compare(heap[parent].row, heap[index].row) <= 0) break;
		[heap[parent], heap[index]] = [heap[index], heap[parent]];
		index = parent;
	}
}

function heapPop(heap, compare) {
	const first = heap[0];
	const last = heap.pop();
	if (heap.length > 0) {
		heap[0] = last;
		let index = 0;
		while (true) {
			const left = index * 2 + 1;
			const right = left + 1;
			let smallest = index;
			if (left < heap.length && compare(heap[left].row, heap[smallest].row) < 0) {
				smallest = left;
			}
			if (right < heap.length && compare(heap[right].row, heap[smallest].row) < 0) {
				smallest = right;
			}
			if (smallest === index) break;
			[heap[index], heap[smallest]] = [heap[smallest], heap[index]];
			index = smallest;
		}
	}
	return first;
}

async function mergeSortedJsonlRuns(inputFiles, outputFile, compare, label) {
	requireCondition(inputFiles.length > 0, `${label} merge requires at least one input run`);
	requireCondition(!pathEntryExists(outputFile), `refusing to overwrite ${outputFile}`);
	mkdirSync(path.dirname(outputFile), { recursive: true });
	const temporary = path.join(
		path.dirname(outputFile),
		`.${path.basename(outputFile)}.tmp-${process.pid}-${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 12)}`
	);
	const fd = openSync(temporary, 'wx', 0o644);
	const sources = [];
	let closed = false;
	let rows = 0;
	let previous = null;
	try {
		const heap = [];
		for (const [sourceIndex, file] of inputFiles.entries()) {
			const input = createReadStream(file, { encoding: 'utf8' });
			const lines = createInterface({ input, crlfDelay: Infinity });
			const iterator = lines[Symbol.asyncIterator]();
			const source = { sourceIndex, file, input, lines, iterator };
			sources.push(source);
			const first = await iterator.next();
			if (!first.done) {
				requireCondition(first.value.length > 0, `${label} run contains a blank line: ${file}`);
				heapPush(heap, { source, row: JSON.parse(first.value) }, compare);
			}
		}
		while (heap.length > 0) {
			const next = heapPop(heap, compare);
			if (previous !== null) {
				requireCondition(
					compare(previous, next.row) < 0,
					`${label} rows are not strictly unique under the frozen sort key`
				);
			}
			writeAll(fd, canonicalLine(next.row));
			previous = next.row;
			rows += 1;
			const following = await next.source.iterator.next();
			if (!following.done) {
				requireCondition(
					following.value.length > 0,
					`${label} run contains a blank line: ${next.source.file}`
				);
				heapPush(heap, { source: next.source, row: JSON.parse(following.value) }, compare);
			}
		}
		fsyncSync(fd);
		closeSync(fd);
		closed = true;
		linkSync(temporary, outputFile);
		return { ...fileRecord(outputFile), rows };
	} finally {
		for (const source of sources) source.lines.close();
		if (!closed) closeSync(fd);
		rmSync(temporary, { force: true });
	}
}

async function mergeRunTree({ runFiles, runRoot, outputFile, compare, label, fanIn = 128 }) {
	requireCondition(runFiles.length > 0, `${label} merge has no runs`);
	safeInteger(fanIn, `${label} merge fan-in`, 2);
	let current = [...runFiles];
	let level = 0;
	while (current.length > fanIn) {
		const next = [];
		for (let offset = 0; offset < current.length; offset += fanIn) {
			const group = current.slice(offset, offset + fanIn);
			const merged = path.join(
				runRoot,
				`merge-${String(level).padStart(2, '0')}-${String(next.length).padStart(5, '0')}.jsonl`
			);
			await mergeSortedJsonlRuns(group, merged, compare, label);
			next.push(merged);
		}
		current = next;
		level += 1;
	}
	return mergeSortedJsonlRuns(current, outputFile, compare, label);
}

/** Deterministic bounded-memory feature-run merge used by collection and synthetic scale tests. */
export async function mergeV34FeatureRuns({ runFiles, runRoot, outputFile, fanIn = 128 }) {
	return mergeRunTree({
		runFiles,
		runRoot,
		outputFile,
		compare: compareFeatureRows,
		label: 'feature',
		fanIn
	});
}

function validateWeakEngineThreshold(threshold) {
	exactKeys(
		threshold,
		new Set([
			'minRoundInclusive',
			'maxExpectedAttack',
			'maxAttackDice',
			'maxAwakenedSpirits',
			'maxBarrier',
			'maxInitiative'
		]),
		'config.weakEngineThreshold'
	);
	safeInteger(threshold.minRoundInclusive, 'config.weakEngineThreshold.minRoundInclusive', 16);
	for (const key of Object.keys(threshold).filter((key) => key !== 'minRoundInclusive')) {
		finiteNumber(threshold[key], `config.weakEngineThreshold.${key}`, 0);
	}
}

/** Validate and canonicalize every behavior-affecting raw-policy knob. */
export function validatePolicyConfig(input) {
	exactKeys(input, REQUIRED_CONFIG_KEYS, 'config');
	requireCondition(
		input.schemaVersion === POLICY_CONFIG_SCHEMA,
		`config.schemaVersion must be ${POLICY_CONFIG_SCHEMA}`
	);
	requireCondition(
		input.policyObservationVersion === 2,
		'config.policyObservationVersion must be 2'
	);
	requireCondition(input.actionSelector === 'hybrid-v1', 'config.actionSelector must be hybrid-v1');
	requireCondition(
		input.decisionSelection === 'sample' || input.decisionSelection === 'argmax',
		'config.decisionSelection must be sample or argmax'
	);
	finiteNumber(input.temperature, 'config.temperature', Number.MIN_VALUE);

	exactKeys(
		input.progressFilter,
		new Set(['mode', 'learnMonsterRewardChoices']),
		'config.progressFilter'
	);
	requireCondition(
		input.progressFilter.mode === 'selectable-candidate-indices-v1' ||
			input.progressFilter.mode === 'none',
		'config.progressFilter.mode is unsupported'
	);
	requireCondition(
		typeof input.progressFilter.learnMonsterRewardChoices === 'boolean',
		'config.progressFilter.learnMonsterRewardChoices must be boolean'
	);

	requireCondition(
		input.optionHead && typeof input.optionHead === 'object',
		'config.optionHead is required'
	);
	if (input.optionHead.mode === 'disabled') {
		exactKeys(input.optionHead, new Set(['mode', 'dimension']), 'config.optionHead');
		requireCondition(input.optionHead.dimension === 0, 'disabled option head dimension must be 0');
	} else if (input.optionHead.mode === 'round-start') {
		exactKeys(
			input.optionHead,
			new Set(['mode', 'dimension', 'selection', 'temperature', 'soloBehaviorMask']),
			'config.optionHead'
		);
		safeInteger(input.optionHead.dimension, 'config.optionHead.dimension', 1);
		requireCondition(
			input.optionHead.selection === 'sample' || input.optionHead.selection === 'argmax',
			'config.optionHead.selection must be sample or argmax'
		);
		finiteNumber(input.optionHead.temperature, 'config.optionHead.temperature', Number.MIN_VALUE);
		requireCondition(
			Array.isArray(input.optionHead.soloBehaviorMask) &&
				input.optionHead.soloBehaviorMask.length === input.optionHead.dimension &&
				input.optionHead.soloBehaviorMask.every((entry) => entry === 0 || entry === 1) &&
				input.optionHead.soloBehaviorMask.includes(1),
			'config.optionHead.soloBehaviorMask must be a supported binary mask of option dimension'
		);
	} else {
		throw new Error('config.optionHead.mode must be disabled or round-start');
	}

	requireCondition(
		input.guardianSchedule === 'absolute-balanced',
		'config.guardianSchedule must be absolute-balanced'
	);
	safeInteger(input.maxStatusLevel, 'config.maxStatusLevel');
	safeInteger(input.maxRounds, 'config.maxRounds', 1);
	requireCondition(input.maxRounds === 30, 'config.maxRounds must remain 30 for V34 B1');
	safeInteger(input.forcedClosureMaxSteps, 'config.forcedClosureMaxSteps', 1);
	safeInteger(input.maxTicks, 'config.maxTicks', 1);
	safeInteger(input.samplingStream, 'config.samplingStream');
	validateWeakEngineThreshold(input.weakEngineThreshold);
	return structuredClone(input);
}

/**
 * Required injected provider:
 *   binding: canonical JSON provenance (checkpoint hash/adapter version/backend as applicable)
 *   scoreDecision(publicContext): { rawLogits, reach30Probability, recoveryProbability }
 *   scoreOption(publicContext): { rawLogits } iff the bound option head is enabled
 *   close(): optional resource cleanup
 */
export function validatePolicyProvider(provider, config) {
	requireCondition(provider && typeof provider === 'object', 'policy provider is required');
	requireCondition(
		typeof provider.scoreDecision === 'function',
		'policy provider must implement scoreDecision(context)'
	);
	requireCondition(
		provider.binding && typeof provider.binding === 'object',
		'policy provider binding is required'
	);
	exactKeys(
		provider.binding,
		new Set([
			'schemaVersion',
			'mode',
			'provider',
			'purpose',
			'policyObservationVersion',
			'checkpoint',
			'runtime'
		]),
		'policy provider binding'
	);
	requireCondition(
		provider.binding.schemaVersion === POLICY_BINDING_SCHEMA,
		`policy provider binding schemaVersion must be ${POLICY_BINDING_SCHEMA}`
	);
	requireCondition(
		provider.binding.mode === 'unregistered-test' || provider.binding.mode === 'registered-parent',
		'policy provider binding mode must be unregistered-test or registered-parent'
	);
	for (const field of ['provider', 'purpose']) {
		requireCondition(
			typeof provider.binding[field] === 'string' && provider.binding[field].trim().length > 0,
			`policy provider binding ${field} must be a non-empty string`
		);
	}
	requireCondition(
		provider.binding.provider !== 'synthetic-placeholder',
		'synthetic-placeholder policy bindings are forbidden'
	);
	requireCondition(
		provider.binding.policyObservationVersion === config.policyObservationVersion,
		'policy provider binding observation version differs from config'
	);
	requireCondition(
		provider.binding.runtime &&
			typeof provider.binding.runtime === 'object' &&
			!Array.isArray(provider.binding.runtime) &&
			Object.keys(provider.binding.runtime).length > 0,
		'policy provider binding runtime must be a non-empty object'
	);
	if (provider.binding.checkpoint !== null) {
		exactKeys(
			provider.binding.checkpoint,
			new Set(['path', 'bytes', 'sha256']),
			'policy provider binding checkpoint'
		);
		requireCondition(
			canonicalJson(fileRecord(provider.binding.checkpoint.path)) ===
				canonicalJson(provider.binding.checkpoint),
			'policy provider checkpoint file record does not match the live file'
		);
	}
	requireCondition(
		provider.binding.mode !== 'registered-parent' || provider.binding.checkpoint !== null,
		'registered-parent policy binding requires a checkpoint file record'
	);
	canonicalJson(provider.binding);
	const credentialKeys = new Set([
		'password',
		'secret',
		'token',
		'apikey',
		'authorization',
		'credential'
	]);
	const credentialPaths = [];
	const inspectBinding = (value, prefix) => {
		if (Array.isArray(value)) {
			value.forEach((entry, index) => inspectBinding(entry, `${prefix}[${index}]`));
			return;
		}
		if (!value || typeof value !== 'object') return;
		for (const [key, entry] of Object.entries(value)) {
			const normalized = key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
			if (credentialKeys.has(normalized)) credentialPaths.push(`${prefix}.${key}`);
			inspectBinding(entry, `${prefix}.${key}`);
		}
	};
	inspectBinding(provider.binding, '$');
	requireCondition(
		credentialPaths.length === 0,
		`policy provider binding contains forbidden credential fields: ${credentialPaths.join(', ')}`
	);
	if (config.optionHead.mode === 'round-start') {
		requireCondition(
			typeof provider.scoreOption === 'function',
			'enabled option head requires scoreOption(context)'
		);
	}
	return provider;
}

function softmaxOnSupport(logits, support, temperature) {
	requireCondition(
		Array.isArray(logits) && logits.every(Number.isFinite),
		'policy rawLogits must be finite'
	);
	requireCondition(support.length > 0, 'policy selection support cannot be empty');
	const max = Math.max(...support.map((index) => logits[index] / temperature));
	const weights = support.map((index) => Math.exp(logits[index] / temperature - max));
	const total = weights.reduce((sum, value) => sum + value, 0);
	requireCondition(Number.isFinite(total) && total > 0, 'policy softmax normalization failed');
	const probabilities = Array(logits.length).fill(0);
	support.forEach((index, local) => {
		probabilities[index] = weights[local] / total;
	});
	return probabilities;
}

function deterministicUniform(seed) {
	const digest = createHash('sha256')
		.update(canonicalJson({ domain: 'arc-v34-policy-uniform-v1', seed }))
		.digest();
	return (digest.readUInt32BE(0) + 0.5) / 0x1_0000_0000;
}

function pickIndex(probabilities, support, mode, seed) {
	if (mode === 'argmax') {
		return support.reduce(
			(best, index) => (probabilities[index] > probabilities[best] ? index : best),
			support[0]
		);
	}
	const draw = deterministicUniform(seed);
	let cumulative = 0;
	for (const index of support) {
		cumulative += probabilities[index];
		if (draw <= cumulative) return index;
	}
	return support.at(-1);
}

function chooseBoundRawAction(state, seat, actions, probabilities, support, config, samplingSeed) {
	const currentVp = state.players[seat]?.victoryPoints ?? 0;
	let bestVpIndex = -1;
	let bestVpGain = 0;
	for (const index of support) {
		const preview = policyPreviewState(actions[index]);
		const nextVp = preview.players[seat]?.victoryPoints ?? 0;
		if (preview.winnerSeat === seat || nextVp >= VP_TO_WIN) {
			return { index, reason: 'immediate-win-guard' };
		}
		const gain = nextVp - currentVp;
		if (gain > bestVpGain) {
			bestVpGain = gain;
			bestVpIndex = index;
		}
	}
	const learnableMonsterReward =
		config.progressFilter.learnMonsterRewardChoices === true &&
		state.players[seat]?.pendingReward != null;
	if (!learnableMonsterReward && bestVpIndex >= 0 && bestVpGain > 0) {
		return { index: bestVpIndex, reason: 'immediate-vp-guard' };
	}
	return {
		index: pickIndex(probabilities, support, config.decisionSelection, samplingSeed),
		reason: config.decisionSelection === 'sample' ? 'sampled-policy' : 'policy-argmax'
	};
}

function roundSelectionBand(round, recoveryEligible) {
	if (recoveryEligible) return 'recovery';
	if (round >= 1 && round <= 8) return 'early';
	if (round <= 15) return 'mid';
	if (round <= 30) return 'late';
	throw new Error(`snapshot round ${round} is outside V34 B1 support`);
}

function selectionSupport(state, seat, actions, config) {
	const raw =
		config.progressFilter.mode === 'selectable-candidate-indices-v1'
			? selectableCandidateIndices(state, seat, actions, {
					learnMonsterRewardChoices: config.progressFilter.learnMonsterRewardChoices
				})
			: actions.map((_, index) => index);
	requireCondition(raw.length > 0, 'bound progress filter removed every candidate');
	requireCondition(
		new Set(raw).size === raw.length &&
			raw.every((index) => Number.isInteger(index) && index >= 0 && index < actions.length),
		'bound progress filter returned invalid support'
	);
	const withinStatusCap = raw.filter(
		(index) =>
			(policyPreviewState(actions[index]).players[seat]?.statusLevel ?? 0) <= config.maxStatusLevel
	);
	// The status cap constrains policy selection, never the engine's legal-action set or forced
	// closure. If every selectable action exceeds the cap, preserve the full selectable escape set.
	return withinStatusCap.length > 0 ? withinStatusCap : raw;
}

function publicPolicyContext(state, seat, catalog, candidateActions, option) {
	const policyOption = option
		? (({ samplingSeed: ignoredSamplingSeed, ...visible }) => structuredClone(visible))(option)
		: null;
	return {
		schemaVersion: 'arc-v34-injected-policy-context-v1',
		seat,
		round: state.round,
		phase: state.phase,
		obsV1: encodeObs(state, seat, catalog),
		obsV2: flattenObsV2(encodeEntityObsV2(state, seat, catalog), catalog),
		candidateCommands: candidateActions.map((candidate) => structuredClone(candidate.cmd)),
		candidateCommandHashes: candidateActions.map((candidate) =>
			snapshotModule.commandHash(candidate.cmd)
		),
		candidateFeatures: candidateActions.map((candidate) =>
			encodeAction(state, seat, candidate.cmd, policyPreviewState(candidate), catalog)
		),
		option: policyOption
	};
}

function optionPublicContext(state, seat, catalog) {
	return {
		schemaVersion: 'arc-v34-injected-option-context-v1',
		seat,
		round: state.round,
		phase: state.phase,
		obsV1: encodeObs(state, seat, catalog),
		obsV2: flattenObsV2(encodeEntityObsV2(state, seat, catalog), catalog)
	};
}

function applyTracedCommand(state, trace, actor, command, catalog) {
	const result = applyGameCommand(state, actor, command, catalog);
	if (!result.ok) throw new Error(`${command.type}: ${result.error.code}: ${result.error.message}`);
	trace.push(commandTraceEvent(actor, command));
	return result.state;
}

function updateMilestones(state, seat, milestones) {
	const vp = state.players[seat]?.victoryPoints ?? 0;
	if (milestones.first15Round === null && vp >= 15) milestones.first15Round = state.round;
	if (milestones.first30Round === null && vp >= VP_TO_WIN) milestones.first30Round = state.round;
}

function replayComparableState(state) {
	const projected = structuredClone(state);
	// makeGameId deliberately embeds wall time. Its RNG suffix is irrelevant to gameplay and the
	// committed structural snapshot already excludes it, so exact trace replay canonicalizes only
	// this documented non-gameplay field.
	projected.gameId = null;
	return projected;
}

function traceShardName(seed) {
	return `game-${String(seed).padStart(10, '0')}.jsonl`;
}

function rowSortKey(row) {
	return [row.publicStateHash, row.sourceGameSeed, row.decisionOrdinal];
}

function compareFeatureRows(left, right) {
	const a = rowSortKey(left);
	const b = rowSortKey(right);
	return codeUnitCompare(a[0], b[0]) || a[1] - b[1] || a[2] - b[2];
}

function compareTargetRows(left, right) {
	return codeUnitCompare(left.opaqueRowId, right.opaqueRowId);
}

function policyResult(result, candidateCount) {
	requireCondition(result && typeof result === 'object', 'scoreDecision must return an object');
	requireCondition(
		Array.isArray(result.rawLogits) &&
			result.rawLogits.length === candidateCount &&
			result.rawLogits.every(Number.isFinite),
		`scoreDecision rawLogits must contain ${candidateCount} finite values`
	);
	finiteNumber(result.reach30Probability, 'scoreDecision.reach30Probability', 0, 1);
	finiteNumber(result.recoveryProbability, 'scoreDecision.recoveryProbability', 0, 1);
	return {
		rawLogits: [...result.rawLogits],
		reach30Probability: result.reach30Probability,
		recoveryProbability: result.recoveryProbability
	};
}

function chooseRoundOption(provider, config, state, seat, catalog, sourceSeed, optionOrdinal) {
	if (config.optionHead.mode === 'disabled') return null;
	const result = provider.scoreOption(optionPublicContext(state, seat, catalog));
	requireCondition(result && typeof result === 'object', 'scoreOption must return an object');
	requireCondition(
		Array.isArray(result.rawLogits) &&
			result.rawLogits.length === config.optionHead.dimension &&
			result.rawLogits.every(Number.isFinite),
		`scoreOption rawLogits must contain ${config.optionHead.dimension} finite values`
	);
	const support = config.optionHead.soloBehaviorMask.flatMap((enabled, index) =>
		enabled ? [index] : []
	);
	const probabilities = softmaxOnSupport(result.rawLogits, support, config.optionHead.temperature);
	const samplingSeed = botSamplingSeed(sourceSeed, optionOrdinal, seat, config.samplingStream + 1);
	const optionId = pickIndex(probabilities, support, config.optionHead.selection, samplingSeed);
	return {
		round: state.round,
		optionId,
		oneHot: Array.from({ length: config.optionHead.dimension }, (_, index) =>
			index === optionId ? 1 : 0
		),
		rawLogits: [...result.rawLogits],
		probabilities,
		behaviorMask: [...config.optionHead.soloBehaviorMask],
		samplingSeed
	};
}

function guardianForSeed(catalog, seed) {
	requireCondition(
		Array.isArray(catalog.guardians) && catalog.guardians.length > 0,
		'catalog has no guardians'
	);
	return catalog.guardians[guardianIndexForSeed(seed, catalog.guardians.length)].name;
}

/**
 * Reconstruct one retained decision using only the feature shard, its trace shard, the trace
 * manifest, public catalog, and bound policy config. Future targets are deliberately not accepted.
 */
export function verifyFeatureTracePrefix({ feature, traceEvents, traceManifest, catalog, config }) {
	const boundConfig = validatePolicyConfig(config);
	requireCondition(feature?.schemaVersion === FEATURE_SCHEMA, 'unsupported feature schema');
	requireCondition(
		sha256Canonical(boundConfig) === feature.policy?.configSha256,
		'feature policy config hash differs from the replay config'
	);
	requireCondition(
		traceManifest?.schemaVersion === TRACE_MANIFEST_SCHEMA,
		'unsupported trace manifest schema'
	);
	requireCondition(
		feature.sourceGameSeed === traceManifest.sourceGameSeed,
		'feature and trace manifest source seeds differ'
	);
	requireCondition(
		feature.canonicalTakenActionTrace?.shardPath ===
			`traces/${traceShardName(feature.sourceGameSeed)}`,
		'feature trace shard path is not canonical'
	);
	requireCondition(
		Array.isArray(traceEvents) && traceEvents.length === traceManifest.events,
		'trace event count differs from the manifest'
	);
	requireCondition(
		sha256Canonical(traceEvents) === traceManifest.traceSha256,
		'full trace canonical hash differs from the manifest'
	);
	const prefixCount = feature.canonicalTakenActionTrace.prefixEventCount;
	safeInteger(prefixCount, 'feature trace prefix event count', 1);
	requireCondition(prefixCount < traceEvents.length, 'feature trace prefix has no taken action');
	const tracePrefix = traceEvents.slice(0, prefixCount);
	requireCondition(
		sha256Canonical(tracePrefix) === feature.canonicalTakenActionTrace.prefixSha256,
		'feature trace prefix hash mismatch'
	);
	const state = replaySnapshotTrace({
		roomCode: traceManifest.roomCode,
		guardianNames: traceManifest.guardianNames,
		catalog,
		sourceSeed: feature.sourceGameSeed,
		events: tracePrefix
	});
	const legal = legalActionsWithNext(state, feature.seat, catalog);
	const reconstructed = buildOutcomeBlindSnapshot({
		sourceSeed: feature.sourceGameSeed,
		decisionOrdinal: feature.decisionOrdinal,
		seat: feature.seat,
		state,
		catalog,
		trace: tracePrefix,
		weakEngineThreshold: boundConfig.weakEngineThreshold,
		legalActions: legal,
		modelDiagnostics: {
			rawLogits: feature.rawLogits,
			probabilities: feature.rawProbabilities,
			reach30Probability: feature.calibratedReach30Probability,
			recoveryProbability: 0
		},
		samplingStream: boundConfig.samplingStream
	});
	const exact = (actual, expected, label) =>
		requireCondition(canonicalJson(actual) === canonicalJson(expected), `${label} mismatch`);
	exact(reconstructed.publicStateHash, feature.publicStateHash, 'public state hash');
	exact(reconstructed.currentVisibleState, feature.currentVisibleState, 'current visible state');
	exact(reconstructed.obsV1, feature.obsV1, 'obs-v1');
	exact(reconstructed.obsV2, feature.obsV2, 'obs-v2');
	exact(
		reconstructed.currentVisibleState.legalCommandHashes,
		feature.canonicalLegalCommandHashes,
		'legal command hashes'
	);
	exact(
		reconstructed.candidates.map((candidate) => candidate.actionFeatures),
		feature.candidateFeatures,
		'candidate features'
	);
	exact(reconstructed.recoveryDiagnostics, feature.recoveryDiagnostics, 'recovery diagnostics');
	exact(reconstructed.botSamplingSeed, feature.botActionSamplingSeed, 'bot action sampling seed');
	const taken = traceEvents[prefixCount];
	requireCondition(
		taken?.kind === 'command',
		'trace event after the feature prefix is not a command'
	);
	requireCondition(
		taken.commandHash === feature.policy.chosenCommandHash,
		'taken action differs from the feature policy choice'
	);
	return {
		valid: true,
		publicStateHash: reconstructed.publicStateHash,
		legalActions: legal.length,
		takenCommandHash: taken.commandHash,
		futureTargetsLoaded: false
	};
}

/** Execute one complete raw-policy solo game and retain only eligible ambiguous snapshots. */
export function collectOneGame({
	catalog,
	sourceSeed,
	config,
	provider,
	policyConfigSha256,
	policyBindingSha256
}) {
	safeInteger(sourceSeed, 'sourceSeed', 1);
	requireCondition(
		SHA256_RE.test(policyConfigSha256),
		'policyConfigSha256 must be a lowercase SHA-256'
	);
	requireCondition(
		SHA256_RE.test(policyBindingSha256),
		'policyBindingSha256 must be a lowercase SHA-256'
	);
	const seat = SEAT_COLORS[0];
	const guardianName = guardianForSeed(catalog, sourceSeed);
	const guardianNames = [guardianName];
	const roomCode = `V34B1-${sourceSeed}`;
	let state = createLobbyState({ roomCode, guardianNames });
	const trace = [];
	const memberId = `v34-bot-${seat}`;
	const claimActor = { memberId, displayName: seat, role: 'player', seatColor: null };
	const seatActor = { memberId, displayName: seat, role: 'player', seatColor: seat };
	const host = { memberId: 'v34-host', displayName: 'v34-host', role: 'host', seatColor: null };
	state = applyTracedCommand(
		state,
		trace,
		claimActor,
		{ type: 'claimSeat', seatColor: seat },
		catalog
	);
	state = applyTracedCommand(
		state,
		trace,
		seatActor,
		{ type: 'selectGuardian', guardianName },
		catalog
	);
	state = applyTracedCommand(state, trace, host, { type: 'startGame', seed: sourceSeed }, catalog);

	const features = [];
	const pendingTargets = [];
	const milestones = { first15Round: null, first30Round: null };
	const phaseActionCounts = new Map();
	const stopCounts = {
		choice: 0,
		stochasticSingleton: 0,
		seatComplete: 0,
		terminal: 0,
		noLegalAction: 0
	};
	let decisionOrdinal = 0;
	let policyDecisionCount = 0;
	let optionOrdinal = 0;
	let activeOption = null;
	let ticks = 0;
	let terminalCandidateChoicesExcluded = 0;
	let previousStatusLevel = state.players[seat]?.statusLevel ?? 0;
	let maximumObservedStatusLevel = previousStatusLevel;
	let statusCapViolationEvents = 0;
	const observeStatus = () => {
		const statusLevel = state.players[seat]?.statusLevel ?? 0;
		maximumObservedStatusLevel = Math.max(maximumObservedStatusLevel, statusLevel);
		if (statusLevel > config.maxStatusLevel && statusLevel > previousStatusLevel) {
			statusCapViolationEvents += 1;
		}
		previousStatusLevel = statusLevel;
	};
	updateMilestones(state, seat, milestones);

	while (state.status === 'active' && state.round <= config.maxRounds) {
		ticks += 1;
		requireCondition(
			ticks <= config.maxTicks,
			`game ${sourceSeed} exceeded maxTicks=${config.maxTicks}`
		);
		updateMilestones(state, seat, milestones);
		if (!botSeatNeedsToAct(state, seat)) {
			const event = deadlineTraceEvent(state);
			const beforeRevision = state.revision;
			const beforePhaseRound = `${state.phase}:${state.round}`;
			applyDeadlineAdvance(state, catalog);
			requireCondition(
				state.revision > beforeRevision,
				`game ${sourceSeed} deadline did not advance revision`
			);
			requireCondition(
				`${state.phase}:${state.round}` !== beforePhaseRound || state.status !== 'active',
				`game ${sourceSeed} deadline did not advance phase/round`
			);
			trace.push(event);
			observeStatus();
			updateMilestones(state, seat, milestones);
			continue;
		}

		if (config.optionHead.mode === 'round-start' && activeOption?.round !== state.round) {
			activeOption = chooseRoundOption(
				provider,
				config,
				state,
				seat,
				catalog,
				sourceSeed,
				optionOrdinal
			);
			optionOrdinal += 1;
		}

		const closure = closeDeterministicSingletons(state, seat, catalog, {
			maxSteps: config.forcedClosureMaxSteps
		});
		stopCounts[closure.stopReason] += 1;
		for (const command of closure.forcedCommands) {
			state = applyTracedCommand(state, trace, botActorFor(state, seat), command, catalog);
			observeStatus();
			updateMilestones(state, seat, milestones);
		}
		requireCondition(
			sha256Canonical(state) === sha256Canonical(closure.state),
			`game ${sourceSeed} deterministic forced closure drifted from authoritative reducer`
		);

		if (closure.stopReason === 'terminal') break;
		if (closure.stopReason === 'seatComplete') continue;
		if (closure.stopReason === 'noLegalAction') {
			throw new Error(`game ${sourceSeed} has no legal action while the solo seat must act`);
		}

		const candidateActions = legalActionsWithNext(state, seat, catalog);
		requireCondition(
			candidateActions.length > 0,
			`game ${sourceSeed} lost its closure candidate support`
		);
		const evaluation = policyResult(
			provider.scoreDecision(
				publicPolicyContext(state, seat, catalog, candidateActions, activeOption)
			),
			candidateActions.length
		);
		const support = selectionSupport(state, seat, candidateActions, config);
		const probabilities = softmaxOnSupport(evaluation.rawLogits, support, config.temperature);
		const samplingSeed = botSamplingSeed(sourceSeed, decisionOrdinal, seat, config.samplingStream);
		const selected = chooseBoundRawAction(
			state,
			seat,
			candidateActions,
			probabilities,
			support,
			config,
			samplingSeed
		);
		const chosenIndex = selected.index;
		const modelDiagnostics = {
			rawLogits: evaluation.rawLogits,
			probabilities,
			reach30Probability: evaluation.reach30Probability,
			recoveryProbability: evaluation.recoveryProbability
		};
		// The frozen snapshot primitive intentionally rejects terminal structural states.  A choice
		// containing an immediately terminal candidate still drives the raw game, but is excluded
		// fail-closed from B1 rather than inventing a terminal semantic-hash representation here.
		const snapshotRepresentable = candidateActions.every(
			(action) => policyPreviewState(action).status === 'active'
		);
		if (!snapshotRepresentable) terminalCandidateChoicesExcluded += 1;
		const full = snapshotRepresentable
			? buildOutcomeBlindSnapshot({
					sourceSeed,
					decisionOrdinal,
					seat,
					state,
					catalog,
					trace,
					weakEngineThreshold: config.weakEngineThreshold,
					legalActions: candidateActions,
					modelDiagnostics,
					samplingStream: config.samplingStream
				})
			: null;

		if (full?.eligibleStrategicChoice) {
			const {
				trace: duplicatedTrace,
				traceHash: duplicatedTraceHash,
				sourceSeed: ignoredSourceSeed,
				botSamplingSeed: botActionSamplingSeed,
				candidates: snapshotCandidates,
				modelDiagnostics: snapshotModelDiagnostics,
				...snapshot
			} = full;
			requireCondition(
				duplicatedTraceHash === sha256Canonical(duplicatedTrace),
				`game ${sourceSeed} snapshot trace hash is inconsistent`
			);
			const opaqueRowId = sha256Canonical({
				domain: 'arc-v34-teacher-snapshot-row-id-v1',
				publicStateHash: full.publicStateHash,
				sourceGameSeed: sourceSeed,
				decisionOrdinal
			});
			const selectionBand = roundSelectionBand(
				full.round,
				full.recoveryDiagnostics.recoveryEligible
			);
			const feature = {
				schemaVersion: FEATURE_SCHEMA,
				opaqueRowId,
				sourceGameSeed: sourceSeed,
				...snapshot,
				botActionSamplingSeed,
				canonicalLegalCommandHashes: [...full.currentVisibleState.legalCommandHashes],
				candidateFeatures: snapshotCandidates.map((candidate) => candidate.actionFeatures),
				candidates: snapshotCandidates.map(
					({ actionFeatures: ignoredActionFeatures, ...candidate }) => candidate
				),
				rawLogits: snapshotModelDiagnostics.rawLogits,
				rawProbabilities: snapshotModelDiagnostics.probabilities,
				calibratedReach30Probability: snapshotModelDiagnostics.reach30Probability,
				currentPublicRecoveryDiagnostics: full.recoveryDiagnostics,
				selectionBand,
				canonicalTakenActionTrace: {
					shardPath: `traces/${traceShardName(sourceSeed)}`,
					prefixEventCount: trace.length,
					prefixSha256: sha256Canonical(trace)
				},
				policy: {
					configSha256: policyConfigSha256,
					bindingSha256: policyBindingSha256,
					selectionSupport: candidateActions.map((_, index) => (support.includes(index) ? 1 : 0)),
					chosenIndex,
					chosenCommandHash: full.candidates[chosenIndex].commandHash,
					selectionReason: selected.reason,
					option: activeOption ? structuredClone(activeOption) : null
				}
			};
			assertFeatureShardSafe(feature, ['trace', 'traceHash']);
			features.push(feature);
			pendingTargets.push({
				opaqueRowId,
				sourceGameSeed: sourceSeed,
				decisionOrdinal,
				round: state.round
			});
		}

		const phaseKey = `${state.round}:${state.phase}`;
		const phaseCount = (phaseActionCounts.get(phaseKey) ?? 0) + 1;
		phaseActionCounts.set(phaseKey, phaseCount);
		requireCondition(
			phaseCount <= config.forcedClosureMaxSteps * 4,
			`game ${sourceSeed} exceeded the bounded raw-policy actions for ${phaseKey}`
		);
		state = applyTracedCommand(
			state,
			trace,
			botActorFor(state, seat),
			candidateActions[chosenIndex].cmd,
			catalog
		);
		observeStatus();
		policyDecisionCount += 1;
		decisionOrdinal += 1;
		updateMilestones(state, seat, milestones);
	}

	requireCondition(
		state.status === 'finished',
		`game ${sourceSeed} did not finish; status=${state.status}`
	);
	const finalVp = state.players[seat]?.victoryPoints ?? 0;
	const won = state.winnerSeat === seat && finalVp >= VP_TO_WIN;
	const post15VpPerRound =
		milestones.first15Round === null
			? 0
			: Math.max(0, (finalVp - 15) / Math.max(1, state.round - milestones.first15Round));
	const targets = pendingTargets.map((pending) => ({
		schemaVersion: TARGET_SCHEMA,
		opaqueRowId: pending.opaqueRowId,
		sourceGameSeed: sourceSeed,
		decisionOrdinal: pending.decisionOrdinal,
		target: {
			finalVp,
			won,
			reached30: finalVp >= VP_TO_WIN,
			first30Round: milestones.first30Round,
			terminalRound: state.round,
			roundsAfterDecision: Math.max(0, state.round - pending.round),
			post15VpPerRound,
			finalStatusLevel: state.players[seat]?.statusLevel ?? 0
		}
	}));

	const replayed = replaySnapshotTrace({
		roomCode,
		guardianNames,
		catalog,
		sourceSeed,
		events: trace
	});
	const terminalStateSha256 = sha256Canonical(replayComparableState(state));
	const replayedStateSha256 = sha256Canonical(replayComparableState(replayed));
	requireCondition(
		replayedStateSha256 === terminalStateSha256,
		`game ${sourceSeed} full trace does not replay to the terminal state: expected ${terminalStateSha256}, got ${replayedStateSha256}`
	);
	return {
		features,
		targets,
		trace,
		traceManifest: {
			schemaVersion: TRACE_MANIFEST_SCHEMA,
			sourceGameSeed: sourceSeed,
			roomCode,
			guardianNames,
			events: trace.length,
			traceSha256: sha256Canonical(trace),
			terminalStateSha256
		},
		metrics: {
			sourceGameSeed: sourceSeed,
			guardianName,
			finished: true,
			policyDecisions: policyDecisionCount,
			retainedSnapshots: features.length,
			traceEvents: trace.length,
			ticks,
			forcedClosureStops: stopCounts,
			terminalCandidateChoicesExcluded,
			maximumObservedStatusLevel,
			statusCapViolationEvents
		}
	};
}

function validateSeedSet(seeds) {
	requireCondition(
		Array.isArray(seeds) && seeds.length > 0,
		'at least one source seed is required'
	);
	const unique = new Set();
	for (const seed of seeds) {
		safeInteger(seed, 'source seed', 1);
		requireCondition(!unique.has(seed), `duplicate source seed ${seed}`);
		unique.add(seed);
	}
	return [...seeds];
}

/** Collect a new immutable artifact root. The root is published by one final atomic rename. */
export async function collectTeacherSnapshots({
	catalogPath,
	outputDir,
	seeds,
	config: rawConfig,
	provider,
	policyModulePath = null
}) {
	const config = validatePolicyConfig(rawConfig);
	validatePolicyProvider(provider, config);
	const sourceSeeds = validateSeedSet(seeds);
	const resolvedCatalog = path.resolve(catalogPath);
	const resolvedOutput = path.resolve(outputDir);
	requireCondition(existsSync(resolvedCatalog), `catalog not found: ${resolvedCatalog}`);
	requireCondition(
		!pathEntryExists(resolvedOutput),
		`output directory already exists: ${resolvedOutput}`
	);
	const publishLock = `${resolvedOutput}.publish-lock`;
	const catalog = JSON.parse(readFileSync(resolvedCatalog, 'utf8'));
	const policyConfigSha256 = sha256Canonical(config);
	const policyBinding = structuredClone(provider.binding);
	const policyBindingSha256 = sha256Canonical(policyBinding);
	const policyModuleRecord = policyModulePath ? fileRecord(path.resolve(policyModulePath)) : null;
	const staging = path.join(
		path.dirname(resolvedOutput),
		`.${path.basename(resolvedOutput)}.tmp-${process.pid}-${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 12)}`
	);
	requireCondition(!pathEntryExists(staging), `staging path collision: ${staging}`);
	let published = false;
	let publishLocked = false;
	try {
		const publishLockFd = openSync(publishLock, 'wx', 0o600);
		publishLocked = true;
		try {
			fsyncSync(publishLockFd);
		} finally {
			closeSync(publishLockFd);
		}
		mkdirSync(staging, { recursive: false });
		const runRoot = path.join(staging, '.sorted-runs');
		const featureRunRoot = path.join(runRoot, 'features');
		const targetRunRoot = path.join(runRoot, 'targets');
		mkdirSync(featureRunRoot, { recursive: true });
		mkdirSync(targetRunRoot, { recursive: true });
		const featureRuns = [];
		const targetRuns = [];
		const gameMetrics = [];
		const traceManifests = [];
		const rowsBySelectionBand = { recovery: 0, late: 0, mid: 0, early: 0 };
		let featureRows = 0;
		let targetRows = 0;
		for (const sourceSeed of sourceSeeds) {
			const game = collectOneGame({
				catalog,
				sourceSeed,
				config,
				provider,
				policyConfigSha256,
				policyBindingSha256
			});
			game.features.sort(compareFeatureRows);
			game.targets.sort(compareTargetRows);
			for (const [index, feature] of game.features.entries()) {
				if (index > 0) {
					requireCondition(
						compareFeatureRows(game.features[index - 1], feature) < 0,
						`game ${sourceSeed} feature rows are not strictly unique`
					);
				}
				rowsBySelectionBand[feature.selectionBand] += 1;
			}
			for (let index = 1; index < game.targets.length; index += 1) {
				requireCondition(
					compareTargetRows(game.targets[index - 1], game.targets[index]) < 0,
					`game ${sourceSeed} target rows are not strictly unique`
				);
			}
			featureRows += game.features.length;
			targetRows += game.targets.length;
			const runName = traceShardName(sourceSeed);
			const featureRun = path.join(featureRunRoot, runName);
			const targetRun = path.join(targetRunRoot, runName);
			atomicWriteNew(featureRun, artifactPayload(game.features));
			atomicWriteNew(targetRun, artifactPayload(game.targets));
			featureRuns.push(featureRun);
			targetRuns.push(targetRun);
			gameMetrics.push(game.metrics);
			const traceFile = path.join(staging, 'traces', traceShardName(sourceSeed));
			atomicWriteNew(traceFile, artifactPayload(game.trace));
			traceManifests.push({
				...game.traceManifest,
				shard: fileRecord(traceFile, staging)
			});
		}
		const featureArtifact = await mergeV34FeatureRuns({
			runFiles: featureRuns,
			runRoot: featureRunRoot,
			outputFile: path.join(staging, 'features', 'snapshots.jsonl')
		});
		const targetArtifact = await mergeRunTree({
			runFiles: targetRuns,
			runRoot: targetRunRoot,
			outputFile: path.join(staging, 'targets', 'future-targets.jsonl'),
			compare: compareTargetRows,
			label: 'target'
		});
		requireCondition(featureArtifact.rows === featureRows, 'feature merge row count changed');
		requireCondition(targetArtifact.rows === targetRows, 'target merge row count changed');
		rmSync(runRoot, { recursive: true });
		const traceManifestPayload = artifactPayload(
			traceManifests.sort((a, b) => a.sourceGameSeed - b.sourceGameSeed)
		);
		atomicWriteNew(path.join(staging, 'traces', 'manifest.jsonl'), traceManifestPayload);

		requireCondition(
			sha256Canonical(provider.binding) === policyBindingSha256,
			'policy provider binding changed during collection'
		);
		if (policyModuleRecord) {
			requireCondition(
				canonicalJson(fileRecord(path.resolve(policyModulePath))) ===
					canonicalJson(policyModuleRecord),
				'policy module changed during collection'
			);
		}
		const sourceFiles = {
			collector: fileRecord(SCRIPT_PATH),
			snapshotPrimitives: fileRecord(
				path.join(ROOT, 'src', 'lib', 'play', 'ml', 'expertIteration', 'snapshot.ts')
			),
			freezer: fileRecord(path.join(ROOT, 'ml', 'freeze_v34_teacher_snapshots.py')),
			catalog: fileRecord(resolvedCatalog)
		};
		if (policyModuleRecord) sourceFiles.policyModule = policyModuleRecord;
		const report = {
			schemaVersion: COLLECTION_SCHEMA,
			valid: true,
			outcomesInspectedForSelection: false,
			seedRegistrationStatus: 'not-evaluated-by-collector; external authorization is mandatory',
			contract: {
				seats: 1,
				completeGamesOnly: true,
				featureTargetPhysicalSeparation: true,
				traceStorage:
					'one canonical JSONL shard per source game; rows bind prefix event count and canonical-array SHA-256',
				featureOrder: ['publicStateHash', 'sourceGameSeed', 'decisionOrdinal'],
				boundedMemoryMerge:
					'per-game sorted runs with deterministic locale-independent 128-way merge passes',
				recoveryPrecedence: true,
				atomicPublication:
					'adjacent exclusive publish lock, atomic new-only file links, and one staging-tree rename to an absent final directory'
			},
			policy: {
				config,
				configSha256: policyConfigSha256,
				binding: policyBinding,
				bindingSha256: policyBindingSha256
			},
			inputs: sourceFiles,
			runtime: {
				node: process.version,
				platform: process.platform,
				arch: process.arch
			},
			seeds: sourceSeeds,
			metrics: {
				games: gameMetrics.length,
				featureRows,
				targetRows,
				traceEvents: gameMetrics.reduce((sum, game) => sum + game.traceEvents, 0),
				rowsBySelectionBand,
				gamesDetail: gameMetrics
			},
			artifacts: {
				features: {
					...featureArtifact,
					path: 'features/snapshots.jsonl'
				},
				targets: {
					...targetArtifact,
					path: 'targets/future-targets.jsonl'
				},
				traceManifest: {
					path: 'traces/manifest.jsonl',
					bytes: Buffer.byteLength(traceManifestPayload),
					sha256: sha256Bytes(traceManifestPayload),
					rows: traceManifests.length
				}
			}
		};
		atomicWriteNew(path.join(staging, 'collection.json'), `${canonicalJson(report)}\n`);
		requireCondition(
			!pathEntryExists(resolvedOutput),
			`output directory appeared during collection: ${resolvedOutput}`
		);
		renameSync(staging, resolvedOutput);
		published = true;
		return report;
	} finally {
		try {
			provider.close?.();
		} finally {
			if (!published) rmSync(staging, { recursive: true, force: true });
			if (publishLocked) rmSync(publishLock, { force: true });
		}
	}
}

function parsePositiveInteger(value, label) {
	const parsed = Number(value);
	return safeInteger(parsed, label, 1);
}

async function cli() {
	const { values: args } = parseArgs({
		options: {
			catalog: { type: 'string' },
			config: { type: 'string' },
			'policy-module': { type: 'string' },
			seed0: { type: 'string' },
			games: { type: 'string' },
			out: { type: 'string' }
		}
	});
	for (const name of ['catalog', 'config', 'policy-module', 'seed0', 'games', 'out']) {
		requireCondition(args[name], `--${name} is required`);
	}
	const seed0 = parsePositiveInteger(args.seed0, '--seed0');
	const games = parsePositiveInteger(args.games, '--games');
	const config = JSON.parse(readFileSync(path.resolve(args.config), 'utf8'));
	const policyModulePath = path.resolve(args['policy-module']);
	requireCondition(existsSync(policyModulePath), `policy module not found: ${policyModulePath}`);
	const imported = await import(
		`${pathToFileURL(policyModulePath).href}?sha256=${sha256File(policyModulePath)}`
	);
	requireCondition(
		typeof imported.createV34SnapshotPolicy === 'function',
		'--policy-module must export createV34SnapshotPolicy({ config, catalogPath })'
	);
	const provider = await imported.createV34SnapshotPolicy({
		config: validatePolicyConfig(config),
		catalogPath: path.resolve(args.catalog)
	});
	const report = await collectTeacherSnapshots({
		catalogPath: args.catalog,
		outputDir: args.out,
		seeds: Array.from({ length: games }, (_, index) => seed0 + index),
		config,
		provider,
		policyModulePath
	});
	process.stdout.write(`${canonicalJson(report)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
	cli().catch((error) => {
		process.stderr.write(`${error?.stack ?? error}\n`);
		process.exitCode = 1;
	});
}

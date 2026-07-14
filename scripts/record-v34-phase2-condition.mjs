#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { V34_STRENGTH_TOOLING_FILES } from './v34-strength-tooling-files.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPERIMENT = 'ml/experiments/v34-latency-first-expert-iteration';
const DEFAULT_LOCK = `${EXPERIMENT}/artifacts/strength-tooling-lock.json`;
const DEFAULT_PROTOCOL = `${EXPERIMENT}/protocol.json`;
const DEFAULT_STRENGTH_PROTOCOL = `${EXPERIMENT}/strength-protocol.json`;
const REQUIRED_LOCKED_FILES = V34_STRENGTH_TOOLING_FILES;

const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const sha256 = (file) => sha256Bytes(readFileSync(file));
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const stable = (value) => JSON.stringify(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const assert = (condition, message) => {
	if (!condition) throw new Error(message);
};
const relative = (file) => {
	const absolute = path.resolve(file);
	const value = path.relative(repo, absolute);
	return value.startsWith('..') ? absolute : value;
};
const resolveRecord = (value) => (path.isAbsolute(value) ? value : path.resolve(repo, value));
const fileRecord = (file) => ({
	path: relative(file),
	bytes: readFileSync(file).length,
	sha256: sha256(file)
});
const verifyFileRecord = (record, label) => {
	assert(record && typeof record.path === 'string', `${label}: missing file record`);
	const file = resolveRecord(record.path);
	assert(existsSync(file), `${label}: missing ${record.path}`);
	assert(readFileSync(file).length === record.bytes, `${label}: byte size changed`);
	assert(sha256(file) === record.sha256, `${label}: SHA-256 changed`);
	return file;
};
const linkFrom = (lock, name) => lock[name] ?? lock.inputs?.[name];

export function verifyStrengthLock(lockPath = DEFAULT_LOCK) {
	const resolvedLock = path.resolve(lockPath);
	assert(existsSync(resolvedLock), 'V34 strength-tooling lock is missing');
	const lock = readJson(resolvedLock);
	assert(
		lock.schemaVersion === 'arc-v34-strength-tooling-lock-v1',
		'V34 strength lock schema mismatch'
	);
	assert(
		/^[0-9a-f]{40}$/.test(lock.implementationCommit ?? ''),
		'V34 strength lock commit is invalid'
	);
	assert(
		stable(lock.authorization) ===
			stable({
				phase2ExecutionOpen: true,
				guardianSeedsOpen: false,
				teacherSeedsOpen: false,
				finalDevelopmentSeedsOpen: false,
				hiddenSeedsOpen: false,
				multiplayerSeedsOpen: false,
				humanReferenceSeedsOpen: false,
				productionPromotionOpen: false
			}),
		'V34 strength lock authorization mismatch'
	);
	assert(
		lock.files && typeof lock.files === 'object',
		'V34 strength lock file inventory is missing'
	);
	for (const required of REQUIRED_LOCKED_FILES) {
		assert(typeof lock.files[required] === 'string', `V34 strength lock does not bind ${required}`);
	}
	for (const [file, expected] of Object.entries(lock.files)) {
		assert(existsSync(file), `V34 strength source is missing: ${file}`);
		assert(sha256(file) === expected, `V34 strength source hash mismatch: ${file}`);
	}
	if (existsSync('.git')) {
		execFileSync('git', ['merge-base', '--is-ancestor', lock.implementationCommit, 'HEAD']);
	}
	execFileSync(process.execPath, ['scripts/verify-v34-strength-chain.mjs', 'phase2'], {
		stdio: 'ignore'
	});
	const expectedLinks = {
		baseSourceLock: `${EXPERIMENT}/artifacts/source-lock.json`,
		strengthProtocol: DEFAULT_STRENGTH_PROTOCOL,
		systemsEligibility: `${EXPERIMENT}/artifacts/systems-eligibility.json`,
		phase2Authorization: `${EXPERIMENT}/artifacts/phase2-authorization.json`,
		strengthPreflight: `${EXPERIMENT}/artifacts/strength-preflight/result.json`
	};
	for (const [name, expectedPath] of Object.entries(expectedLinks)) {
		const link = linkFrom(lock, name);
		assert(link?.path === expectedPath, `V34 strength lock ${name} path mismatch`);
		assert(
			existsSync(link.path) && sha256(link.path) === link.sha256,
			`V34 strength lock ${name} hash mismatch`
		);
	}
	const protocol = readJson(DEFAULT_PROTOCOL);
	const strengthProtocol = readJson(DEFAULT_STRENGTH_PROTOCOL);
	assert(
		strengthProtocol.schemaVersion === 'arc-v34-strength-protocol-v1',
		'V34 strength protocol schema mismatch'
	);
	assert(
		strengthProtocol.base?.protocolPath === DEFAULT_PROTOCOL &&
			strengthProtocol.base?.protocolSha256 === sha256(DEFAULT_PROTOCOL),
		'V34 strength protocol is not bound to the base protocol'
	);
	const systems = readJson(`${EXPERIMENT}/artifacts/systems-eligibility.json`);
	const authorization = readJson(`${EXPERIMENT}/artifacts/phase2-authorization.json`);
	assert(
		systems.schemaVersion === 'arc-v34-systems-eligibility-v1',
		'V34 systems eligibility schema mismatch'
	);
	assert(systems.phase2MayOpen === true, 'V34 systems eligibility does not permit Phase 2');
	assert(
		authorization.schemaVersion === 'arc-v34-phase2-authorization-v1',
		'V34 Phase 2 authorization schema mismatch'
	);
	assert(authorization.authorization?.phase2SeedsOpen === true, 'V34 Phase 2 seeds are closed');
	for (const [key, value] of Object.entries(authorization.authorization ?? {})) {
		if (key !== 'phase2SeedsOpen')
			assert(value === false, `V34 Phase 2 authorization unexpectedly opens ${key}`);
	}
	assert(
		authorization.systemsEligibility?.path === `${EXPERIMENT}/artifacts/systems-eligibility.json` &&
			authorization.systemsEligibility?.sha256 === sha256(authorization.systemsEligibility.path),
		'V34 Phase 2 authorization systems link mismatch'
	);
	assert(
		stable(authorization.registeredFamilyCandidateSlots) ===
			stable(protocol.phase2.registeredCandidateSlots),
		'V34 Phase 2 registered family changed'
	);
	assert(
		stable(authorization.eligibleCandidateArms) === stable(systems.eligibleCandidateArms),
		'V34 Phase 2 eligible arm set changed'
	);
	assert(
		authorization.eligibleCandidateArms.length > 0,
		'V34 Phase 2 has no systems-eligible arms'
	);
	return {
		lock,
		lockPath: resolvedLock,
		protocol,
		strengthProtocol,
		systems,
		authorization
	};
}

function expectedArm(context, condition) {
	if (condition === 'raw') {
		return { id: 'raw', kind: 'raw', selectedWorkers: 24 };
	}
	assert(
		context.authorization.eligibleCandidateArms.includes(condition),
		`${condition}: arm is not Phase 2 authorized`
	);
	const arm = context.protocol.systems.candidateArms.find(
		(candidate) => candidate.id === condition
	);
	const systemsArm = context.systems.arms.find((candidate) => candidate.id === condition);
	assert(arm, `${condition}: arm is not registered`);
	assert(
		systemsArm?.operationallyEligible === true,
		`${condition}: arm failed systems eligibility`
	);
	assert(
		Number.isSafeInteger(systemsArm.selectedWorkers) &&
			context.protocol.systems.throughput.workerCounts.includes(systemsArm.selectedWorkers),
		`${condition}: systems-selected worker count is invalid`
	);
	return { ...arm, selectedWorkers: systemsArm.selectedWorkers };
}

function mean(values) {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function close(actual, expected, label, tolerance = 1e-12) {
	assert(
		finite(actual) && Math.abs(actual - expected) <= tolerance,
		`${label}: aggregate mismatch`
	);
}

function validateCycle(row, condition) {
	for (const field of ['finalVP', 'finalAttackDice', 'finalSpirits', 'finalMaxBarrier']) {
		assert(
			Number.isSafeInteger(row[field]) && row[field] >= 0,
			`${condition}: seed ${row.seed} has invalid ${field}`
		);
	}
	assert(
		finite(row.post15VpPerRound),
		`${condition}: seed ${row.seed} has invalid post15VpPerRound`
	);
	assert(
		row.first30Round === null ||
			(Number.isSafeInteger(row.first30Round) && row.first30Round >= 1 && row.first30Round <= 30),
		`${condition}: invalid first30Round`
	);
	assert(
		row.cycle && typeof row.cycle === 'object',
		`${condition}: seed ${row.seed} lacks cycle telemetry`
	);
	for (const field of [
		'first30Round',
		'post15VpPerRound',
		'finalAttackDice',
		'finalSpirits',
		'finalMaxBarrier'
	]) {
		assert(
			row.cycle[field] === row[field],
			`${condition}: seed ${row.seed} cycle ${field} mismatch`
		);
	}
}

export function validatePhase2Report(context, condition, workers, reportPath) {
	const arm = expectedArm(context, condition);
	assert(
		workers === arm.selectedWorkers,
		`${condition}: worker count differs from the frozen contract`
	);
	const report = readJson(reportPath);
	const protocol = context.protocol;
	const common = context.strengthProtocol.commonDecode;
	assert(report.schemaVersion === 'solo-heldout-v2', `${condition}: evaluator schema mismatch`);
	assert(
		report.sourceCommit === context.lock.implementationCommit,
		`${condition}: source commit mismatch`
	);
	assert(
		report.seed0 === protocol.phase2.seed0 && report.games === protocol.phase2.games,
		`${condition}: seed/game contract mismatch`
	);
	assert(
		report.maxRounds === common.maxRounds && report.maxStatusLevel === common.maxStatusLevel,
		`${condition}: horizon/status mismatch`
	);
	assert(report.weights === protocol.inputs.policy.path, `${condition}: checkpoint path mismatch`);
	assert(report.catalog === protocol.inputs.catalog.path, `${condition}: catalog path mismatch`);
	assert(
		report.weightsSha256 === protocol.inputs.policy.sha256,
		`${condition}: checkpoint hash mismatch`
	);
	assert(
		report.catalogSha256 === protocol.inputs.catalog.sha256,
		`${condition}: catalog hash mismatch`
	);
	assert(
		report.stalls === 0 && report.stallRate === 0,
		`${condition}: stalled games are forbidden`
	);
	assert(report.performance?.workers === workers, `${condition}: report worker count mismatch`);
	assert(
		finite(report.performance?.wallSeconds) && report.performance.wallSeconds > 0,
		`${condition}: wall time missing`
	);
	assert(
		finite(report.performance?.gamesPerSecond) && report.performance.gamesPerSecond > 0,
		`${condition}: throughput missing`
	);
	assert(
		finite(report.performance?.gameWallMsP50) &&
			report.performance.gameWallMsP50 >= 0 &&
			finite(report.performance?.gameWallMsP95) &&
			report.performance.gameWallMsP95 >= report.performance.gameWallMsP50,
		`${condition}: game latency missing`
	);
	assert(
		report.decode?.policyObsVersion === common.policyObsVersion,
		`${condition}: policy obs version mismatch`
	);
	assert(
		typeof report.decode?.inferenceSocket === 'string' && report.decode.inferenceSocket,
		`${condition}: binary inference socket missing`
	);
	assert(
		report.decode.learnMonsterRewardChoices === common.learnMonsterRewardChoices,
		`${condition}: monster choice decode mismatch`
	);
	assert(
		report.decode.sample === common.sample && report.decode.temperature === common.temperature,
		`${condition}: sampled decode mismatch`
	);
	assert(
		report.inference?.weightsSha256 === protocol.inputs.policy.sha256 &&
			report.inference?.format === protocol.inputs.policy.format &&
			report.inference?.obsDim === protocol.inputs.policy.obsDim &&
			report.inference?.actDim === protocol.inputs.policy.actDim &&
			report.inference?.wire === common.inferenceWire,
		`${condition}: inference provenance mismatch`
	);
	const search = report.performance?.search;
	if (arm.kind === 'raw') {
		assert(
			report.decode.rerank === undefined && report.decode.search === undefined,
			'raw: planner decode is not raw'
		);
		assert(search === undefined, 'raw: planner telemetry unexpectedly exists');
	} else if (arm.kind === 'critic-rerank') {
		assert(
			report.decode.rerank?.policyRankWeight === arm.policyRankWeight,
			`${condition}: rerank weight mismatch`
		);
		assert(report.decode.search === undefined, `${condition}: reranker has search decode`);
		assert(search?.mode === 'critic-rerank', `${condition}: reranker mode telemetry mismatch`);
		assert(
			Number.isSafeInteger(search.decisions) && search.decisions > 0,
			`${condition}: reranker decisions missing`
		);
		assert(search.simulations === 0, `${condition}: reranker unexpectedly simulated`);
	} else {
		const decode = report.decode.search;
		assert(report.decode.rerank === undefined, `${condition}: heuristic has reranker decode`);
		assert(
			decode?.sims === arm.simulations &&
				decode?.horizonRounds === arm.horizonRounds &&
				decode?.objective === 'solo-reach30' &&
				decode?.rollout === 'heuristic' &&
				decode?.frac === protocol.systems.heuristicDecode.frac &&
				decode?.valueWeight === protocol.systems.heuristicDecode.valueWeight &&
				decode?.navTemperature === protocol.systems.heuristicDecode.navTemperature,
			`${condition}: heuristic decode mismatch`
		);
		assert(search?.mode === 'heuristic-batched', `${condition}: heuristic mode telemetry mismatch`);
		assert(
			Number.isSafeInteger(search.decisions) && search.decisions > 0,
			`${condition}: heuristic decisions missing`
		);
		assert(
			search.simulations === search.decisions * arm.simulations,
			`${condition}: heuristic simulation count mismatch`
		);
	}
	if (search) {
		assert(
			Number.isSafeInteger(search.byPhase?.navigation) &&
				Number.isSafeInteger(search.byPhase?.encounter) &&
				search.byPhase.navigation >= 0 &&
				search.byPhase.encounter >= 0 &&
				search.byPhase.navigation + search.byPhase.encounter === search.decisions,
			`${condition}: strategic phase telemetry mismatch`
		);
		assert(
			finite(search.decisionWallMsP50) &&
				search.decisionWallMsP50 >= 0 &&
				finite(search.decisionWallMsP95) &&
				search.decisionWallMsP95 >= search.decisionWallMsP50,
			`${condition}: decision latency telemetry missing`
		);
	}
	assert(
		Array.isArray(report.perGame) && report.perGame.length === protocol.phase2.games,
		`${condition}: per-game row count mismatch`
	);
	const expectedKeys = [
		'cycle',
		'finalAttackDice',
		'finalMaxBarrier',
		'finalSpirits',
		'finalVP',
		'first30Round',
		'guardian',
		'post15VpPerRound',
		'seed',
		'stalled',
		'trueWin'
	].sort();
	const catalog = readJson(protocol.inputs.catalog.path);
	const guardianNames = catalog.guardians.map((guardian) => guardian.name);
	const seeds = new Set();
	const guardian = new Map(guardianNames.map((name) => [name, { games: 0, wins: 0, vp: [] }]));
	for (const row of report.perGame) {
		assert(
			stable(Object.keys(row).sort()) === stable(expectedKeys),
			`${condition}: per-game schema changed`
		);
		assert(Number.isSafeInteger(row.seed), `${condition}: invalid seed`);
		assert(
			row.seed >= protocol.phase2.seed0 && row.seed <= protocol.phase2.seedMax,
			`${condition}: seed outside Phase 2 block`
		);
		assert(!seeds.has(row.seed), `${condition}: duplicate seed ${row.seed}`);
		seeds.add(row.seed);
		const expectedGuardian = guardianNames[row.seed % guardianNames.length];
		assert(row.guardian === expectedGuardian, `${condition}: seed ${row.seed} guardian mismatch`);
		assert(
			row.stalled === false && typeof row.trueWin === 'boolean',
			`${condition}: invalid outcome/stall row`
		);
		validateCycle(row, condition);
		assert(row.trueWin === row.finalVP >= 30, `${condition}: seed ${row.seed} true-win mismatch`);
		const group = guardian.get(row.guardian);
		group.games += 1;
		group.wins += row.trueWin ? 1 : 0;
		group.vp.push(row.finalVP);
	}
	assert(seeds.size === protocol.phase2.games, `${condition}: incomplete seed coverage`);
	for (let seed = protocol.phase2.seed0; seed <= protocol.phase2.seedMax; seed += 1) {
		assert(seeds.has(seed), `${condition}: missing seed ${seed}`);
	}
	const wins = report.perGame.filter((row) => row.trueWin).length;
	assert(report.trueWins === wins, `${condition}: true-win aggregate mismatch`);
	close(report.trueWinRate, wins / report.games, `${condition}: trueWinRate`);
	close(report.vp?.mean, mean(report.perGame.map((row) => row.finalVP)), `${condition}: mean VP`);
	close(
		report.engine?.meanPost15VpPerRound,
		mean(report.perGame.map((row) => row.post15VpPerRound)),
		`${condition}: post-15 rate`
	);
	assert(
		Array.isArray(report.guardianBreakdown) &&
			report.guardianBreakdown.length === guardianNames.length,
		`${condition}: guardian aggregate missing`
	);
	const reportedGuardian = new Map(report.guardianBreakdown.map((row) => [row.guardian, row]));
	for (const [name, values] of guardian) {
		const observed = reportedGuardian.get(name);
		assert(
			observed?.games === values.games && observed?.trueWins === values.wins,
			`${condition}: guardian ${name} count mismatch`
		);
		close(
			observed.trueWinRate,
			values.wins / values.games,
			`${condition}: guardian ${name} win rate`
		);
		close(observed.meanVP, mean(values.vp), `${condition}: guardian ${name} mean VP`);
	}
	return {
		report,
		arm,
		telemetry: {
			plannerMode: arm.kind,
			strategicDecisions: search?.decisions ?? 0,
			strategicSimulations: search?.simulations ?? 0,
			decisionWallMsP50: search?.decisionWallMsP50 ?? null,
			decisionWallMsP95: search?.decisionWallMsP95 ?? null,
			byPhase: search?.byPhase ?? { navigation: 0, encounter: 0 },
			wallSeconds: report.performance.wallSeconds
		}
	};
}

export function validateReplayReport(context, condition, replayPath, primaryReport) {
	const replay = readJson(replayPath);
	const audit = context.strengthProtocol.phase2.replayAudit;
	assert(replay.schemaVersion === 'solo-heldout-v2', `${condition}: replay schema mismatch`);
	assert(
		replay.sourceCommit === context.lock.implementationCommit,
		`${condition}: replay source commit mismatch`
	);
	assert(
		replay.seed0 === audit.seed0 &&
			replay.games === audit.games &&
			replay.seed0 + replay.games - 1 === audit.seedMax,
		`${condition}: replay seed range mismatch`
	);
	for (const field of [
		'weights',
		'weightsSha256',
		'catalog',
		'catalogSha256',
		'maxRounds',
		'maxStatusLevel'
	]) {
		assert(replay[field] === primaryReport[field], `${condition}: replay ${field} mismatch`);
	}
	assert(
		stable(replay.decode) === stable(primaryReport.decode),
		`${condition}: replay decode mismatch`
	);
	assert(
		stable(replay.inference) === stable(primaryReport.inference),
		`${condition}: replay inference provenance mismatch`
	);
	assert(
		replay.performance?.workers === audit.workers,
		`${condition}: replay worker count mismatch`
	);
	assert(replay.stalls === 0 && replay.stallRate === 0, `${condition}: replay stalled`);
	assert(
		Array.isArray(replay.perGame) && replay.perGame.length === audit.games,
		`${condition}: replay per-game row count mismatch`
	);
	const expectedRows = new Map(
		primaryReport.perGame.slice(0, audit.games).map((row) => [row.seed, row])
	);
	const replayRows = new Map(replay.perGame.map((row) => [row.seed, row]));
	assert(
		expectedRows.size === audit.games && replayRows.size === audit.games,
		`${condition}: replay seed coverage is duplicated or incomplete`
	);
	let mismatches = 0;
	for (const [seed, expectedRow] of expectedRows) {
		if (stable(replayRows.get(seed)) !== stable(expectedRow)) mismatches += 1;
	}
	assert(
		mismatches === 0,
		`${condition}: replay differs from the primary run on ${mismatches} games`
	);
	assert(
		replay.trueWins === replay.perGame.filter((row) => row.trueWin).length,
		`${condition}: replay true-win aggregate mismatch`
	);
	return { report: replay, mismatches };
}

function validateLaunch(context, args, arm, report) {
	const launch = readJson(args.launch);
	const attempt = Number(args.attempt);
	assert(launch.schemaVersion === 'arc-v34-phase2-launch-v1', 'Phase 2 launch schema mismatch');
	assert(
		launch.condition === args.condition && launch.attempt === attempt,
		'Phase 2 launch condition/attempt mismatch'
	);
	assert(launch.workers === Number(args.workers), 'Phase 2 launch worker mismatch');
	assert(
		context.strengthProtocol.runtime.eligibleGpus.includes(launch.gpu),
		'Phase 2 launch GPU is not eligible'
	);
	assert(
		launch.gpu !== context.strengthProtocol.runtime.excludedGpu,
		'Phase 2 launch uses the excluded GPU'
	);
	assert(
		launch.sourceCommit === context.lock.implementationCommit,
		'Phase 2 launch source commit mismatch'
	);
	assert(
		launch.watchdogSeconds === 23400 && launch.watchdogKillAfterSeconds === 60,
		'Phase 2 launch watchdog contract mismatch'
	);
	assert(
		launch.strengthLock?.path === relative(context.lockPath) &&
			launch.strengthLock?.sha256 === sha256(context.lockPath),
		'Phase 2 launch strength-lock mismatch'
	);
	assert(
		launch.seed0 === context.protocol.phase2.seed0 &&
			launch.games === context.protocol.phase2.games &&
			launch.seedMax === context.protocol.phase2.seedMax,
		'Phase 2 launch seed range mismatch'
	);
	assert(
		stable(launch.commonDecode) === stable(context.strengthProtocol.commonDecode),
		'Phase 2 launch decode mismatch'
	);
	assert(stable(launch.arm) === stable(arm), 'Phase 2 launch arm mismatch');
	for (const [name, expected] of [
		['checkpoint', context.protocol.inputs.policy],
		['catalog', context.protocol.inputs.catalog]
	]) {
		assert(
			launch[name]?.path === expected.path && launch[name]?.sha256 === expected.sha256,
			`Phase 2 launch ${name} mismatch`
		);
	}
	assert(
		Array.isArray(launch.evaluatorArgs) && launch.evaluatorArgs.length > 0,
		'Phase 2 launch argv missing'
	);
	const argv = launch.evaluatorArgs;
	const value = (flag) => {
		const indexes = argv.flatMap((entry, index) => (entry === flag ? [index] : []));
		assert(
			indexes.length === 1 && indexes[0] + 1 < argv.length,
			`Phase 2 launch ${flag} missing or duplicated`
		);
		return argv[indexes[0] + 1];
	};
	for (const flag of ['--sample', '--include-games']) {
		assert(
			argv.filter((entry) => entry === flag).length === 1,
			`Phase 2 launch ${flag} missing or duplicated`
		);
	}
	const socket = value('--infer-socket');
	assert(
		typeof socket === 'string' && socket.length > 0,
		'Phase 2 launch inference socket missing'
	);
	assert(
		report.decode.inferenceSocket === socket,
		'Phase 2 report/launch inference socket mismatch'
	);
	let armArgs = [];
	if (arm.kind === 'critic-rerank') {
		armArgs = ['--rerank-policy-weight', String(arm.policyRankWeight)];
	} else if (arm.kind === 'heuristic-batched') {
		armArgs = [
			'--search-sims',
			String(arm.simulations),
			'--search-horizon',
			String(arm.horizonRounds),
			'--search-objective',
			'solo-reach30',
			'--search-rollout',
			'heuristic',
			'--search-frac',
			String(context.protocol.systems.heuristicDecode.frac),
			'--search-value-weight',
			String(context.protocol.systems.heuristicDecode.valueWeight),
			'--search-nav-temperature',
			String(context.protocol.systems.heuristicDecode.navTemperature)
		];
	}
	const expectedArgv = [
		'scripts/evaluate-solo-checkpoint.mjs',
		'--weights',
		context.protocol.inputs.policy.path,
		'--catalog',
		context.protocol.inputs.catalog.path,
		'--source-commit',
		context.lock.implementationCommit,
		'--infer-socket',
		socket,
		'--policy-obs-version',
		String(context.strengthProtocol.commonDecode.policyObsVersion),
		'--games',
		String(context.protocol.phase2.games),
		'--workers',
		String(args.workers),
		'--seed0',
		String(context.protocol.phase2.seed0),
		'--max-rounds',
		String(context.strengthProtocol.commonDecode.maxRounds),
		'--max-status-level',
		String(context.strengthProtocol.commonDecode.maxStatusLevel),
		'--sample',
		'--temperature',
		String(context.strengthProtocol.commonDecode.temperature),
		'--include-games',
		...armArgs,
		'--out',
		relative(args.report)
	];
	assert(stable(argv) === stable(expectedArgv), 'Phase 2 launch evaluator argv mismatch');
	const replayArgv = [...expectedArgv];
	const replaceValue = (flag, expected) => {
		const index = replayArgv.indexOf(flag);
		assert(index >= 0 && replayArgv[index + 1] !== undefined, `replay ${flag} is missing`);
		replayArgv[index + 1] = String(expected);
	};
	replaceValue('--games', context.strengthProtocol.phase2.replayAudit.games);
	replaceValue('--workers', context.strengthProtocol.phase2.replayAudit.workers);
	replaceValue('--out', relative(args['replay-report']));
	assert(
		stable(launch.replayEvaluatorArgs) === stable(replayArgv),
		'Phase 2 launch replay evaluator argv mismatch'
	);
	if (attempt === 1) {
		assert(launch.retryJustification === null, 'attempt 1 launch has retry justification');
	} else {
		assert(args.justification, 'attempt 2 launch lacks retry justification');
		assert(
			launch.retryJustification?.path === relative(args.justification) &&
				launch.retryJustification?.sha256 === sha256(args.justification),
			'attempt 2 launch retry justification mismatch'
		);
	}
	return launch;
}

function completionValue(context, args) {
	const validated = validatePhase2Report(
		context,
		args.condition,
		Number(args.workers),
		args.report
	);
	assert(
		readFileSync(args['replay-exit-code'], 'utf8').trim() === '0',
		'condition replay process did not exit successfully'
	);
	const replay = validateReplayReport(
		context,
		args.condition,
		args['replay-report'],
		validated.report
	);
	const attempt = Number(args.attempt);
	assert(attempt === 1 || attempt === 2, 'attempt must be 1 or 2');
	if (attempt === 1) assert(!args.justification, 'attempt 1 must not have a retry justification');
	assert(
		readFileSync(args['exit-code'], 'utf8').trim() === '0',
		'condition process did not exit successfully'
	);
	assert(
		/^\d+$/.test(readFileSync(args['launch-pid'], 'utf8').trim()),
		'condition evaluator PID is invalid'
	);
	const inferLog = readFileSync(args['infer-log'], 'utf8');
	const inferLines = inferLog.split(/\r?\n/);
	const servingLines = inferLines.filter((line) => line.startsWith('[infer] serving ')).length;
	const shutdownLines = inferLines.filter((line) => line === '[infer] shut down').length;
	const reloadLines = inferLines.filter((line) => /\[infer\] reloaded weights/.test(line)).length;
	const errorLines = inferLines.filter((line) =>
		/(Traceback|reload FAILED|RuntimeError|Exception)/.test(line)
	).length;
	let requests = 0;
	let rows = 0;
	let batches = 0;
	for (const line of inferLines) {
		const match = line.match(/\[infer\] reqs=(\d+) rows=(\d+) batches=(\d+)/);
		if (!match) continue;
		requests += Number(match[1]);
		rows += Number(match[2]);
		batches += Number(match[3]);
	}
	assert(
		servingLines === 1 &&
			shutdownLines === 1 &&
			reloadLines === 0 &&
			errorLines === 0 &&
			requests > 0 &&
			rows >= requests &&
			batches > 0,
		'condition inference server log is incomplete or contains an error'
	);
	validateLaunch(context, args, validated.arm, validated.report);
	const strengthPreflightPath = `${EXPERIMENT}/artifacts/strength-preflight/result.json`;
	const strengthPreflight = readJson(strengthPreflightPath);
	assert(
		strengthPreflight.schemaVersion === 'arc-v34-strength-preflight-evidence-v1' &&
			strengthPreflight.passed === true &&
			strengthPreflight.checks?.vitest?.exitCode === 0 &&
			strengthPreflight.checks?.determinization?.exitCode === 0 &&
			strengthPreflight.checks?.replayDeterminism?.exitCode === 0,
		'Phase 2 information-safety preflight evidence is missing or failed'
	);
	const inputFiles = {
		report: fileRecord(args.report),
		replayReport: fileRecord(args['replay-report']),
		replayStdout: fileRecord(args['replay-stdout']),
		replayStderr: fileRecord(args['replay-stderr']),
		replayExitCode: fileRecord(args['replay-exit-code']),
		inferLog: fileRecord(args['infer-log']),
		stdout: fileRecord(args.stdout),
		stderr: fileRecord(args.stderr),
		launch: fileRecord(args.launch),
		launchPid: fileRecord(args['launch-pid']),
		exitCode: fileRecord(args['exit-code'])
	};
	if (attempt === 2) {
		assert(args.justification, 'attempt 2 requires an immutable retry justification');
		const justification = readJson(args.justification);
		const retryableCodes = { 'server-start': 90, 'process-interrupted': 92 };
		assert(
			justification.schemaVersion === 'arc-v34-phase2-retry-justification-v1' &&
				justification.condition === args.condition &&
				justification.attempt === 2 &&
				justification.identicalSeedRetry === true &&
				justification.outcomesInspected === false &&
				justification.infrastructureAttributed === true &&
				justification.attempt1ReportExisted === false &&
				Object.hasOwn(retryableCodes, justification.reasonCode) &&
				justification.sourceCommit === context.lock.implementationCommit &&
				justification.strengthLockSha256 === sha256(context.lockPath) &&
				justification.seed0 === context.protocol.phase2.seed0 &&
				justification.games === context.protocol.phase2.games &&
				justification.seedMax === context.protocol.phase2.seedMax &&
				typeof justification.reason === 'string' &&
				justification.reason.length > 0,
			'attempt 2 retry justification is invalid'
		);
		assert(
			/(infra|server|socket|cuda|gpu|oom|process|signal|host|machine|power|filesystem|disk|network|runtime|interrupt|service)/i.test(
				justification.reason
			) &&
				!/(outcome|result|win|victor|score|\bvp\b|stall|malform|missing seed|duplicate|provenance|replay|safety|integrity|weak|strength)/i.test(
					justification.reason
				),
			'attempt 2 retry reason is not outcome-blind infrastructure evidence'
		);
		const failurePath = verifyFileRecord(
			justification.failureEvidence,
			'attempt 1 failure evidence'
		);
		const failure = readJson(failurePath);
		assert(
			failure.schemaVersion === 'arc-v34-phase2-attempt-failure-v1' &&
				failure.condition === args.condition &&
				failure.attempt === 1 &&
				failure.runtimeError === true &&
				failure.reportExists === false &&
				failure.outcomesInspected === false &&
				failure.sourceCommit === context.lock.implementationCommit &&
				failure.strengthLockSha256 === sha256(context.lockPath) &&
				failure.reasonCode === justification.reasonCode &&
				failure.exitCode === retryableCodes[justification.reasonCode],
			'attempt 1 failure evidence is not a retry-eligible infrastructure failure'
		);
		assert(
			!existsSync(path.join(path.dirname(failurePath), 'report.json')),
			'attempt 1 outcome report appeared after retry justification'
		);
		assert(
			stable(Object.keys(failure.files ?? {}).sort()) ===
				stable(['exitCode', 'inferLog', 'launch', 'launchPid', 'stderr', 'stdout']),
			'attempt 1 failure evidence file inventory mismatch'
		);
		for (const [name, record] of Object.entries(failure.files ?? {})) {
			verifyFileRecord(record, `attempt 1 failure input ${name}`);
		}
		inputFiles.retryJustification = fileRecord(args.justification);
		inputFiles.retryFailureEvidence = fileRecord(failurePath);
	}
	return {
		schemaVersion: 'arc-v34-phase2-condition-v1',
		valid: true,
		immutable: true,
		condition: args.condition,
		attempt,
		workers: Number(args.workers),
		arm: validated.arm,
		sourceCommit: context.lock.implementationCommit,
		seed0: context.protocol.phase2.seed0,
		games: context.protocol.phase2.games,
		seedMax: context.protocol.phase2.seedMax,
		commonDecode: context.strengthProtocol.commonDecode,
		checkpoint: {
			path: context.protocol.inputs.policy.path,
			sha256: context.protocol.inputs.policy.sha256
		},
		catalog: {
			path: context.protocol.inputs.catalog.path,
			sha256: context.protocol.inputs.catalog.sha256
		},
		inference: validated.report.inference,
		telemetry: validated.telemetry,
		stalls: 0,
		integrity: {
			informationSafetyFailures:
				Number(strengthPreflight.checks.vitest.exitCode !== 0) +
				Number(strengthPreflight.checks.determinization.exitCode !== 0),
			replayMismatches: replay.mismatches,
			servingErrors: errorLines,
			provenanceMismatches: reloadLines,
			derivedOnlyAfterStrictValidation: true,
			evidence: {
				informationSafety: {
					strengthPreflight: fileRecord(strengthPreflightPath),
					vitestExitCode: strengthPreflight.checks.vitest.exitCode,
					determinizationExitCode: strengthPreflight.checks.determinization.exitCode
				},
				replay: {
					seed0: context.strengthProtocol.phase2.replayAudit.seed0,
					games: context.strengthProtocol.phase2.replayAudit.games,
					workers: context.strengthProtocol.phase2.replayAudit.workers,
					exactPerGameEquality: true,
					preflightExitCode: strengthPreflight.checks.replayDeterminism.exitCode,
					mismatches: replay.mismatches
				},
				serving: {
					servingLines,
					shutdownLines,
					errorLines,
					requests,
					rows,
					batches
				},
				provenance: {
					acceptedGameSummariesChecked: validated.report.perGame.length,
					evaluatorCrossGameHandshakeInvariant: true,
					fixedInferenceProcess: true,
					reloadLines
				}
			}
		},
		inputs: {
			strengthLock: fileRecord(context.lockPath),
			baseProtocol: fileRecord(DEFAULT_PROTOCOL),
			strengthProtocol: fileRecord(DEFAULT_STRENGTH_PROTOCOL),
			systemsEligibility: fileRecord(`${EXPERIMENT}/artifacts/systems-eligibility.json`),
			phase2Authorization: fileRecord(`${EXPERIMENT}/artifacts/phase2-authorization.json`),
			strengthPreflight: fileRecord(strengthPreflightPath),
			...inputFiles
		}
	};
}

function writeImmutable(out, value) {
	const resolved = path.resolve(out);
	const sidecar = `${resolved}.sha256`;
	assert(
		!existsSync(resolved) && !existsSync(sidecar),
		`refusing to overwrite immutable output ${out}`
	);
	writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
	writeFileSync(sidecar, `${sha256(resolved)}  ${path.basename(resolved)}\n`, { flag: 'wx' });
	chmodSync(resolved, 0o444);
	chmodSync(sidecar, 0o444);
}

function verifyCompletion(manifestPath, lockPath) {
	const context = verifyStrengthLock(lockPath);
	const manifest = readJson(manifestPath);
	assert(
		manifest.schemaVersion === 'arc-v34-phase2-condition-v1' &&
			manifest.valid === true &&
			manifest.immutable === true,
		'invalid V34 Phase 2 completion manifest'
	);
	const sidecar = `${manifestPath}.sha256`;
	assert(existsSync(sidecar), 'V34 Phase 2 completion sidecar is missing');
	assert(
		readFileSync(sidecar, 'utf8').trim() ===
			`${sha256(manifestPath)}  ${path.basename(manifestPath)}`,
		'V34 Phase 2 completion sidecar mismatch'
	);
	for (const [name, record] of Object.entries(manifest.inputs ?? {}))
		verifyFileRecord(record, `completion input ${name}`);
	const recomputed = completionValue(context, {
		condition: manifest.condition,
		attempt: String(manifest.attempt),
		workers: String(manifest.workers),
		report: resolveRecord(manifest.inputs.report.path),
		'replay-report': resolveRecord(manifest.inputs.replayReport.path),
		'replay-stdout': resolveRecord(manifest.inputs.replayStdout.path),
		'replay-stderr': resolveRecord(manifest.inputs.replayStderr.path),
		'replay-exit-code': resolveRecord(manifest.inputs.replayExitCode.path),
		'infer-log': resolveRecord(manifest.inputs.inferLog.path),
		stdout: resolveRecord(manifest.inputs.stdout.path),
		stderr: resolveRecord(manifest.inputs.stderr.path),
		launch: resolveRecord(manifest.inputs.launch.path),
		'launch-pid': resolveRecord(manifest.inputs.launchPid.path),
		'exit-code': resolveRecord(manifest.inputs.exitCode.path),
		...(manifest.inputs.retryJustification
			? { justification: resolveRecord(manifest.inputs.retryJustification.path) }
			: {})
	});
	assert(
		stable(recomputed) === stable(manifest),
		'V34 Phase 2 completion manifest content mismatch'
	);
	return manifest;
}

function main() {
	process.chdir(repo);
	const { values: args, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			condition: { type: 'string' },
			attempt: { type: 'string' },
			workers: { type: 'string' },
			report: { type: 'string' },
			'replay-report': { type: 'string' },
			'replay-stdout': { type: 'string' },
			'replay-stderr': { type: 'string' },
			'replay-exit-code': { type: 'string' },
			'infer-log': { type: 'string' },
			stdout: { type: 'string' },
			stderr: { type: 'string' },
			launch: { type: 'string' },
			'launch-pid': { type: 'string' },
			'exit-code': { type: 'string' },
			justification: { type: 'string' },
			out: { type: 'string' },
			manifest: { type: 'string' },
			'strength-lock': { type: 'string', default: DEFAULT_LOCK }
		}
	});
	const command = positionals[0];
	if (command === 'verify-lock') {
		const context = verifyStrengthLock(args['strength-lock']);
		console.log(
			JSON.stringify({
				schemaVersion: 'arc-v34-strength-lock-verification-v1',
				valid: true,
				implementationCommit: context.lock.implementationCommit
			})
		);
		return;
	}
	if (command === 'verify') {
		assert(args.manifest, '--manifest is required');
		const manifest = verifyCompletion(path.resolve(args.manifest), args['strength-lock']);
		console.log(
			JSON.stringify({
				schemaVersion: 'arc-v34-phase2-condition-verification-v1',
				valid: true,
				condition: manifest.condition,
				attempt: manifest.attempt
			})
		);
		return;
	}
	if (command !== 'record')
		throw new Error('usage: record-v34-phase2-condition.mjs verify-lock|verify|record [options]');
	for (const name of [
		'condition',
		'attempt',
		'workers',
		'report',
		'replay-report',
		'replay-stdout',
		'replay-stderr',
		'replay-exit-code',
		'infer-log',
		'stdout',
		'stderr',
		'launch',
		'launch-pid',
		'exit-code',
		'out'
	]) {
		assert(args[name], `--${name} is required`);
	}
	const context = verifyStrengthLock(args['strength-lock']);
	const value = completionValue(context, args);
	writeImmutable(args.out, value);
	console.log(JSON.stringify(value, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

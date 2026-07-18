#!/usr/bin/env node
/**
 * Human benchmark harness — measures a bot policy against Michael's real recorded games.
 *
 * Reconstructs one of Michael's exported human-vs-bot games (ml/human_reference/db_games/<CODE>)
 * — same engine seed, same per-seat guardian assignment, same 4-player table — then seats a
 * CANDIDATE policy in Michael's seat (Red) and a fixed OPPONENT policy in the other three seats,
 * and asks: can the candidate match Michael's pace/score?
 *
 * The candidate is either a served v2 checkpoint (RemotePolicy over ml/infer_server.py) or, for
 * GPU-free smoke tests, a heuristic profile. Opponents are a frozen MLP checkpoint (the
 * era-appropriate production bot) or a heuristic profile.
 *
 *   # served v2 candidate vs the v13-2 production champion (needs a GPU-backed infer socket):
 *   node scripts/human-benchmark.mjs --game VH8P2C \
 *     --infer-socket /tmp/arc-infer.sock --policy-obs-version 2 --temperature 0.55 \
 *     --opponent-weights ml/champions/v13-2/main-0-gen44.json --repeats 32 --out ml/heldout/humanbench-VH8P2C.json
 *
 *   # GPU-free smoke test (heuristic candidate vs heuristic opponents):
 *   node scripts/human-benchmark.mjs --game VH8P2C \
 *     --candidate heuristic:hard --opponent-weights heuristic:medium --repeats 2
 *
 * This is a held-out DIAGNOSTIC benchmark. Michael's recorded commands are never emitted as
 * training data; only his outcome trajectory (finalVP / vpAfterRound / round-of-30) is read for
 * comparison. Keep disjoint from PPO training and evaluation.
 */
import { createJiti } from 'jiti';
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const { values: args } = parseArgs({
	options: {
		game: { type: 'string' },
		'db-games-dir': { type: 'string', default: 'ml/human_reference/db_games' },
		catalog: { type: 'string', default: 'ml/catalog.json' },
		// Candidate: exactly one of --infer-socket (served v2/v1) or --candidate heuristic:<profile>.
		'infer-socket': { type: 'string' },
		'policy-obs-version': { type: 'string', default: '2' },
		candidate: { type: 'string' },
		temperature: { type: 'string', default: '0.55' },
		// Opponents (the other 3 seats): a weights file or "heuristic:<profile>".
		'opponent-weights': { type: 'string', default: 'ml/champions/v13-2/main-0-gen44.json' },
		'opponent-temperature': { type: 'string', default: '0' },
		repeats: { type: 'string', default: '32' },
		'extra-rounds': { type: 'string', default: '5' },
		quiet: { type: 'boolean', default: false },
		out: { type: 'string' },
		help: { type: 'boolean', default: false }
	}
});

if (args.help || !args.game) {
	console.log(
		'usage: node scripts/human-benchmark.mjs --game CODE ' +
			'( --infer-socket SOCK [--policy-obs-version 2] | --candidate heuristic:PROFILE ) ' +
			'[--temperature T] [--opponent-weights FILE|heuristic:PROFILE] [--opponent-temperature T] ' +
			'[--repeats N] [--extra-rounds K] [--db-games-dir DIR] [--catalog FILE] [--out FILE] [--quiet]'
	);
	process.exit(args.help ? 0 : 1);
}

const integer = (value, label, { min = 1 } = {}) => {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed < min)
		throw new Error(`${label} must be an integer >= ${min}`);
	return parsed;
};
const nonNegFloat = (value, label) => {
	const parsed = Number.parseFloat(value);
	if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative number`);
	return parsed;
};
const mean = (values) =>
	values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const HEURISTIC = /^heuristic:(.+)$/;

// ── Validate the candidate / opponent selectors ────────────────────────────────────────────
const candidateHeuristic = args.candidate ? HEURISTIC.exec(args.candidate)?.[1] : null;
if (args.candidate && !candidateHeuristic) {
	throw new Error('--candidate must be of the form "heuristic:<profile>" (else use --infer-socket)');
}
if ((args['infer-socket'] ? 1 : 0) + (args.candidate ? 1 : 0) !== 1) {
	throw new Error('provide exactly one of --infer-socket or --candidate heuristic:<profile>');
}
const policyObsVersion = Number.parseInt(args['policy-obs-version'], 10);
if (policyObsVersion !== 1 && policyObsVersion !== 2) {
	throw new Error('--policy-obs-version must be 1 or 2');
}
// --policy-obs-version only applies to a served candidate; a heuristic candidate ignores it.
if (policyObsVersion === 2 && !args['infer-socket'] && args.candidate) {
	console.warn(
		'[human-benchmark] NOTE: --policy-obs-version is ignored for a heuristic candidate.'
	);
}
const temperature = nonNegFloat(args.temperature, '--temperature');
if (args['infer-socket'] && temperature <= 0) {
	throw new Error('--temperature must be positive for a sampled served candidate');
}
const opponentHeuristic = HEURISTIC.exec(args['opponent-weights'])?.[1] ?? null;
const opponentTemperature = nonNegFloat(args['opponent-temperature'], '--opponent-temperature');
const repeats = integer(args.repeats, '--repeats');
const extraRounds = integer(args['extra-rounds'], '--extra-rounds', { min: 0 });

// ── Load the recorded game export ──────────────────────────────────────────────────────────
const gamePath = path.resolve(args['db-games-dir'], `${args.game}.json`);
const gameExport = JSON.parse(readFileSync(gamePath, 'utf8'));
const engineSeed = gameExport.replay?.engineSeed;
if (!Number.isSafeInteger(engineSeed)) {
	throw new Error(`export ${args.game} has no integer replay.engineSeed`);
}
const playerCount = gameExport.playerCount;
const roundsPlayed = gameExport.roundsPlayed;
const humanSeat = gameExport.human?.seat;
if (!humanSeat) throw new Error(`export ${args.game} has no human.seat`);
// seatColor -> guardian, from the authoritative per-seat records.
const guardianBySeatColor = new Map(
	gameExport.seats.map((s) => [s.seatColor, s.guardian])
);
const michaelVpAfterRound = gameExport.human.vpAfterRound ?? [];
const michaelFinalVP = gameExport.human.finalVP ?? michaelVpAfterRound.at(-1) ?? null;
// Michael's round-of-30 (1-based index of the first recorded round at which his VP >= 30).
const michaelRoundOf30 = (() => {
	const idx = michaelVpAfterRound.findIndex((vp) => vp >= 30);
	return idx < 0 ? null : idx + 1;
})();

// ── Load the catalog (current catalog; exports lack the historical catalog SHA) ─────────────
const catalogPath = path.resolve(args.catalog);
const catalogBytes = readFileSync(catalogPath);
const catalog = JSON.parse(catalogBytes.toString('utf8'));
if (gameExport.replay?.catalogSha256 == null) {
	console.warn(
		`[human-benchmark] WARNING: export ${args.game} did not persist a catalog SHA; ` +
			`reconstructing with the CURRENT catalog (${path.relative(root, catalogPath)}, ` +
			`sha256=${sha256(catalogBytes).slice(0, 12)}…). Guardian identities and seed are exact, ` +
			`but per-guardian starting spirits/relics may differ from the live deploy at game time.`
	);
}

// ── jiti-load the TS play modules ──────────────────────────────────────────────────────────
const jiti = createJiti(import.meta.url, { alias: { $lib: path.join(root, 'src', 'lib') } });
const { playRecordingGame } = await jiti.import(
	path.join(root, 'src', 'lib', 'play', 'ml', 'driver.ts')
);
const { RemotePolicy, asNeuralPolicy } = await jiti.import(
	path.join(root, 'src', 'lib', 'play', 'ml', 'inferenceClient.ts')
);
const { loadPolicyForEval } = await jiti.import(
	path.join(root, 'src', 'lib', 'play', 'ml', 'nodeIo.ts')
);
const { BOT_PROFILES, profileFor } = await jiti.import(
	path.join(root, 'src', 'lib', 'play', 'server', 'botPolicy.ts')
);
const { SEAT_COLORS, MAX_ROUNDS } = await jiti.import(
	path.join(root, 'src', 'lib', 'play', 'types.ts')
);
const { OBS_DIM } = await jiti.import(path.join(root, 'src', 'lib', 'play', 'ml', 'encode.ts'));
const { obsV2Meta } = await jiti.import(path.join(root, 'src', 'lib', 'play', 'ml', 'encodeV2.ts'));

// profileFor silently falls back to a random profile for unknown names; gate on the real table so
// we never quietly benchmark the wrong bot.
const requireProfile = (name, flag) => {
	if (name !== 'medium' && !BOT_PROFILES[name]) {
		throw new Error(`${flag}: unknown heuristic profile '${name}'`);
	}
	return profileFor(name);
};

// ── Reconstruct the seating (SEAT_COLORS order is the engine's fixed claim order) ────────────
const seats = SEAT_COLORS.slice(0, playerCount);
if (!seats.includes(humanSeat)) {
	throw new Error(`human seat ${humanSeat} is not among the first ${playerCount} seats`);
}
const candidateSeat = humanSeat;
const opponentSeats = seats.filter((s) => s !== candidateSeat);
// guardianNames[i] is applied to seats[i] by the driver, so build it in SEAT_COLORS order.
const guardianNames = seats.map((seat) => {
	const guardian = guardianBySeatColor.get(seat);
	if (!guardian) throw new Error(`export ${args.game} has no guardian for seat ${seat}`);
	if (!catalog.guardians.some((g) => g.name === guardian)) {
		throw new Error(`guardian '${guardian}' (seat ${seat}) is not in the current catalog`);
	}
	return guardian;
});

// The engine hard-caps at MAX_ROUNDS; honor the "recorded rounds + extra" cap within that bound.
const effectiveMaxRounds = Math.min(roundsPlayed + extraRounds, MAX_ROUNDS);

// ── Candidate policy ───────────────────────────────────────────────────────────────────────
let candidatePolicy = null; // NeuralPolicy for served candidate; null for heuristic candidate
let candidateProfileName = null; // profile name for heuristic candidate; null for served
let remote = null;
let candidateRef;
let inferenceInfo = null;
if (args['infer-socket']) {
	remote = new RemotePolicy(args['infer-socket'], {
		expectObsDim: policyObsVersion === 2 ? obsV2Meta(catalog).flatLength : OBS_DIM
	});
	candidatePolicy = asNeuralPolicy(remote);
	candidateRef = `socket:${remote.info.weights}`;
	inferenceInfo = {
		socket: args['infer-socket'],
		weights: remote.info.weights,
		weightsSha256: remote.info.weights_sha256,
		format: remote.info.format,
		obsDim: remote.info.obs_dim,
		actDim: remote.info.act_dim
	};
} else {
	candidateProfileName = candidateHeuristic;
	requireProfile(candidateProfileName, '--candidate');
	candidateRef = `heuristic:${candidateProfileName}`;
}

// ── Opponent policy (shared across the other 3 seats) ───────────────────────────────────────
let opponentPolicy = null; // NeuralPolicy for weights opponents; null for heuristic opponents
let opponentProfile = null; // BotProfile for heuristic opponents
let opponentRef;
if (opponentHeuristic) {
	opponentProfile = requireProfile(opponentHeuristic, '--opponent-weights');
	opponentRef = `heuristic:${opponentHeuristic}`;
} else {
	const opponentWeightsPath = path.resolve(args['opponent-weights']);
	opponentPolicy = loadPolicyForEval(opponentWeightsPath); // throws on obs/act-dim mismatch
	opponentRef = path.relative(root, opponentWeightsPath);
}

// ── Build the per-seat driver config for one repeat ─────────────────────────────────────────
const candidateLabel = candidateRef;
const runRepeat = (seed) => {
	const neuralSeats = [];
	const opponentPolicies = {};
	// profiles[] indexes seats in SEAT_COLORS order; used for heuristic seats and as the neural
	// unstick fallback.
	const profiles = seats.map((seat) => {
		if (seat === candidateSeat) {
			if (candidatePolicy) {
				neuralSeats.push(seat);
				return profileFor('medium'); // unstick fallback only, as in the gauntlet
			}
			return requireProfile(candidateProfileName, '--candidate');
		}
		if (opponentPolicy) {
			neuralSeats.push(seat);
			opponentPolicies[seat] = opponentPolicy;
			return profileFor('medium'); // unstick fallback only
		}
		return opponentProfile;
	});
	// `policy` must be non-null when any seat is neural. The candidate policy is the learner
	// policy; opponent seats always resolve through opponentPolicies (the driver wraps only the
	// learner for v2). When only opponents are neural, pass the opponent policy so the gate passes.
	const policy = candidatePolicy ?? (neuralSeats.length ? opponentPolicy : undefined);

	const r = playRecordingGame(catalog, {
		seed,
		profiles,
		guardianNames,
		maxRounds: effectiveMaxRounds,
		policy,
		neuralSeats,
		selection: 'hybrid',
		// Candidate sampling temperature (served candidate only; heuristic candidate ignores it).
		...(candidatePolicy && temperature > 0 ? { sample: true, temperature } : {}),
		opponentPolicies,
		...(opponentTemperature > 0 ? { opponentTemperature } : {}),
		recordSeats: [],
		// Served v2 candidate plays on flat v2 obs; opponents stay in-process v1.
		...(policyObsVersion === 2 ? { policyObsVersion: 2 } : {})
	});

	const finalVPBySeat = Object.fromEntries(seats.map((seat) => [seat, r.finalVP[seat] ?? 0]));
	const candVP = finalVPBySeat[candidateSeat];
	const placement = 1 + opponentSeats.filter((s) => finalVPBySeat[s] > candVP).length;
	const cycle = r.cycleBySeat[candidateSeat];
	// cycle.vpAfterRound is a sparse map keyed by the driver's CYCLE_ROUNDS milestones ([8,12,16,20]).
	const vpAfterRound = Object.fromEntries(
		Object.entries(cycle?.vpAfterRound ?? {})
			.map(([round, vp]) => [Number(round), vp])
			.sort((a, b) => a[0] - b[0])
	);
	return {
		seed,
		finalVP: finalVPBySeat,
		winner: r.winnerSeat,
		finished: r.finished,
		stalled: r.stalled,
		rounds: r.rounds,
		candidatePlacement: placement,
		candidateWon: r.winnerSeat === candidateSeat,
		candidateFinalVP: candVP,
		candidateRoundOf30: cycle?.first30Round ?? null,
		candidateVpAfterRound: vpAfterRound
	};
};

// ── Play the repeats (repeat 0 uses the exact recorded seed; k>0 uses seed+k) ────────────────
const perRepeat = [];
try {
	for (let k = 0; k < repeats; k += 1) {
		perRepeat.push({ repeat: k, ...runRepeat(engineSeed + k) });
	}
} finally {
	remote?.close();
}

// ── Aggregate ────────────────────────────────────────────────────────────────────────────
const wins = perRepeat.filter((r) => r.candidateWon).length;
const reachedRoundsOf30 = perRepeat
	.map((r) => r.candidateRoundOf30)
	.filter((v) => v !== null);
const winRate = wins / repeats;
const meanVP = mean(perRepeat.map((r) => r.candidateFinalVP));
const meanRoundOf30 = reachedRoundsOf30.length ? mean(reachedRoundsOf30) : null;
const meanPlacement = mean(perRepeat.map((r) => r.candidatePlacement));
const reach30Rate = reachedRoundsOf30.length / repeats;

const comparison = {
	michael: {
		seat: candidateSeat,
		guardian: guardianBySeatColor.get(candidateSeat),
		finalVP: michaelFinalVP,
		roundOf30: michaelRoundOf30,
		vpAfterRound: michaelVpAfterRound,
		recordedRounds: roundsPlayed
	},
	// Faster or equal pace: candidate's mean round-of-30 <= Michael's (only meaningful if the
	// candidate reaches 30 at all).
	candidateBeatsMichaelPace:
		meanRoundOf30 !== null && michaelRoundOf30 !== null ? meanRoundOf30 <= michaelRoundOf30 : false,
	candidateMatchesVP: meanVP !== null && michaelFinalVP !== null ? meanVP >= michaelFinalVP : false
};

const report = {
	schemaVersion: 'arc-human-benchmark-v1',
	diagnosticOnly: true,
	trainingUseProhibited: true,
	game: args.game,
	gameExport: path.relative(root, gamePath),
	createdAt: new Date().toISOString(),
	setup: {
		engineSeed,
		playerCount,
		candidateSeat,
		opponentSeats,
		seatOrder: seats,
		guardianBySeat: Object.fromEntries(seats.map((seat, i) => [seat, guardianNames[i]])),
		recordedRounds: roundsPlayed,
		maxRounds: effectiveMaxRounds,
		...(effectiveMaxRounds !== roundsPlayed + extraRounds
			? { requestedMaxRounds: roundsPlayed + extraRounds, engineMaxRounds: MAX_ROUNDS }
			: {}),
		catalog: path.relative(root, catalogPath),
		catalogSha256: sha256(catalogBytes),
		catalogShaFromExport: gameExport.replay?.catalogSha256 ?? null
	},
	candidate: {
		ref: candidateRef,
		kind: candidatePolicy ? 'socket' : 'heuristic',
		policyObsVersion: candidatePolicy ? policyObsVersion : null,
		temperature: candidatePolicy ? temperature : null,
		...(inferenceInfo ? { inference: inferenceInfo } : {})
	},
	opponent: {
		ref: opponentRef,
		kind: opponentPolicy ? 'weights' : 'heuristic',
		temperature: opponentTemperature
	},
	repeats,
	aggregates: {
		winRate,
		wins,
		meanVP,
		meanPlacement,
		meanRoundOf30,
		reach30Rate
	},
	comparison,
	perRepeat
};

// ── Emit ───────────────────────────────────────────────────────────────────────────────────
const json = JSON.stringify(report, null, 2);
if (args.out) {
	const out = path.resolve(args.out);
	mkdirSync(path.dirname(out), { recursive: true });
	const descriptor = openSync(out, 'w', 0o600);
	try {
		writeSync(descriptor, `${json}\n`);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}
if (!args.quiet) console.log(json);

const fmt = (v, digits = 1) => (v === null ? 'n/a' : v.toFixed(digits));
console.log(
	`HUMANBENCH ${args.game} ${candidateLabel}: win=${(100 * winRate).toFixed(0)}% ` +
		`meanVP=${fmt(meanVP)} r30=${fmt(meanRoundOf30)} ` +
		`vs Michael r30=${michaelRoundOf30 ?? 'n/a'} vp=${michaelFinalVP ?? 'n/a'}`
);

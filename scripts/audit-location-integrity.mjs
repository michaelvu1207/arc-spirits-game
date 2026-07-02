#!/usr/bin/env node
/**
 * Location-commitment rules-integrity audit.
 *
 * Plays N 4-player games with the current champion weights (default
 * src/lib/play/ml/policy-weights.json), mirroring the actor-pool driver loop
 * (src/lib/play/ml/driver.ts playRecordingGame) EXACTLY — same selection
 * ('hybrid', greedy), same unstick fallback, same deadline advance — but
 * captures every APPLIED seat command as an event stream:
 *
 *   (seed, round, phase, seat, lockedDestination, command, draw-state delta)
 *
 * and asserts the location-commitment invariants against it:
 *   V1  resolveLocationInteraction rowIndex belongs to the seat's OWN
 *       locked destination's reward rows
 *   V2  startCombat only while locked to the Arcane Abyss
 *   V3  navigationDestination never changes mid-round (encounter/location)
 *   V4  no Spirit-World-bag draw (pending or queued) while at the Abyss
 *   V5  no selectNavigationDestination commands at all; lockNavigation only
 *       pre-reveal in the navigation phase
 * plus a census of the ungated market surface (takeSpirit / replaceSpirit /
 * refillMarket by phase × destination) and summon-source counts at the Abyss.
 *
 * Engine semantics are untouched: this script only READS state around the
 * same applyGameCommand / next-state transitions the driver performs.
 *
 *   node scripts/audit-location-integrity.mjs --games 200 [--seed0 1]
 *     [--weights src/lib/play/ml/policy-weights.json] [--max-rounds 90]
 */
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values: args } = parseArgs({
	options: {
		games: { type: 'string', default: '200' },
		seed0: { type: 'string', default: '1' },
		weights: { type: 'string', default: 'src/lib/play/ml/policy-weights.json' },
		'max-rounds': { type: 'string', default: '90' },
		'max-examples': { type: 'string', default: '10' }
	}
});
const GAMES = parseInt(args.games, 10);
const SEED0 = parseInt(args.seed0, 10);
const MAX_ROUNDS = parseInt(args['max-rounds'], 10);
const MAX_EXAMPLES = parseInt(args['max-examples'], 10);

const jiti = createJiti(import.meta.url, { alias: { $lib: path.join(root, 'src', 'lib') } });
const imp = (p) => jiti.import(path.join(root, 'src', 'lib', 'play', p));

const runtime = await imp('runtime.ts');
const { applyGameCommand, applyDeadlineAdvance, createLobbyState } = runtime;
const { botActorFor, botSeatNeedsToAct, planBotPhaseActions, profileFor } =
	await imp('server/botPolicy.ts');
const { legalActionsWithNext } = await imp('ml/actions.ts');
const { hybridIndex } = await imp('ml/neuralBot.ts');
const { loadWeightsIfPresent } = await imp('ml/nodeIo.ts');
const { createRng, nextInt } = await imp('rng.ts');
const { SEAT_COLORS } = await imp('types.ts');
const { SPIRIT_WORLD_BAG, ARCANE_ABYSS_BAG } = await imp('bags.ts');
const { buildLocationInteractions } = await imp('locationInteractions.ts');

const catalog = JSON.parse(fs.readFileSync(path.join(root, 'ml', 'catalog.json'), 'utf8'));
const policy = loadWeightsIfPresent(path.resolve(root, args.weights));
if (!policy) {
	console.error(`weights not found: ${args.weights}`);
	process.exit(1);
}

// Same per-phase action cap as the driver (unstick → heuristic forces a yield).
const MAX_ACTIONS_PER_PHASE = 30;
const MAX_TICKS = 50_000;
const PROFILES = ['pvphunter', 'medium', 'aggressive', 'hard'].map(profileFor);

// ── violation + census accumulators ─────────────────────────────────────────
const violations = { V1: [], V2: [], V3: [], V4: [], V5: [] };
const addV = (k, ex) => {
	violations[k].push(ex);
};
const marketCensus = new Map(); // `${cmdType}|${phase}|${nav}` -> count
const drawCensus = new Map(); // `${nav}|${sourceBag}|${viaCmd}` -> count
const cmdCensus = new Map(); // cmdType -> count
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
let takeSpiritTotal = 0;
let spawnHandTotal = 0;
let locksPerRoundOver1 = 0;
let gamesFinished = 0;
let gamesStalled = 0;
let totalRounds = 0;

// Reward rows per destination (from the same frozen catalog the engine uses).
const rowsByDest = new Map();
for (const loc of catalog.locations ?? []) {
	rowsByDest.set(loc.name, buildLocationInteractions(loc.rewardRows));
}

function drawBags(player) {
	const bags = [];
	if (player?.pendingDraw) bags.push(player.pendingDraw.sourceBag);
	for (const q of player?.pendingDrawQueue ?? []) bags.push(q.sourceBag);
	return bags;
}

function playAuditGame(seed) {
	const n = Math.min(4, SEAT_COLORS.length, catalog.guardians.length);
	const seats = SEAT_COLORS.slice(0, n);
	const guardianNames = catalog.guardians.map((g) => g.name).slice(0, n);

	let state = createLobbyState({ roomCode: 'AUDIT', guardianNames });
	const host = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };
	const expectOk = (r, label) => {
		if (!r.ok) throw new Error(`${label}: ${r.error.code} ${r.error.message}`);
		state = r.state;
	};
	seats.forEach((seat, i) => {
		const memberId = `bot-${seat}`;
		expectOk(
			applyGameCommand(
				state,
				{ memberId, displayName: seat, role: 'player', seatColor: null },
				{ type: 'claimSeat', seatColor: seat },
				catalog
			),
			`claimSeat ${seat}`
		);
		expectOk(
			applyGameCommand(
				state,
				{ memberId, displayName: seat, role: 'player', seatColor: seat },
				{ type: 'selectGuardian', guardianName: guardianNames[i] },
				catalog
			),
			`selectGuardian ${seat}`
		);
	});
	expectOk(applyGameCommand(state, host, { type: 'startGame', seed }, catalog), 'startGame');

	const botRng = seededBotRandom(createRng(seed));
	const pickRng = createRng(seed ^ 0x9e3779b9);
	const rand = () => nextInt(pickRng, 1_000_000) / 1_000_000;
	const actionCounter = new Map();
	const locksThisRound = new Map(); // `${seat}:${round}` -> count

	// ── the invariant checker, run on every APPLIED seat command ──
	const onApplied = (seat, cmd, before, after) => {
		const me = before.players[seat];
		const nav = me?.navigationDestination ?? null;
		const meAfter = after.players[seat];
		const navAfter = meAfter?.navigationDestination ?? null;
		const ctx = () => ({
			seed,
			round: before.round,
			phase: before.phase,
			seat,
			nav,
			cmd: JSON.stringify(cmd).slice(0, 160)
		});
		bump(cmdCensus, cmd.type);

		if (cmd.type === 'resolveLocationInteraction') {
			const rows = rowsByDest.get(nav) ?? [];
			if (!rows.some((r) => r.rowIndex === cmd.rowIndex)) {
				addV('V1', { ...ctx(), note: `rowIndex ${cmd.rowIndex} not a row of ${nav}` });
			}
		}
		if (cmd.type === 'startCombat' && nav !== 'Arcane Abyss') addV('V2', ctx());
		if (
			(before.phase === 'encounter' || before.phase === 'location') &&
			before.round === after.round &&
			nav !== navAfter
		) {
			addV('V3', { ...ctx(), navAfter });
		}
		if (navAfter === 'Arcane Abyss') {
			const bagsAfter = drawBags(meAfter);
			const bagsBefore = drawBags(me);
			// New spirit-world-bag draw material appearing while at the Abyss.
			const swAfter = bagsAfter.filter((b) => b === SPIRIT_WORLD_BAG).length;
			const swBefore = bagsBefore.filter((b) => b === SPIRIT_WORLD_BAG).length;
			if (swAfter > swBefore) addV('V4', { ...ctx(), bagsAfter });
			if (bagsAfter.length > bagsBefore.length) {
				bump(drawCensus, `${navAfter}|${bagsAfter[bagsAfter.length - 1]}|${cmd.type}`);
			}
		} else {
			const grew = drawBags(meAfter).length > drawBags(me).length;
			if (grew) bump(drawCensus, `${navAfter}|${drawBags(meAfter).at(-1)}|${cmd.type}`);
		}
		if (cmd.type === 'selectNavigationDestination') addV('V5', ctx());
		if (cmd.type === 'lockNavigation') {
			if (before.revealedDestinations || before.phase !== 'navigation') {
				addV('V5', { ...ctx(), note: 'lock outside pre-reveal navigation' });
			}
			const k = `${seat}:${before.round}`;
			locksThisRound.set(k, (locksThisRound.get(k) ?? 0) + 1);
		}
		if (cmd.type === 'takeSpirit' || cmd.type === 'replaceSpirit' || cmd.type === 'refillMarket') {
			bump(marketCensus, `${cmd.type}|${before.phase}|${nav ?? '-'}`);
			if (cmd.type !== 'refillMarket') takeSpiritTotal += 1;
		}
		if (cmd.type === 'spawnHandSpirit') spawnHandTotal += 1;
	};

	const applyHeuristic = (seat) => {
		let progressed = false;
		const plan = planBotPhaseActions(state, seat, catalog, botRng, PROFILES[seats.indexOf(seat)]);
		for (const cmd of plan) {
			const before = state;
			const res = applyGameCommand(state, botActorFor(state, seat), cmd, catalog);
			if (!res.ok) break;
			onApplied(seat, cmd, before, res.state);
			state = res.state;
			progressed = true;
			if (state.status !== 'active') break;
		}
		return progressed;
	};

	const stepNeural = (seat) => {
		const key = `${seat}:${state.round}:${state.phase}`;
		const used = actionCounter.get(key) ?? 0;
		if (used >= MAX_ACTIONS_PER_PHASE) return applyHeuristic(seat);
		const withNext = legalActionsWithNext(state, seat, catalog);
		if (withNext.length === 0) return applyHeuristic(seat);
		const idx =
			withNext.length === 1
				? 0
				: hybridIndex(policy, state, seat, withNext, { sample: false, rand }, catalog);
		const before = state;
		onApplied(seat, withNext[idx].cmd, before, withNext[idx].next);
		state = withNext[idx].next;
		actionCounter.set(key, used + 1);
		return true;
	};

	let ticks = 0;
	let stalled = false;
	while (state.status === 'active' && state.round <= MAX_ROUNDS) {
		ticks += 1;
		if (ticks > MAX_TICKS) {
			stalled = true;
			break;
		}
		let progressed = false;
		for (const seat of state.activeSeats) {
			if (!botSeatNeedsToAct(state, seat)) continue;
			const did = stepNeural(seat);
			progressed = progressed || did;
			if (state.status !== 'active') break;
		}
		if (state.status !== 'active') break;
		if (!progressed) {
			const beforeTag = `${state.phase}:${state.round}`;
			applyDeadlineAdvance(state, catalog);
			if (`${state.phase}:${state.round}` === beforeTag) {
				stalled = true;
				break;
			}
		}
	}

	for (const [, count] of locksThisRound) if (count > 1) locksPerRoundOver1 += 1;
	totalRounds += state.round;
	if (state.status === 'finished') gamesFinished += 1;
	if (stalled) gamesStalled += 1;
}

function seededBotRandom(rng) {
	return { int: (maxExclusive) => nextInt(rng, maxExclusive), chance: () => nextInt(rng, 2) === 0 };
}

const t0 = Date.now();
for (let g = 0; g < GAMES; g++) {
	playAuditGame(SEED0 + g);
	if ((g + 1) % Math.max(1, Math.floor(GAMES / 10)) === 0) {
		console.error(`[audit] ${g + 1}/${GAMES} games (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
	}
}

// ── report ───────────────────────────────────────────────────────────────────
const sortedEntries = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\n=== location-commitment audit: ${GAMES} games, seeds ${SEED0}.. ===`);
console.log(
	`finished=${gamesFinished} stalled=${gamesStalled} avgRounds=${(totalRounds / GAMES).toFixed(1)}`
);
console.log(`\napplied command census:`);
for (const [k, v] of sortedEntries(cmdCensus)) console.log(`  ${k}: ${v}`);
console.log(`\nmarket commands by type|phase|destination:`);
for (const [k, v] of sortedEntries(marketCensus)) console.log(`  ${k}: ${v}`);
console.log(
	`\nspirit acquisition: takeSpirit/replaceSpirit=${takeSpiritTotal} spawnHandSpirit(summon)=${spawnHandTotal}`
);
console.log(`\ndraw creations by destination|bag|command:`);
for (const [k, v] of sortedEntries(drawCensus)) console.log(`  ${k}: ${v}`);
console.log(`\nre-locks (same seat >1 lockNavigation in a round, pre-reveal, legal): ${locksPerRoundOver1}`);
console.log(`\n=== invariant violations ===`);
let any = false;
for (const [k, list] of Object.entries(violations)) {
	console.log(`${k}: ${list.length}`);
	for (const ex of list.slice(0, MAX_EXAMPLES)) console.log(`   ${JSON.stringify(ex)}`);
	if (list.length > 0) any = true;
}
console.log(any ? '\nRESULT: VIOLATIONS FOUND' : '\nRESULT: all invariants held');
process.exit(any ? 2 : 0)

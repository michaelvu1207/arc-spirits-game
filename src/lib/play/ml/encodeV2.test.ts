/**
 * encodeV2 tests — dims stability, determinism, information safety, and a full-game
 * smoke over every decision point of seeded heuristic self-play.
 *
 * The info-safety tests are the load-bearing ones: they assert that mutating an
 * opponent's OWNER-ONLY fields (the exact set buildSessionProjection redacts —
 * handDraws, pendingDraw(+queue), pendingReward, pendingAwakenReward,
 * pendingCorruptionDiscard, pendingDestination, manualPrompts, pendingDecisions,
 * lastAction, unplacedAugments) leaves the acting seat's v2 encoding bit-identical.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { applyDeadlineAdvance, applyGameCommand, createLobbyState } from '../runtime';
import { createRng, nextInt, type RngState } from '../rng';
import {
	MEDIUM_DEFAULTS,
	botActorFor,
	botSeatNeedsToAct,
	planBotPhaseActions,
	type BotRandom
} from '../server/botPolicy';
import {
	SEAT_COLORS,
	type GameActor,
	type PlayCatalog,
	type PublicGameState,
	type SeatColor
} from '../types';
import { loadOrSnapshotCatalog } from './nodeIo';
import {
	MARKET_CAP,
	OBS_V2_VERSION,
	RUNES_CAP,
	SEATS_CAP,
	SPIRITS_CAP,
	buildObsV2Vocab,
	encodeEntityObsV2,
	flattenObsV2,
	obsV2Dims,
	obsV2FieldNames,
	obsV2FlatLength,
	obsV2Meta,
	type EntityObsV2
} from './encodeV2';

let catalog: PlayCatalog;

beforeAll(async () => {
	catalog = await loadOrSnapshotCatalog();
});

function seededBotRandom(rng: RngState): BotRandom {
	return {
		int: (maxExclusive: number) => nextInt(rng, maxExclusive),
		chance: () => nextInt(rng, 2) === 0
	};
}

/**
 * Seeded heuristic self-play (mirrors sim/selfPlay.ts), invoking `onDecision`
 * with the live state right BEFORE each bot command is applied. Returns the
 * final state. Deterministic for a given (seed, seats).
 */
function runSeededGame(
	seed: number,
	seatCount: number,
	maxRounds: number,
	onDecision?: (state: PublicGameState, seat: SeatColor) => void
): PublicGameState {
	const seats = SEAT_COLORS.slice(0, seatCount) as SeatColor[];
	const guardianNames = catalog.guardians.slice(0, seatCount).map((g) => g.name);
	let state = createLobbyState({ roomCode: 'ENCV2', guardianNames });
	const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };
	const expectOk = (r: ReturnType<typeof applyGameCommand>, label: string): void => {
		if (!r.ok) throw new Error(`${label}: ${r.error.code} ${r.error.message}`);
		state = r.state;
	};
	seats.forEach((seat, i) => {
		const memberId = `bot-${seat}`;
		expectOk(
			applyGameCommand(state, { memberId, displayName: seat, role: 'player', seatColor: null }, { type: 'claimSeat', seatColor: seat }, catalog),
			`claimSeat ${seat}`
		);
		expectOk(
			applyGameCommand(state, { memberId, displayName: seat, role: 'player', seatColor: seat }, { type: 'selectGuardian', guardianName: guardianNames[i] }, catalog),
			`selectGuardian ${seat}`
		);
	});
	expectOk(applyGameCommand(state, host, { type: 'startGame', seed }, catalog), 'startGame');

	const botRng = seededBotRandom(createRng(seed));
	let ticks = 0;
	while (state.status === 'active' && state.round <= maxRounds) {
		if (++ticks > 50_000) throw new Error('runSeededGame: tick cap exceeded');
		let progressed = false;
		for (const seat of state.activeSeats) {
			if (!botSeatNeedsToAct(state, seat)) continue;
			const commands = planBotPhaseActions(state, seat, catalog, botRng, MEDIUM_DEFAULTS);
			for (const command of commands) {
				onDecision?.(state, seat);
				const result = applyGameCommand(state, botActorFor(state, seat), command, catalog, { mutate: true });
				if (!result.ok) break;
				state = result.state;
				progressed = true;
				if (state.status !== 'active') break;
			}
			if (state.status !== 'active') break;
		}
		if (!progressed && state.status === 'active') {
			const before = `${state.phase}:${state.round}`;
			applyDeadlineAdvance(state, catalog);
			if (`${state.phase}:${state.round}` === before && state.status === 'active') {
				throw new Error(`runSeededGame: stalled at ${before}`);
			}
		}
	}
	return state;
}

/** Deep-cloned mid-game state at the first decision of `minRound`, for the given seat count. */
function captureMidGameState(seed: number, seatCount: number, minRound: number): PublicGameState {
	let captured: PublicGameState | null = null;
	runSeededGame(seed, seatCount, minRound + 2, (state) => {
		if (!captured && state.round >= minRound) captured = structuredClone(state);
	});
	if (!captured) throw new Error('no mid-game state captured');
	return captured;
}

function assertShape(obs: EntityObsV2, dims: ReturnType<typeof obsV2Dims>): void {
	expect(obs.version).toBe(OBS_V2_VERSION);
	expect(obs.global).toHaveLength(dims.global);
	expect(obs.seats).toHaveLength(SEATS_CAP);
	for (const row of obs.seats) expect(row).toHaveLength(dims.seat);
	expect(obs.spirits).toHaveLength(SPIRITS_CAP);
	for (const row of obs.spirits) expect(row).toHaveLength(dims.spirit);
	expect(obs.market).toHaveLength(MARKET_CAP);
	for (const row of obs.market) expect(row).toHaveLength(dims.market);
	expect(obs.runes).toHaveLength(RUNES_CAP);
	for (const row of obs.runes) expect(row).toHaveLength(dims.rune);
	expect(obs.monster).toHaveLength(dims.monster);
	expect(obs.masks.seats).toHaveLength(SEATS_CAP);
	expect(obs.masks.spirits).toHaveLength(SPIRITS_CAP);
	expect(obs.masks.market).toHaveLength(MARKET_CAP);
	expect(obs.masks.runes).toHaveLength(RUNES_CAP);
	expect(obs.masks.monster).toHaveLength(1);
}

describe('encodeV2 vocab + dims (frozen catalog contract)', () => {
	it('derives the documented vocabulary sizes from ml/catalog.json', () => {
		const vocab = buildObsV2Vocab(catalog);
		expect(vocab.classes).toHaveLength(37);
		expect(vocab.origins).toHaveLength(8);
		expect(vocab.runeIds).toHaveLength(12);
		expect(vocab.spiritIds).toHaveLength(53);
	});

	it('field-name lists match the emitted dims exactly', () => {
		const dims = obsV2Dims(buildObsV2Vocab(catalog));
		const names = obsV2FieldNames(catalog);
		expect(names.global).toHaveLength(dims.global);
		expect(names.seat).toHaveLength(dims.seat);
		expect(names.spirit).toHaveLength(dims.spirit);
		expect(names.market).toHaveLength(dims.market);
		expect(names.rune).toHaveLength(dims.rune);
		expect(names.monster).toHaveLength(dims.monster);
	});

	it('documented frozen-catalog dims are stable', () => {
		const dims = obsV2Dims(buildObsV2Vocab(catalog));
		expect(dims).toEqual({ global: 122, seat: 55, spirit: 58, market: 49, rune: 18, monster: 10 });
		expect(obsV2FlatLength(buildObsV2Vocab(catalog))).toBe(3419);
	});

	it('obsV2Meta round-trips the flat layout', () => {
		const meta = obsV2Meta(catalog);
		expect(meta.versionCode).toBe(2);
		expect(meta.flatHeader).toHaveLength(2 + meta.tokenTypes.length * 3);
		expect(meta.flatLength).toBe(obsV2FlatLength(buildObsV2Vocab(catalog)));
		expect(meta.vocab.classes).toEqual([...meta.vocab.classes].sort());
	});
});

describe('encodeV2 determinism + shape', () => {
	it('same state + seat → identical output; flat length constant', () => {
		const state = captureMidGameState(11, 4, 3);
		const dims = obsV2Dims(buildObsV2Vocab(catalog));
		const a = encodeEntityObsV2(state, 'Red', catalog);
		const b = encodeEntityObsV2(state, 'Red', catalog);
		expect(a).toEqual(b);
		assertShape(a, dims);
		const flat = flattenObsV2(a, catalog);
		expect(flat).toHaveLength(obsV2FlatLength(buildObsV2Vocab(catalog)));
		expect(flat).toEqual(flattenObsV2(b, catalog));
		// A structurally-cloned state encodes identically (no object-identity deps).
		expect(encodeEntityObsV2(structuredClone(state), 'Red', catalog)).toEqual(a);
	});

	it('seat row 0 is always the acting seat', () => {
		const state = captureMidGameState(11, 4, 3);
		const names = obsV2FieldNames(catalog);
		const isSelfIdx = names.seat.indexOf('isSelf');
		for (const seat of state.activeSeats) {
			const obs = encodeEntityObsV2(state, seat, catalog);
			expect(obs.seats[0][isSelfIdx]).toBe(1);
			const seatIdx = names.seat.indexOf(`seat:${seat}`);
			expect(obs.seats[0][seatIdx]).toBe(1);
			for (let i = 1; i < SEATS_CAP; i++) expect(obs.seats[i][isSelfIdx]).toBe(0);
		}
	});
});

describe('encodeV2 information safety', () => {
	/** Fields buildSessionProjection redacts for non-owner viewers. */
	function corruptOpponentPrivateInfo(state: PublicGameState, opp: SeatColor): void {
		const p = state.players[opp]!;
		p.handDraws = [{ guid: 'ghost-guid', id: 'ghost', name: 'Ghost', cost: 3 }];
		p.pendingDraw = { sourceBag: 'Spirit World Bag', drawCount: 3, summonLimit: 2, summonedCount: 0 };
		p.pendingDrawQueue = [{ sourceBag: 'Arcane Abyss Bag', drawCount: 2, summonLimit: 1 }];
		p.pendingReward = { monsterId: 'm', monsterName: 'M', rewardTrack: ['x', 'y'], chooseAmount: 2 };
		p.pendingAwakenReward = { grants: [{ kind: 'vp', amount: 3, source: 'Test' }] };
		p.pendingCorruptionDiscard = { count: 2, reason: 'test' };
		p.pendingDestination = p.pendingDestination === 'Tidal Cove' ? 'Cyber City' : 'Tidal Cove';
		p.manualPrompts = [{ id: 'mp', source: 'Test', text: 'do a thing' }];
		p.pendingDecisions = [
			{ id: 'd1', source: 'class', kind: 'k', prompt: 'p', options: [{ id: 'a', label: 'A' }] }
		];
		p.lastAction = { key: 'k', label: 'L', log: ['secret'] };
		p.unplacedAugments = [{ runeId: 'aug-1', name: 'Aug' }];
	}

	it('opponent private info is invisible: mutated owner-only fields ⇒ identical encoding', () => {
		const state = captureMidGameState(23, 4, 4);
		const viewer: SeatColor = 'Red';
		const opp = state.activeSeats.find((s) => s !== viewer)!;
		const base = flattenObsV2(encodeEntityObsV2(state, viewer, catalog), catalog);
		const mutated = structuredClone(state);
		corruptOpponentPrivateInfo(mutated, opp);
		const after = flattenObsV2(encodeEntityObsV2(mutated, viewer, catalog), catalog);
		expect(after).toEqual(base);
	});

	it('pre-reveal navigation choices leak nothing (pendingDestination + navigationDestination)', () => {
		// Capture a state at the START of a navigation phase (pre-reveal).
		let navState: PublicGameState | null = null;
		runSeededGame(31, 4, 6, (state) => {
			if (!navState && state.round >= 3 && state.phase === 'navigation' && !state.revealedDestinations) {
				navState = structuredClone(state);
			}
		});
		expect(navState).not.toBeNull();
		const state = navState! as PublicGameState;
		const viewer: SeatColor = 'Red';
		const opp = state.activeSeats.find((s) => s !== viewer)!;
		const base = flattenObsV2(encodeEntityObsV2(state, viewer, catalog), catalog);

		const mutated = structuredClone(state);
		const p = mutated.players[opp]!;
		p.pendingDestination = p.pendingDestination === 'Arcane Abyss' ? 'Floral Patch' : 'Arcane Abyss';
		// Even if the legacy selectNavigationDestination path wrote the public field
		// early, the encoder must not read it pre-reveal.
		p.navigationDestination = 'Lantern Canyon';
		const after = flattenObsV2(encodeEntityObsV2(mutated, viewer, catalog), catalog);
		expect(after).toEqual(base);
	});

	it("sanity: the SAME private fields on the acting seat DO change its encoding", () => {
		const state = captureMidGameState(23, 4, 4);
		const viewer: SeatColor = 'Red';
		const base = flattenObsV2(encodeEntityObsV2(state, viewer, catalog), catalog);
		const mutated = structuredClone(state);
		corruptOpponentPrivateInfo(mutated, viewer);
		const after = flattenObsV2(encodeEntityObsV2(mutated, viewer, catalog), catalog);
		expect(after).not.toEqual(base);
	});

	it('post-reveal destinations ARE encoded (they are public then)', () => {
		let revealed: PublicGameState | null = null;
		runSeededGame(31, 4, 6, (state) => {
			if (!revealed && state.round >= 3 && state.revealedDestinations) revealed = structuredClone(state);
		});
		expect(revealed).not.toBeNull();
		const state = revealed! as PublicGameState;
		const viewer: SeatColor = 'Red';
		const opp = state.activeSeats.find((s) => s !== viewer && state.players[s]?.navigationDestination)!;
		const base = flattenObsV2(encodeEntityObsV2(state, viewer, catalog), catalog);
		const mutated = structuredClone(state);
		const p = mutated.players[opp]!;
		p.navigationDestination = p.navigationDestination === 'Arcane Abyss' ? 'Floral Patch' : 'Arcane Abyss';
		const after = flattenObsV2(encodeEntityObsV2(mutated, viewer, catalog), catalog);
		expect(after).not.toEqual(base);
	});
});

describe('encodeV2 full-game smoke', () => {
	// Seeded full-game encode sweep brushes the 5s default under parallel vitest load.
	it('encodes every decision point of seeded 4p games without throwing; caps hold', { timeout: 30_000 }, () => {
		const dims = obsV2Dims(buildObsV2Vocab(catalog));
		const flatLen = obsV2FlatLength(buildObsV2Vocab(catalog));
		let decisions = 0;
		let maxSpirits = 0;
		let maxMarket = 0;
		let maxRunes = 0;
		let maxSeats = 0;
		const sum = (m: number[]): number => m.reduce((a, b) => a + b, 0);
		for (const seed of [7, 21, 42]) {
			const final = runSeededGame(seed, 4, 30, (state, seat) => {
				decisions += 1;
				// Encoding every single decision is cheap but O(commands); sample every
				// 3rd decision for full shape checks, count maxima on all of them.
				const obs = encodeEntityObsV2(state, seat, catalog);
				maxSeats = Math.max(maxSeats, sum(obs.masks.seats));
				maxSpirits = Math.max(maxSpirits, sum(obs.masks.spirits));
				maxMarket = Math.max(maxMarket, sum(obs.masks.market));
				maxRunes = Math.max(maxRunes, sum(obs.masks.runes));
				if (decisions % 3 === 0) {
					assertShape(obs, dims);
					expect(flattenObsV2(obs, catalog)).toHaveLength(flatLen);
				}
			});
			expect(final.round).toBeGreaterThan(1);
		}
		expect(decisions).toBeGreaterThan(300);
		expect(maxSeats).toBe(4);
		expect(maxSpirits).toBeLessThanOrEqual(SPIRITS_CAP);
		expect(maxMarket).toBeLessThanOrEqual(MARKET_CAP);
		expect(maxRunes).toBeLessThanOrEqual(RUNES_CAP);
		// Observed maxima — recorded in docs/encoder-v2.md; printed for refresh runs.
		console.log(
			`encodeV2 smoke: decisions=${decisions} ` +
				`maxima seats=${maxSeats} spirits=${maxSpirits} market=${maxMarket} runes=${maxRunes}`
		);
	});
});

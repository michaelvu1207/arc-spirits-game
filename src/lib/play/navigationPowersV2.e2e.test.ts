/**
 * Rule switch `powerRework`, through the real reducer (lobby → navigation → reveal → location) on
 * the frozen catalog: the Powers whose effect lives in runtime.ts / combat.ts rather than in
 * navigationPowerEffects.ts.
 *
 *   npx vitest run src/lib/play/navigationPowersV2.e2e.test.ts
 */

import { describe, expect, it } from 'vitest';
import { applyDeadlineAdvance, applyGameCommand } from './runtime';
import { navigationPowerPool, type NavigationPowerId } from './navigationPowers';
import { createAgentLobby } from './agents/setup';
import { loadFrozenCatalog } from './agents/catalog';
import { agentLegalCommands } from './agents/actionSurface';
import { botActorFor } from './server/botPolicy';
import { testMonsterCard } from './testing/monsterCards';
import type { GameCommand, PlayCatalog, PublicGameState, SeatColor } from './types';

const catalog: PlayCatalog = { ...loadFrozenCatalog(), rules: { powerRework: true } };
const SEATS: SeatColor[] = ['Red', 'Blue', 'Orange', 'Green'];
const V2 = new Set(navigationPowerPool(catalog).map((p) => p.id));

function run(s: PublicGameState, seat: SeatColor, cmd: GameCommand): PublicGameState {
	const r = applyGameCommand(s, botActorFor(s, seat), cmd, catalog);
	if (!r.ok) throw Error(`${seat} ${cmd.type}: ${r.error.code}: ${r.error.message}`);
	return r.state;
}
function start(seed = 11): PublicGameState {
	const guardians = catalog.guardians.map((g) => g.name);
	return createAgentLobby(catalog, seed, SEATS.map((seat, i) => ({ seat, guardian: guardians[i] })));
}
/** Skip the opening drafts, give Red `power`, send Red to `destination` (others to the Mountain). */
function reveal(s: PublicGameState, power: NavigationPowerId, destination: string): PublicGameState {
	for (const seat of SEATS) s.players[seat]!.pendingPowerDrafts = [];
	s.players.Red!.powerInventory = [power];
	for (const seat of SEATS)
		s = run(s, seat, {
			type: 'lockNavigation',
			destination: (seat === 'Red' ? destination : 'Mountain Region') as never,
			...(seat === 'Red' ? { navigationPowerId: power } : {})
		} as GameCommand);
	if (!s.revealedDestinations) applyDeadlineAdvance(s, catalog);
	for (let i = 0; i < 4 && s.phase !== 'location'; i++) applyDeadlineAdvance(s, catalog);
	expect(s.phase).toBe('location');
	expect(s.players.Red!.navigationPower).toBe(power);
	return s;
}
const offerOf = (s: PublicGameState) => s.players.Red!.navigationPowerOffers?.[0];
function answer(s: PublicGameState, optionId: string): PublicGameState {
	return run(s, 'Red', { type: 'resolveNavigationPower', offerId: offerOf(s)!.id, optionId });
}

describe('powerRework through the reducer', () => {
	it('opening drafts and Forest random Powers come from the new set', () => {
		const s = start();
		for (const seat of SEATS) {
			const draft = s.players[seat]!.pendingPowerDrafts![0];
			expect(draft).toHaveLength(3);
			for (const id of draft) expect(V2.has(id)).toBe(true);
		}
		// Switch off: only old ids are ever drafted, over many seeds.
		const oldIds = new Set<string>();
		for (let seed = 1; seed <= 12; seed++) {
			const old = createAgentLobby({ ...catalog, rules: undefined }, seed, SEATS.map((seat, i) => ({ seat, guardian: catalog.guardians[i].name })));
			for (const seat of SEATS) for (const id of old.players[seat]!.pendingPowerDrafts![0]) oldIds.add(id);
		}
		expect([...oldIds].some((id) => id === 'abyssal-reckoning' || id === 'tidal-arsenal' || id === 'forest-bounty')).toBe(true);
		expect([...oldIds].filter((id) => /-2$|underdogs-oath|tidal-calling|sudden-strike|tempered-dice|dark-bargain|soul-ward|twin-rhythm/.test(id))).toEqual([]);
	});

	it("another seat's owner-only choice does not hold the table; the owner is held", () => {
		const s = reveal(start(), 'mountains-wealth', 'Mountain Region');
		expect(offerOf(s)?.kind).toBe('rune');
		// Blue has nothing to resolve: its Location step is not frozen by Red's rune choice.
		const blue = applyGameCommand(structuredClone(s), botActorFor(s, 'Blue'), { type: 'endLocationActions' }, catalog);
		expect(blue.ok).toBe(true);
		expect(agentLegalCommands(s, 'Blue', catalog).commands.length).toBeGreaterThan(0);
		// Red must answer its own choice first, and is told it is its own.
		const red = applyGameCommand(structuredClone(s), botActorFor(s, 'Red'), { type: 'endLocationActions' }, catalog);
		expect(red.ok).toBe(false);
		if (!red.ok) {
			expect(red.error.code).toBe('power_pending');
			expect(red.error.message).toBe('Resolve your Navigation Power choice first.');
		}
	});

	it('a choice that can hit other players still holds them, and names who is waited on', () => {
		const s = reveal(start(), 'thorn-ward', 'Mountain Region');
		expect(offerOf(s)?.kind).toBe('damage');
		const blue = applyGameCommand(structuredClone(s), botActorFor(s, 'Blue'), { type: 'endLocationActions' }, catalog);
		expect(blue.ok).toBe(false);
		if (!blue.ok) {
			expect(blue.error.code).toBe('power_pending');
			expect(blue.error.message).toBe('Waiting for Red to resolve a Navigation Power choice.');
		}
	});

	it('Cinder Awakening wakes a rune-cost Arcane spirit for free at the Fire Region', () => {
		let s = start();
		const arcane = catalog.spirits.find((x) => x.cost >= 7 && x.awaken?.kind === 'rune_cost')!;
		const red = s.players.Red!;
		red.spirits = [
			{ slotIndex: 1, id: arcane.id, name: arcane.name, cost: arcane.cost, classes: arcane.classes, origins: arcane.origins, isFaceDown: true }
		];
		red.mats = [];
		s = reveal(s, 'cinder-awakening-2', 'Fire Region');
		expect(offerOf(s)?.options.map((o) => o.label)).toEqual([`Awaken ${arcane.name}`, 'Decline']);
		s = answer(s, '1');
		expect(s.players.Red!.spirits[0].isFaceDown).toBe(false);
	});

	it('Tidal Calling: the Spirit World Summon at the Water Region shows 8', () => {
		let s = start();
		s.players.Red!.spirits = [];
		s = reveal(s, 'tidal-calling', 'Water Region');
		const summon = agentLegalCommands(s, 'Red', catalog).commands.find(
			(c) => c.type === 'resolveLocationInteraction' && (c as { rowIndex: number }).rowIndex === 0
		)!;
		s = run(s, 'Red', summon);
		expect(s.players.Red!.handDraws).toHaveLength(8);
		expect(s.players.Red!.pendingDraw?.summonLimit).toBe(2);
	});

	it('Abyssal Execution defeats the chosen chipped card and pays its rewards', () => {
		let s = start();
		const d2 = catalog.monsters!.find((m) => m.barrier >= 6 && m.barrier <= 7)!;
		s.players.Red!.monsterHand = [
			testMonsterCard(catalog, { catalogId: d2.id }),
			testMonsterCard(catalog, { catalogId: d2.id, hp: 3 })
		];
		s = reveal(s, 'abyssal-execution-2', 'Arcane Abyss');
		expect(offerOf(s)?.options.map((o) => o.id)).toEqual(['1', 'decline']);
		s = answer(s, '1');
		const red = s.players.Red!;
		expect(red.monsterHand).toHaveLength(1);
		expect(red.monsterHand![0].hp).toBe(d2.barrier); // the fresh card is untouched
		expect(red.actionsUsedThisRound).toContain('combat');
		expect(red.pendingReward?.monsterId).toBe(d2.id);
	});

	const corruptAtAbyss = (power: NavigationPowerId) => {
		let s = start();
		const red = s.players.Red!;
		red.barrier = 1;
		red.brokenBarrier = red.maxBarrier - 1;
		red.attackDice = [];
		const tough = [...catalog.monsters!].sort((a, b) => b.barrier - a.barrier)[0];
		red.monsterHand = [testMonsterCard(catalog, { catalogId: tough.id })];
		const spiritsBefore = red.spirits.length;
		s = reveal(s, power, 'Arcane Abyss');
		s = run(s, 'Red', { type: 'startCombat', handIndex: 0 });
		return { red: s.players.Red!, spiritsBefore };
	};
	it('Dark Bargain: a corruption this round pays 3 VP and still costs the sacrifice', () => {
		const { red } = corruptAtAbyss('dark-bargain');
		expect(red.statusLevel).toBe(1);
		expect(red.victoryPoints).toBe(3);
		expect(red.pendingCorruptionDiscard?.count).toBe(1);
	});
	it('Soul Ward: a corruption this round costs no spirit', () => {
		const { red } = corruptAtAbyss('soul-ward');
		expect(red.statusLevel).toBe(1);
		expect(red.barrier).toBe(red.maxBarrier); // corruption still heals
		expect(red.pendingCorruptionDiscard ?? null).toBeNull();
		expect(red.victoryPoints).toBe(0);
	});
	it('without either Power the same corruption costs 1 spirit and pays nothing', () => {
		const { red } = corruptAtAbyss('tidal-calling'); // does nothing at the Abyss
		expect(red.statusLevel).toBe(1);
		expect(red.victoryPoints).toBe(0);
		expect(red.pendingCorruptionDiscard?.count).toBe(1);
	});

	it('Twin Rhythm rests (and cultivates) at the Arcane Abyss', () => {
		let s = start();
		const red = s.players.Red!;
		red.barrier = 1;
		red.brokenBarrier = red.maxBarrier - 1;
		s = reveal(s, 'twin-rhythm', 'Arcane Abyss');
		s = answer(s, 'accept');
		expect(s.players.Red!.barrier).toBe(3);
		expect(s.players.Red!.navigationPowerOffers).toEqual([]);
	});

	it('Ember Charge heals before the fight; Sudden Strike kills a fast monster untouched', () => {
		let s = start();
		s.players.Red!.barrier = 1;
		s.players.Red!.brokenBarrier = s.players.Red!.maxBarrier - 1;
		s = reveal(s, 'ember-charge-2', 'Arcane Abyss');
		expect(s.players.Red!.barrier).toBe(s.players.Red!.maxBarrier);

		let t = start();
		const fast = [...catalog.monsters!].filter((m) => m.barrier <= 2).sort((a, b) => (b.initiative ?? 0) - (a.initiative ?? 0))[0];
		const red = t.players.Red!;
		red.attackDice = Array.from({ length: 6 }, (_, i) => ({ instanceId: `a${i}`, tier: 'arcane' as const }));
		red.monsterHand = [testMonsterCard(catalog, { catalogId: fast.id })];
		const barrier = red.barrier;
		t = reveal(t, 'sudden-strike', 'Arcane Abyss');
		t = run(t, 'Red', { type: 'startCombat', handIndex: 0 });
		expect(t.players.Red!.monsterHand).toHaveLength(0);
		expect(t.players.Red!.barrier).toBeGreaterThanOrEqual(barrier); // the monster never hit
		expect(t.combats.at(-1)?.log.join(' ')).toMatch(/defeated before it could attack/);
	});
});

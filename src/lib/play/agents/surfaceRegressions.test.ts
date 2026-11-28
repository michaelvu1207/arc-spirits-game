/**
 * Action-surface regressions found in league / benchmark games (offline, frozen catalog).
 *
 *   npx vitest run src/lib/play/agents/surfaceRegressions.test.ts
 */

import { describe, expect, it } from 'vitest';
import { applyDeadlineAdvance, applyGameCommand } from '../runtime';
import { botActorFor } from '../server/botPolicy';
import type { GameCommand, PlayCatalog, PublicGameState, SeatColor } from '../types';
import { agentLegalCommands, locationRowCommands } from './actionSurface';
import { loadFrozenCatalog } from './catalog';
import { interactionsAt, labelFor } from './labels';
import { buildRulesBrief } from './rulesBrief';
import { renderSeatView, seatProjection } from './view';
import { ARCANE_ABYSS_BAG, bagForSpiritCost } from '../bags';
import { takeDamage } from '../combat';
import { MAX_SPIRITS } from '../types';
import { createAgentLobby, pickGuardians, seatsFor } from './setup';

const catalog: PlayCatalog = loadFrozenCatalog();

function newGame(seats = 2, seed = 5): PublicGameState {
	const colors = seatsFor(seats);
	const guardians = pickGuardians(catalog, seed, seats);
	return createAgentLobby(
		catalog,
		seed,
		colors.map((seat, i) => ({ seat, guardian: guardians[i] }))
	);
}

function apply(state: PublicGameState, seat: SeatColor, cmd: GameCommand): PublicGameState {
	const result = applyGameCommand(state, botActorFor(state, seat), cmd, catalog);
	if (!result.ok) throw new Error(`${cmd.type}: ${result.error.code} ${result.error.message}`);
	return result.state;
}

function draftPowers(state: PublicGameState): PublicGameState {
	for (const seat of state.activeSeats) {
		const draft = state.players[seat]?.pendingPowerDrafts?.[0];
		if (draft?.length)
			state = apply(state, seat, { type: 'chooseNavigationPower', powerId: draft[0] });
	}
	return state;
}

/** Every offered command must be accepted by the reducer. */
function expectAllOfferedApply(state: PublicGameState, seat: SeatColor): GameCommand[] {
	const offered = agentLegalCommands(state, seat, catalog).commands;
	for (const cmd of offered) {
		const result = applyGameCommand(state, botActorFor(state, seat), cmd, catalog);
		expect(result.ok, `${JSON.stringify(cmd)} → ${result.ok ? '' : result.error.message}`).toBe(
			true
		);
	}
	return offered;
}

describe('action surface regressions', () => {
	// league g27 / benchmark g62 (2026-11-13): a Watchful Eye holder gave its only rune to a
	// Stone Shelter holder in the same reveal; its Watchful Eye "pay that rune" options stayed
	// on the offer, were offered, and the reducer refused them ("The payment rune is no longer
	// available."), which stopped the game.
	it('does not offer a Watchful Eye payment with a rune given away to Stone Shelter', () => {
		let state = draftPowers(newGame(2, 7));
		state.players.Red!.powerInventory = ['stone-shelter'];
		state.players.Blue!.powerInventory = ['watchful-eye'];
		state = apply(state, 'Red', {
			type: 'lockNavigation',
			destination: 'Water Region',
			navigationPowerId: 'stone-shelter'
		});
		state = apply(state, 'Blue', {
			type: 'lockNavigation',
			destination: 'Water Region',
			navigationPowerId: 'watchful-eye'
		});
		applyDeadlineAdvance(state, catalog);

		const blueRunesBefore = state.players.Blue!.mats.filter((m) => m.hasRune).length;
		expect(blueRunesBefore).toBe(1);
		const shelter = state.players.Red!.navigationPowerOffers!.find(
			(o) => o.powerId === 'stone-shelter'
		)!;
		state = apply(state, 'Red', {
			type: 'resolveNavigationPower',
			offerId: shelter.id,
			optionId: 'accept'
		});
		const give = state.players.Blue!.navigationPowerOffers!.find((o) => o.kind === 'give-rune')!;
		state = apply(state, 'Blue', {
			type: 'resolveNavigationPower',
			offerId: give.id,
			optionId: give.options[0].id
		});

		const eye = state.players.Blue!.navigationPowerOffers!.find((o) => o.kind === 'exchange');
		expect(eye?.options.length).toBeGreaterThan(1); // the stale payment options are still on it
		const offered = expectAllOfferedApply(state, 'Blue');
		const eyeOptions = offered.filter(
			(c) => c.type === 'resolveNavigationPower' && c.offerId === eye!.id
		);
		expect(eyeOptions).toEqual([
			{ type: 'resolveNavigationPower', offerId: eye!.id, optionId: 'decline' }
		]);
	});

	// 2026-11-13: every Spirit World Summon draws 3 spirits + 1 reward hex; the reward hex must
	// be offered as one of the picks and be accepted by the reducer.
	it('offers the reward hex of a Spirit World Summon, and the reducer accepts it', () => {
		let state = draftPowers(newGame(2, 5));
		for (const seat of state.activeSeats)
			state = apply(state, seat, { type: 'lockNavigation', destination: 'Water Region' });
		applyDeadlineAdvance(state, catalog);
		const row = interactionsAt(catalog, 'Water Region').find((i) =>
			i.gains.some((g) => g.type === 'action' && g.action === 'spiritWorldSummon')
		);
		expect(row).toBeTruthy();
		const summon = locationRowCommands(state, 'Red', catalog).find(
			(c) => c.type === 'resolveLocationInteraction' && c.rowIndex === row!.rowIndex
		)!;
		state = apply(state, 'Red', summon);
		const reward = state.players.Red!.handDraws.find((d) => d.rewardId);
		expect(reward).toBeTruthy();
		const offered = expectAllOfferedApply(state, 'Red');
		const take = offered.find((c) => c.type === 'spawnHandSpirit' && c.guid === reward!.guid);
		expect(take).toBeTruthy();
		expect(labelFor(take!, seatProjection(state, 'Red'), 'Red', catalog)).toMatch(
			/^Take the reward hex: /
		);
	});

	it('the brief states flat spirit slots, what Cultivate does, reward hexes and Arcane sources', () => {
		const brief = buildRulesBrief(catalog);
		// "Tainted 6 of 12" is the initiative die; no slot count depends on the status.
		expect(brief).not.toMatch(/Tainted 6(?! of 12)|slots by status/);
		expect(brief).toContain('Spirit slots: 7 at every status');
		expect(brief).toContain(
			'1 for your 1st corruption, 2 for the 2nd, 3 for the 3rd, 4 for the 4th (and 4 for every corruption after your 4th: it stops growing there).'
		);
		expect(brief).toMatch(/it never adds spirits/);
		expect(brief).toMatch(/3 spirits \+ 1 reward hex/);
		expect(brief).toMatch(/Arcane spirits come only from an Arcane Abyss Summon/);
		// The hand-written bag fact: every Sun and Moon spirit is in the Abyss bag (cost 7-9).
		for (const spirit of catalog.spirits) {
			const origins = Object.keys(spirit.origins ?? {});
			if (origins.includes('Sun') || origins.includes('Moon'))
				expect(bagForSpiritCost(spirit.cost), spirit.name).toBe(ARCANE_ABYSS_BAG);
		}
	});

	it('the turn view shows 7 spirit slots at every status', () => {
		const state = draftPowers(newGame(2, 5));
		state.players.Red!.statusLevel = 3;
		state.players.Red!.statusToken = 'Fallen';
		const text = renderSeatView(seatProjection(state, 'Red'), 'Red', catalog);
		expect(text).toContain(`Spirits (${state.players.Red!.spirits.length}/7 slots)`);
	});

	it('location labels warn when a rune gain goes over the carry limit, and say what Cultivate gives', () => {
		let state = draftPowers(newGame(2, 5));
		for (const seat of state.activeSeats)
			state = apply(state, seat, { type: 'lockNavigation', destination: 'Fire Region' });
		applyDeadlineAdvance(state, catalog);
		const red = state.players.Red!;
		const fire = Object.keys(red.spirits[0].origins ?? {})[0] ?? 'Fire Region';
		// Three spirits of one origin → Cultivate gives 1 rune of it.
		for (const spirit of red.spirits.slice(0, 3)) spirit.origins = { 'Fire Region': 1 };
		const runeTemplate = red.mats.find((m) => m.hasRune)!;
		const labelOf = () => {
			const view = seatProjection(state, 'Red');
			const cultivate = interactionsAt(catalog, 'Fire Region').find((i) =>
				i.gains.some((g) => g.type === 'action' && g.action === 'cultivate')
			)!;
			return labelFor(
				{ type: 'resolveLocationInteraction', rowIndex: cultivate.rowIndex },
				view,
				'Red',
				catalog
			);
		};
		expect(fire).toBeTruthy();
		expect(labelOf()).toContain('Cultivate (now: Fire Region rune');
		expect(labelOf()).toContain('adds no spirits');
		expect(labelOf()).not.toContain('CARRY LIMIT');
		// Hold 4 (the limit): the Cultivate rune would be a 5th.
		while (red.mats.filter((m) => m.hasRune).length < 4)
			red.mats.push({ ...runeTemplate, slotIndex: red.mats.length + 1 });
		expect(labelOf()).toContain(
			'OVER THE CARRY LIMIT: you would hold 5 runes/relics; 1 must be discarded at Cleanup'
		);
	});
});

// Michael 2026-11-13: "When you drop in status you just discard spirits": 1 on the first drop, 2 on
// the second, 3 on the third, 4 on the fourth; the board stays at 7 slots (no cap by status).
describe('corruption sacrifice rule', () => {
	it('the Nth corruption owes N spirits (1/2/3/4), the player picks them, and the cap stays 7', () => {
		const state = newGame(2, 5);
		const red = state.players.Red!;
		const template = red.spirits[0];
		const statuses: (string | null)[] = [];
		for (const owed of [1, 2, 3, 4]) {
			red.pendingCorruptionDiscard = null as typeof red.pendingCorruptionDiscard;
			red.spirits = Array.from({ length: MAX_SPIRITS }, (_, i) => ({
				...template,
				slotIndex: i + 1,
				classes: {},
				isFaceDown: true
			}));
			const hit = takeDamage(red, red.barrier + 1);
			expect(hit.corrupted).toBe(true);
			statuses.push(red.statusToken);
			expect(red.corruptionCount).toBe(owed);
			expect(red.pendingCorruptionDiscard as { count: number } | null).toEqual(
				expect.objectContaining({ count: owed })
			);
			expect(red.spirits).toHaveLength(MAX_SPIRITS); // nothing auto-removed: the player chooses
		}
		expect(statuses).toEqual(['Tainted', 'Corrupt', 'Fallen', 'Fallen']);
		// The sacrifice is paid with discardSpirit, slot chosen by the player (Cleanup).
		state.phase = 'cleanup';
		const next = apply(state, 'Red', { type: 'discardSpirit', slotIndex: 6 });
		expect(next.players.Red!.spirits.map((s) => s.slotIndex)).not.toContain(6);
		expect(next.players.Red!.pendingCorruptionDiscard?.count).toBe(3);
	});
});

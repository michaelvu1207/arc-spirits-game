import { describe, expect, it } from 'vitest';
import { applyGameCommand, createLobbyState } from '../runtime';
import { botActorFor, computeKillProbability, planBotPhaseActions, profileFor, type BotRandom } from '../server/botPolicy';
import type {
	AttackDie,
	GameActor,
	GameCommand,
	NavigationDestination,
	PlayCatalog,
	PlayCatalogMonster,
	PublicGameState
} from '../types';
import {
	abyssPreviewMonster,
	bestHandMonster,
	bestStartCombatCommand,
	monsterCardFromCatalog,
	nextMonsterCardCommand,
	planMonsterCardCommands
} from './monsterCardAutopilot';

const VP1 = '70792514-aa43-4526-a7a4-0f1e4ca55d71';
const VP3 = '54a61c34-6e05-44df-a4d1-115e004af31e';

function monster(id: string, hp: number, damage: number, rewardTrack: string[], order: number): PlayCatalogMonster {
	return { id, name: id, damage, barrier: hp, rewardTrack, dicePool: [], chooseAmount: 2, stage: hp >= 8 ? 3 : hp >= 4 ? 2 : 1, order };
}

// A card's deck is its stage; here stage and Barrier band agree (1–3 → 1, 4–7 → 2, 8+ → 3).
// One Arcane die rolls 0, 0, 1, 3, 3 or 5.
const MONSTERS = {
	d1Weak: monster('d1-weak', 1, 1, [VP1, VP1], 0),
	d1Tough: monster('d1-tough', 3, 1, [VP1, VP1], 1),
	d1Rich: monster('d1-rich', 3, 1, [VP3, VP3], 2),
	d2: monster('d2', 4, 2, [VP3, VP1], 3),
	d3: monster('d3', 9, 3, [VP3, VP3], 4)
};

const CATALOG: PlayCatalog = {
	guardians: [
		{ id: 'g-a', name: 'Red Guard', originId: 'o1' },
		{ id: 'g-b', name: 'Blue Guard', originId: 'o2' }
	],
	mats: [],
	classes: [],
	dice: [],
	spirits: [],
	monsters: Object.values(MONSTERS),
	locations: []
};

const RED: GameActor = { memberId: 'm-red', displayName: 'Red', role: 'host', seatColor: 'Red' };
const BLUE: GameActor = { memberId: 'm-blue', displayName: 'Blue', role: 'player', seatColor: 'Blue' };

function apply(state: PublicGameState, actor: GameActor, command: GameCommand): PublicGameState {
	const result = applyGameCommand(state, actor, command, CATALOG);
	if (!result.ok) throw new Error(`${command.type} failed: ${result.error.message}`);
	return result.state;
}

function startedGame(): PublicGameState {
	let state = createLobbyState({ roomCode: 'CARDS', guardianNames: ['Red Guard', 'Blue Guard'] });
	state = apply(state, RED, { type: 'claimSeat', seatColor: 'Red' });
	state = apply(state, BLUE, { type: 'claimSeat', seatColor: 'Blue' });
	state = apply(state, RED, { type: 'selectGuardian', guardianName: 'Red Guard' });
	state = apply(state, BLUE, { type: 'selectGuardian', guardianName: 'Blue Guard' });
	return apply(state, RED, { type: 'startGame', seed: 5 });
}

/** Red in the location phase at `destination` (Blue elsewhere), with `dice` arcane dice and a safe Barrier. */
function redAt(destination: NavigationDestination, dice = 1): PublicGameState {
	let state = startedGame();
	state = apply(state, RED, { type: 'lockNavigation', destination });
	state = apply(state, BLUE, { type: 'lockNavigation', destination: 'Forest Region' });
	state = apply(state, RED, { type: 'forceAdvancePhase' });
	expect(state.phase).toBe('location');
	expect(state.players.Red!.monsterHand ?? []).toEqual([]);
	armRed(state, dice);
	return state;
}

function armRed(state: PublicGameState, dice: number): void {
	const red = state.players.Red!;
	red.attackDice = Array.from({ length: dice }, (_, i): AttackDie => ({ instanceId: `d-${i}`, tier: 'arcane' }));
	red.maxBarrier = 10;
	red.barrier = 10;
}

const card = (m: PlayCatalogMonster) => monsterCardFromCatalog(m);

/** Replace the monster decks with exactly these cards. */
function setDeck(state: PublicGameState, monsters: PlayCatalogMonster[]): void {
	state.bags.monsters.contents = monsters.map((m) => ({
		guid: `monster-card-${m.id}`,
		id: m.id,
		name: m.name,
		barrier: m.barrier,
		damage: m.damage,
		difficulty: card(m).difficulty
	}));
	state.bags.monsters.count = state.bags.monsters.contents.length;
}

describe('monster-card autopilot', () => {
	it('keeps the revealed card the bot is most likely to kill, and stops there', () => {
		const state = redAt('Arcane Abyss');
		// One arcane die: the 1-HP card dies on 4 sides of 6, the 3-HP card on 3.
		state.players.Red!.pendingMonsterDraw = { cards: [card(MONSTERS.d1Tough), card(MONSTERS.d1Weak)], maxCards: 2 };

		expect(nextMonsterCardCommand(state, 'Red', CATALOG)).toEqual({ type: 'keepMonsterCard', index: 1 });
		// There is no commit step: the kept card stays in the hand, ready to fight.
		expect(planMonsterCardCommands(state, 'Red', CATALOG)).toEqual([{ type: 'keepMonsterCard', index: 1 }]);
		// Pure: the input state is untouched.
		expect(state.players.Red!.pendingMonsterDraw?.cards).toHaveLength(2);
		expect(state.players.Red!.monsterHand ?? []).toEqual([]);
	});

	it('breaks kill-probability ties by lower Barrier left, then by more claimable VP', () => {
		const state = redAt('Arcane Abyss', 10); // ten arcane dice almost surely kill every card below 10 HP
		const red = state.players.Red!;

		// 4 Barrier against 3.
		red.pendingMonsterDraw = { cards: [card(MONSTERS.d2), card(MONSTERS.d1Tough)], maxCards: 2 };
		expect(nextMonsterCardCommand(state, 'Red', CATALOG)).toEqual({ type: 'keepMonsterCard', index: 1 });

		// Same Barrier: 6 claimable VP beats 2.
		red.pendingMonsterDraw = { cards: [card(MONSTERS.d1Tough), card(MONSTERS.d1Rich)], maxCards: 2 };
		expect(nextMonsterCardCommand(state, 'Red', CATALOG)).toEqual({ type: 'keepMonsterCard', index: 1 });
	});

	it('fights the hand card with the best kill odds, skipping defeated cards', () => {
		const state = redAt('Arcane Abyss');
		state.players.Red!.monsterHand = [card(MONSTERS.d2), card(MONSTERS.d1Tough), card(MONSTERS.d1Weak)];
		expect(bestStartCombatCommand(state, 'Red', CATALOG)).toEqual({ type: 'startCombat', handIndex: 2 });
		expect(bestHandMonster(state, 'Red', CATALOG)?.card.id).toBe('d1-weak');

		state.players.Red!.monsterHand[2] = { ...card(MONSTERS.d1Weak), hp: 0 };
		expect(bestStartCombatCommand(state, 'Red', CATALOG)).toEqual({ type: 'startCombat', handIndex: 1 });

		// No combat action left → no fight command.
		state.players.Red!.actionsUsedThisRound = ['combat'];
		expect(bestStartCombatCommand(state, 'Red', CATALOG)).toBeNull();
	});

	it('draws from the highest difficulty the bot can likely beat, else the lowest deck with cards', () => {
		const firstDraw = (dice: number, deck: PlayCatalogMonster[] = Object.values(MONSTERS)) => {
			const state = redAt('Arcane Abyss', dice);
			setDeck(state, deck);
			return nextMonsterCardCommand(state, 'Red', CATALOG);
		};
		// One die: only Difficulty 1 is a likely kill.
		expect(firstDraw(1)).toEqual({ type: 'drawMonsterCards', difficulty: 1 });
		// Three dice: the 4-Barrier Difficulty 2 card is likely, the 9 of Difficulty 3 is not.
		expect(firstDraw(3)).toEqual({ type: 'drawMonsterCards', difficulty: 2 });
		// Ten dice: even Difficulty 3 is a likely kill.
		expect(firstDraw(10)).toEqual({ type: 'drawMonsterCards', difficulty: 3 });
		// No deck is a likely kill → the lowest difficulty that still has cards.
		expect(firstDraw(1, [MONSTERS.d2, MONSTERS.d3])).toEqual({ type: 'drawMonsterCards', difficulty: 2 });
	});

	it('plans draw → keep in one legal batch so the fight has a card in hand', () => {
		let state = redAt('Arcane Abyss');
		setDeck(state, [MONSTERS.d1Weak, MONSTERS.d1Tough, MONSTERS.d2]);
		const plan = planMonsterCardCommands(state, 'Red', CATALOG);
		// A draw reveals the top card of the deck only.
		expect(plan).toEqual([
			{ type: 'drawMonsterCards', difficulty: 1 },
			{ type: 'keepMonsterCard', index: 0 }
		]);
		for (const command of plan) state = apply(state, botActorFor(state, 'Red'), command);
		expect(state.players.Red!.monsterHand?.map((c) => c.id)).toEqual(['d1-weak']);
		// The other cards stay in the deck; nothing more to do this visit.
		expect(state.bags.monsters.contents.map((entry) => entry.id).sort()).toEqual(['d1-tough', 'd2']);
		expect(planMonsterCardCommands(state, 'Red', CATALOG)).toEqual([]);
		expect(bestStartCombatCommand(state, 'Red', CATALOG)).toEqual({ type: 'startCombat', handIndex: 0 });
	});

	it('does nothing outside the Arcane Abyss or outside the location phase', () => {
		const elsewhere = redAt('Forest Region');
		expect(planMonsterCardCommands(elsewhere, 'Red', CATALOG)).toEqual([]);

		const navigating = startedGame();
		expect(navigating.phase).toBe('navigation');
		expect(planMonsterCardCommands(navigating, 'Red', CATALOG)).toEqual([]);
	});

	it('draws only while the hand has room and holds no likely kill', () => {
		// A likely kill in hand → fight it, no draw.
		const holding = redAt('Arcane Abyss');
		holding.players.Red!.monsterHand = [card(MONSTERS.d1Weak)];
		expect(planMonsterCardCommands(holding, 'Red', CATALOG)).toEqual([]);

		// Only an unlikely kill in hand → draw a better card (combat use does not matter).
		const stuck = redAt('Arcane Abyss');
		setDeck(stuck, [MONSTERS.d1Weak, MONSTERS.d1Tough]);
		stuck.players.Red!.monsterHand = [card(MONSTERS.d3)];
		stuck.players.Red!.actionsUsedThisRound = ['combat'];
		expect(nextMonsterCardCommand(stuck, 'Red', CATALOG)).toEqual({ type: 'drawMonsterCards', difficulty: 1 });

		// A full hand (3 cards) never draws.
		const full = redAt('Arcane Abyss');
		full.players.Red!.monsterHand = [card(MONSTERS.d3), card(MONSTERS.d3), card(MONSTERS.d3)];
		expect(planMonsterCardCommands(full, 'Red', CATALOG)).toEqual([]);

		// One draw per visit.
		const drawn = redAt('Arcane Abyss');
		drawn.players.Red!.monsterDrawRound = drawn.round;
		expect(planMonsterCardCommands(drawn, 'Red', CATALOG)).toEqual([]);
	});

	it('previews the Abyss for navigation: best hand card, else the weakest deck card', () => {
		const state = startedGame();
		armRed(state, 1);
		expect(abyssPreviewMonster(state, 'Red', CATALOG)?.id).toBe('d1-weak');

		state.players.Red!.monsterHand = [card(MONSTERS.d2), card(MONSTERS.d1Tough)];
		expect(abyssPreviewMonster(state, 'Red', CATALOG)?.id).toBe('d1-tough');

		state.players.Red!.monsterHand = [];
		setDeck(state, []);
		expect(abyssPreviewMonster(state, 'Red', CATALOG)).toBeNull();
	});
});

describe('bot kill math for persistent monsters', () => {
	it('needs the Barrier left, not the printed Barrier', () => {
		const state = redAt('Arcane Abyss');
		const chipped = card(MONSTERS.d3); // Barrier 9 when fresh
		state.players.Red!.monsterHand = [{ ...chipped, hp: 1 }];
		expect(computeKillProbability(state, 'Red', CATALOG)).toBeCloseTo(4 / 6); // one arcane die ≥ 1
		state.players.Red!.monsterHand = [{ ...chipped, hp: 4 }];
		expect(computeKillProbability(state, 'Red', CATALOG)).toBeCloseTo(1 / 6); // needs a 5
		state.players.Red!.monsterHand = [{ ...chipped, hp: 0 }];
		expect(computeKillProbability(state, 'Red', CATALOG)).toBe(0); // already defeated
	});

	it('scores the best hand card by default, or an explicit card', () => {
		const state = redAt('Arcane Abyss');
		state.players.Red!.monsterHand = [card(MONSTERS.d3), { ...card(MONSTERS.d3), hp: 4 }];
		expect(computeKillProbability(state, 'Red', CATALOG)).toBeCloseTo(1 / 6);
		expect(computeKillProbability(state, 'Red', CATALOG, { monster: card(MONSTERS.d1Weak) })).toBeCloseTo(4 / 6);
		expect(computeKillProbability(state, 'Red', CATALOG, { monster: null })).toBe(0);
		state.players.Red!.monsterHand = [];
		expect(computeKillProbability(state, 'Red', CATALOG)).toBe(0); // empty hand
	});
});

describe('heuristic planners at the Abyss', () => {
	const firstChoice: BotRandom = { int: () => 0, chance: () => false };

	it('fight a card from the hand in one location turn', () => {
		for (const profile of ['medium', 'random']) {
			const state = redAt('Arcane Abyss', 10);
			state.players.Red!.monsterHand = [card(MONSTERS.d2), card(MONSTERS.d1Weak)];
			const alwaysFight: BotRandom = { int: () => 0, chance: () => true };
			const plan = planBotPhaseActions(state, 'Red', CATALOG, alwaysFight, profileFor(profile));
			const types = plan.map((c) => c.type);
			expect(types.slice(0, 2), profile).toEqual(['startCombat', 'resolveMonsterReward']);
			expect(types.at(-1), profile).toBe('endLocationActions');
			expect(types, profile).not.toContain('drawMonsterCards');
		}
	});

	it('the medium bot fights the hand card it is most likely to kill', () => {
		const state = redAt('Arcane Abyss', 1);
		state.players.Red!.monsterHand = [card(MONSTERS.d1Tough), card(MONSTERS.d1Weak)];
		const plan = planBotPhaseActions(state, 'Red', CATALOG, firstChoice, profileFor('medium'));
		expect(plan[0]).toEqual({ type: 'startCombat', handIndex: 1 });
	});

	/** Run the medium planner (through any navigation-power prompt) until it locks a destination. */
	function lockedDestination(state: PublicGameState): NavigationDestination | null {
		for (let tick = 0; tick < 8; tick++) {
			const plan = planBotPhaseActions(state, 'Red', CATALOG, firstChoice, profileFor('medium'));
			if (plan.length === 0) return null;
			for (const command of plan) {
				if (command.type === 'lockNavigation') return command.destination;
				state = apply(state, botActorFor(state, 'Red'), command);
			}
		}
		return null;
	}

	it('heads to the Abyss to fight a hand card it can kill', () => {
		const state = startedGame();
		armRed(state, 10);
		state.players.Red!.monsterHand = [card(MONSTERS.d1Tough)];
		expect(lockedDestination(state)).toBe('Arcane Abyss');
	});

	it('does not head to the Abyss when no monster card is left anywhere', () => {
		const state = startedGame();
		armRed(state, 10);
		setDeck(state, []);
		const destination = lockedDestination(state);
		expect(destination).not.toBeNull();
		expect(destination).not.toBe('Arcane Abyss');
	});
});

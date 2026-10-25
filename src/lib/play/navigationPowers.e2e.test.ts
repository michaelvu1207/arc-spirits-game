import { describe, expect, it } from 'vitest';
import { applyGameCommand, buildSessionProjection, createLobbyState } from './runtime';
import { NAVIGATION_POWERS, type NavigationPowerId } from './navigationPowers';
import { originRuneOptions } from './locationInteractions';
import { SPIRIT_AUGMENT_CLASSES } from './augments';
import type {
	GameActor,
	GameCommand,
	NavigationDestination,
	PlayCatalog,
	PlaySpirit,
	PublicGameState,
	SeatColor
} from './types';

const REST = 'bdded3f5-e405-4b68-b63a-9f5c2139beea';
const CULTIVATE = '60e40dd5-c3cc-4f26-9aa3-2043b4106ade';
const VP5 = '9cf8e1dd-55e0-4926-8dc8-2fb5b7b96bd4';
const ORIGINS = ['Forest Region', 'Fire Region', 'Mountain Region', 'Water Region'];
const RUNES = originRuneOptions();
const CATALOG: PlayCatalog = {
	guardians: [
		{ id: 'g-red', name: 'Red Guard', originId: null },
		{ id: 'g-blue', name: 'Blue Guard', originId: null },
		{ id: 'g-orange', name: 'Orange Guard', originId: null }
	],
	classes: SPIRIT_AUGMENT_CLASSES.map((name, i) => ({
		id: `class-${i}`,
		name,
		classType: 'normal',
		isSpecial: false,
		effectSchema: null
	})),
	mats: [],
	dice: [],
	spirits: Array.from({ length: 24 }, (_, i) => ({
		id: `spirit-${i}`,
		name: `Spirit ${i}`,
		cost: 3,
		classes: {},
		origins: { [ORIGINS[i % 4]]: 1 }
	})),
	monsters: [
		{
			id: 'monster-1',
			name: 'Practice Wyrm',
			damage: 1,
			barrier: 1,
			rewardTrack: [VP5, VP5, VP5],
			dicePool: [],
			chooseAmount: 3,
			stage: 1,
			order: 0
		},
		{
			id: 'monster-2',
			name: 'Ancient Wyrm',
			damage: 1,
			barrier: 1,
			rewardTrack: [VP5, VP5, VP5],
			dicePool: [],
			chooseAmount: 3,
			stage: 1,
			order: 1
		},
		{
			id: 'monster-3',
			name: 'Final Wyrm',
			damage: 1,
			barrier: 1,
			rewardTrack: [VP5, VP5, VP5],
			dicePool: [],
			chooseAmount: 3,
			stage: 1,
			order: 2
		}
	],
	locations: [
		{
			name: 'Forest Region',
			originId: RUNES[0].originId,
			rewardRows: [{ type: 'gain', gain_icon_ids: [CULTIVATE] }, { type: 'trade', cost_icon_ids: ['36aab6c9-b98c-4e84-b097-e743f45dde82'], gain_icon_ids: ['navigation-power'] }]
		},
		{
			name: 'Fire Region',
			originId: RUNES[2].originId,
			rewardRows: [{ type: 'gain', gain_icon_ids: [REST] }, { type: 'trade', cost_icon_ids: ['36aab6c9-b98c-4e84-b097-e743f45dde82'], gain_icon_ids: ['navigation-power'] }]
		},
		{
			name: 'Mountain Region',
			originId: RUNES[1].originId,
			rewardRows: [{ type: 'gain', gain_icon_ids: [REST] }, { type: 'trade', cost_icon_ids: ['36aab6c9-b98c-4e84-b097-e743f45dde82'], gain_icon_ids: ['navigation-power'] }]
		},
		{
			name: 'Water Region',
			originId: RUNES[3].originId,
			rewardRows: [{ type: 'gain', gain_icon_ids: [REST] }, { type: 'trade', cost_icon_ids: ['36aab6c9-b98c-4e84-b097-e743f45dde82'], gain_icon_ids: ['navigation-power'] }]
		}
	]
};
const actor = (seat: SeatColor): GameActor => ({
	memberId: `member-${seat}`,
	displayName: seat,
	role: seat === 'Red' ? 'host' : 'player',
	seatColor: seat
});
function run(s: PublicGameState, seat: SeatColor, cmd: GameCommand | Record<string, unknown>) {
	const r = applyGameCommand(s, actor(seat), cmd as GameCommand, CATALOG);
	if (!r.ok) throw Error(`${seat} ${cmd.type}: ${r.error.code}: ${r.error.message}`);
	return r.state;
}
function start(seats: SeatColor[] = ['Red', 'Blue'], seed = 9) {
	let s = createLobbyState({ roomCode: 'NAVPOW', guardianNames: seats.map((c) => `${c} Guard`) });
	for (const seat of seats) {
		s = run(s, seat, { type: 'claimSeat', seatColor: seat });
		s = run(s, seat, { type: 'selectGuardian', guardianName: `${seat} Guard` });
	}
	s = run(s, 'Red', { type: 'startGame', seed });
	for (const seat of seats) {
		const p = s.players[seat]!;
		p.pendingPowerDrafts = [];
		p.spirits = [];
		p.mats = [];
		p.barrier = 8;
		p.maxBarrier = 10;
		p.brokenBarrier = 2;
	}
	return s;
}
function spirit(slotIndex: number, overrides: Partial<PlaySpirit> = {}): PlaySpirit {
	return {
		slotIndex,
		id: `owned-${slotIndex}`,
		name: `Owned ${slotIndex}`,
		cost: 3,
		classes: {},
		origins: { 'Forest Region': 1 },
		isFaceDown: false,
		...overrides
	};
}
function giveRune(s: PublicGameState, seat: SeatColor, index = 0) {
	const r = RUNES[index];
	const p = s.players[seat]!;
	p.mats.push({
		slotIndex: p.mats.length + 1,
		hasRune: true,
		id: r.runeId,
		name: r.name,
		type: 'rune',
		originId: r.originId ?? undefined
	});
}
function reveal(
	s: PublicGameState,
	power: NavigationPowerId,
	destination: NavigationDestination = 'Mountain Region',
	blueDestination = destination
) {
	s.players.Red!.powerInventory = [power];
	s = run(s, 'Red', { type: 'lockNavigation', destination, navigationPowerId: power });
	for (const seat of s.activeSeats.filter((x) => x !== 'Red'))
		s = run(s, seat, { type: 'lockNavigation', destination: blueDestination });
	return run(s, 'Red', { type: 'forceAdvancePhase' });
}
function choose(s: PublicGameState, seat: SeatColor, option?: string) {
	const offer = s.players[seat]?.navigationPowerOffers?.[0];
	expect(offer, `${seat} should have an optional Navigation Power effect`).toBeTruthy();
	const id = option ?? offer!.options.find((x) => x.id !== 'decline')!.id;
	return run(s, seat, { type: 'resolveNavigationPower', offerId: offer!.id, optionId: id });
}
function settleOffers(s: PublicGameState, accept = true) {
	for (let i = 0; i < 20; i++) {
		const seat = s.activeSeats.find((seat) => s.players[seat]?.navigationPowerOffers?.length);
		if (!seat) return s;
		const offer = s.players[seat]!.navigationPowerOffers![0];
		s = choose(
			s,
			seat,
			!accept && offer.options.some((x) => x.id === 'decline') ? 'decline' : undefined
		);
	}
	throw Error('Power resolution failed to terminate');
}
function closeRound(s: PublicGameState) {
	const round = s.round;
	for (let i = 0; i < 50 && s.status === 'active' && s.round === round; i++) {
		s = settleOffers(s, false);
		if (s.phase === 'encounter') {
			for (const seat of s.activeSeats)
				if (s.phase === 'encounter') s = run(s, seat, { type: 'passEncounter' });
		} else if (s.phase === 'location') {
			for (const seat of s.activeSeats)
				if (s.phase === 'location' && !s.players[seat]!.phaseReady)
					s = run(s, seat, { type: 'endLocationActions' });
		} else if (s.phase === 'benefits') {
			for (const seat of s.activeSeats)
				if (s.phase === 'benefits' && !s.players[seat]!.phaseReady)
					s = run(s, seat, { type: 'commitBenefits' });
		} else if (s.phase === 'awakening') {
			for (const seat of s.activeSeats)
				if (s.phase === 'awakening' && !s.players[seat]!.phaseReady)
					s = run(s, seat, { type: 'commitAwakening' });
		} else if (s.phase === 'cleanup') {
			for (const seat of s.activeSeats)
				if (s.phase === 'cleanup' && !s.players[seat]!.phaseReady)
					s = run(s, seat, { type: 'commitCleanup' });
		}
	}
	expect(s.status === 'finished' || s.round > round).toBe(true);
	return s;
}

describe('Navigation Powers through live game commands', () => {
	it('drafts three choices, keeps exactly one, consumes only a held power, and preserves hidden choices', () => {
		let s = start();
		s.players.Red!.pendingPowerDrafts = [['thorn-ward', 'ember-charge', 'battle-fury']];
		const rejected = applyGameCommand(
			s,
			actor('Red'),
			{ type: 'chooseNavigationPower', powerId: 'mountains-wealth' } as GameCommand,
			CATALOG
		);
		expect(rejected.ok).toBe(false);
		s = run(s, 'Red', { type: 'chooseNavigationPower', powerId: 'ember-charge' });
		expect(s.players.Red!.powerInventory).toEqual(['ember-charge']);
		expect(s.players.Red!.pendingPowerDrafts).toEqual([]);
		const invalid = applyGameCommand(
			s,
			actor('Red'),
			{ type: 'lockNavigation', destination: 'Mountain Region', navigationPowerId: 'battle-fury' },
			CATALOG
		);
		expect(invalid.ok).toBe(false);
		s = run(s, 'Red', {
			type: 'lockNavigation',
			destination: 'Mountain Region',
			navigationPowerId: 'ember-charge'
		});
		const otherView = buildSessionProjection(s, {
			role: 'player',
			seatColor: 'Blue',
			displayName: 'Blue'
		});
		expect(otherView.players.Red!.pendingNavigationPower).toBeNull();
		expect(otherView.players.Red!.powerInventory ?? []).toEqual([]);
		expect(otherView.players.Red!.pendingPowerDrafts ?? []).toEqual([]);
		s = run(s, 'Red', { type: 'unlockNavigation' });
		expect(s.players.Red!.powerInventory).toEqual(['ember-charge']);
		s = reveal(s, 'ember-charge');
		expect(s.players.Red!.powerInventory).toEqual([]);
		expect(s.players.Red!.navigationPower).toBe('ember-charge');
	});

	it.each(NAVIGATION_POWERS.map((p) => [p.id] as const))(
		'%s can be declined without effect, consumed once, and cleared at the round boundary',
		(id) => {
			let s = start();
			s.players.Blue!.statusLevel = 3;
			giveRune(s, 'Red');
			giveRune(s, 'Blue');
			s.players.Red!.spirits = [spirit(1, { isFaceDown: true })];
			s.players.Blue!.spirits = [spirit(1)];
			s.players.Blue!.spiritAugmentAttachments = [
				{
					runeId: 'augment',
					spiritId: 'owned-1',
					spiritSlotIndex: 1,
					classId: 'class-0',
					className: 'Fighter'
				}
			];
			const dest: NavigationDestination =
				id === 'abyssal-execution'
					? 'Arcane Abyss'
					: ['cinder-awakening', 'fires-rhythm'].includes(id)
						? 'Fire Region'
						: ['forest-bounty', 'forests-rhythm'].includes(id)
							? 'Forest Region'
							: ['tidal-arsenal'].includes(id)
								? 'Water Region'
								: 'Mountain Region';
			s = reveal(s, id, dest);
			const offer = s.players.Red!.navigationPowerOffers?.[0];
			if (offer) {
				const barrier = s.players.Red!.barrier;
				s = choose(s, 'Red', 'decline');
				expect(s.players.Red!.barrier).toBe(barrier);
				const duplicate = applyGameCommand(
					s,
					actor('Red'),
					{ type: 'resolveNavigationPower', offerId: offer.id, optionId: 'decline' } as GameCommand,
					CATALOG
				);
				expect(duplicate.ok).toBe(false);
			}
			s.players.Red!.spirits = [];
			s = closeRound(s);
			expect(s.players.Red!.navigationPower).toBeNull();
			expect(s.players.Red!.navigationPowerOffers ?? []).toEqual([]);
			expect(s.players.Red!.powerInventory).not.toContain(id);
		}
	);

	it('1 Thorn Ward damages every co-located opponent and grants VP only for damage dealt', () => {
		let s = start(['Red', 'Blue', 'Orange']);
		s = reveal(s, 'thorn-ward');
		s = choose(s, 'Red');
		expect(s.players.Blue!.barrier).toBe(7);
		expect(s.players.Orange!.barrier).toBe(7);
		expect(s.players.Red!.victoryPoints).toBe(2);
	});
	it('2 restoration is optional and clamps at capacity', () => {
		let s = reveal(start(), 'ember-charge');
		s = choose(s, 'Red');
		expect(s.players.Red!.barrier).toBe(10);
		expect(s.players.Red!.brokenBarrier).toBe(0);
	});
	it('3 the rune owner chooses which rune transfers, once', () => {
		let s = start();
		giveRune(s, 'Blue', 0);
		giveRune(s, 'Blue', 1);
		s = reveal(s, 'stone-shelter');
		s = choose(s, 'Red');
		expect(s.players.Blue!.navigationPowerOffers).toHaveLength(1);
		const give = s.players.Blue!.navigationPowerOffers![0];
		s = choose(s, 'Blue', give.options[1].id);
		expect(s.players.Blue!.mats.filter((m) => m.hasRune)).toHaveLength(1);
		expect(s.players.Red!.mats.find((m) => m.hasRune)?.id).toBe(RUNES[1].runeId);
	});
	it('4 each location row can resolve one additional time but never a third time', () => {
		let s = reveal(start(), 'tidal-tempo', 'Forest Region');
		s = choose(s, 'Red');
		s = run(s, 'Red', { type: 'resolveLocationInteraction', rowIndex: 0 });
		s = run(s, 'Red', { type: 'resolveLocationInteraction', rowIndex: 0 });
		expect(
			applyGameCommand(
				s,
				actor('Red'),
				{ type: 'resolveLocationInteraction', rowIndex: 0 },
				CATALOG
			).ok
		).toBe(false);
	});
	it('5 a consensual trade swaps runes atomically; a declined trade changes nothing', () => {
		let s = start();
		giveRune(s, 'Red', 0);
		giveRune(s, 'Blue', 1);
		s = reveal(s, 'shared-current');
		s = choose(s, 'Red');
		const draft = {
			type: 'tradeNavigationPower',
			targetSeat: 'Blue',
			giveRuneSlots: [1],
			receiveRuneSlots: [1],
			giveSpiritSlots: [],
			receiveSpiritSlots: []
		};
		s = run(s, 'Red', draft);
		s = run(s, 'Blue', {
			type: 'respondNavigationPowerTrade',
			tradeId: s.players.Blue!.pendingNavigationTrade!.id,
			accept: false
		});
		expect(s.players.Red!.mats.find((m) => m.hasRune)?.id).toBe(RUNES[0].runeId);
		s = run(s, 'Red', draft);
		s = run(s, 'Blue', {
			type: 'respondNavigationPowerTrade',
			tradeId: s.players.Blue!.pendingNavigationTrade!.id,
			accept: true
		});
		expect(s.players.Red!.mats.find((m) => m.hasRune)?.id).toBe(RUNES[1].runeId);
		expect(s.players.Blue!.mats.find((m) => m.hasRune)?.id).toBe(RUNES[0].runeId);
	});
	it('6 the exchange pays one rune and grants two of the chosen type', () => {
		let s = start();
		giveRune(s, 'Red');
		s = reveal(s, 'watchful-eye');
		s = choose(s, 'Red');
		const held = s.players.Red!.mats.filter((m) => m.hasRune);
		expect(held).toHaveLength(2);
		expect(held[0].id).toBe(held[1].id);
	});
	it('7 a stolen augment leaves its original host and enters the thief placement pouch', () => {
		let s = start();
		s.players.Blue!.spirits = [spirit(1)];
		s.players.Blue!.spiritAugmentAttachments = [
			{
				runeId: 'fighter-augment',
				spiritId: 'owned-1',
				spiritSlotIndex: 1,
				className: 'Fighter',
				classId: 'class-0'
			}
		];
		s = reveal(s, 'augment-relay');
		s = choose(s, 'Red');
		expect(s.players.Blue!.spiritAugmentAttachments).toEqual([]);
		expect(s.players.Red!.unplacedAugments).toHaveLength(1);
		expect(s.players.Red!.unplacedAugments![0].classId).toBe('class-0');
	});
	it('8 double damage uses combat rolls and does not permanently alter the dice pool', () => {
		let s = start();
		s.players.Red!.attackDice = [{ instanceId: 'arc', tier: 'arcane' }];
		s = reveal(s, 'guardians-accord', 'Arcane Abyss');
		s = choose(s, 'Red');
		s = run(s, 'Red', { type: 'startCombat' });
		expect(s.combats[0].sides[0].damageDealt % 2).toBe(0);
		expect(s.players.Red!.attackDice).toHaveLength(1);
	});
	it('9 the Evil co-location trigger damages Evil players across locations', () => {
		let s = start(['Red', 'Blue', 'Orange']);
		s.players.Blue!.statusLevel = 3;
		s.players.Orange!.statusLevel = 3;
		s.players.Red!.spirits = [
			spirit(1, { cost: 7, origins: { 'Arcane Spirits': 1 } }),
			spirit(2, { cost: 9, origins: { Sun: 1 } })
		];
		s.players.Red!.powerInventory = ['abyssal-reckoning'];
		s = run(s, 'Red', {
			type: 'lockNavigation',
			destination: 'Mountain Region',
			navigationPowerId: 'abyssal-reckoning'
		});
		s = run(s, 'Blue', { type: 'lockNavigation', destination: 'Mountain Region' });
		s = run(s, 'Orange', { type: 'lockNavigation', destination: 'Forest Region' });
		s = run(s, 'Red', { type: 'forceAdvancePhase' });
		s = choose(s, 'Red');
		expect(s.players.Blue!.barrier).toBe(6);
		expect(s.players.Orange!.barrier).toBe(6);
	});
	it('10 free awakening works without paying the spirit awakening cost', () => {
		let s = start();
		s.players.Blue!.statusLevel = 3;
		s.players.Red!.spirits = [spirit(1, { isFaceDown: true })];
		s = reveal(s, 'cinder-awakening', 'Fire Region');
		s = choose(s, 'Red');
		expect(s.players.Red!.spirits[0].isFaceDown).toBe(false);
		expect(s.players.Red!.mats).toEqual([]);
	});
	it('11 free monster defeat spends a life and opens the normal monster reward picker', () => {
		let s = start();
		s.players.Blue!.statusLevel = 3;
		s = reveal(s, 'abyssal-execution', 'Arcane Abyss');
		const lives = s.monster!.livesRemaining;
		s = choose(s, 'Red');
		expect(s.monster!.livesRemaining).toBe(lives - 1);
		expect(s.players.Red!.pendingReward?.monsterId).toBe('monster-1');
		expect(s.players.Red!.barrier).toBe(8);
		s = run(s, 'Red', { type: 'resolveMonsterReward', picks: [0, 1, 2] });
		expect(s.players.Red!.victoryPoints).toBe(15);
	});
	it('12 all three requested augments can be picked separately', () => {
		let s = start();
		s.players.Blue!.statusLevel = 3;
		s = reveal(s, 'forest-bounty', 'Forest Region');
		s = choose(s, 'Red', 'Fighter');
		s = choose(s, 'Red', 'Elementalist');
		s = choose(s, 'Red', 'Soul Weaver');
		expect(s.players.Red!.unplacedAugments?.map((a) => a.classId)).toEqual([
			'class-0',
			'class-1',
			'class-3'
		]);
		expect(s.players.Red!.navigationPowerOffers).toEqual([]);
	});
	it.each(['potential', 'barrier'])(
		'13 Mountain Bastion resolves the chosen %s benefit',
		(option) => {
			let s = start();
			s.players.Blue!.statusLevel = 3;
			s.players.Red!.maxBarrier = 5;
			s.players.Red!.barrier = 1;
			s.players.Red!.brokenBarrier = 4;
			s = reveal(s, 'mountain-bastion');
			s = choose(s, 'Red', option);
			expect(s.players.Red!.maxBarrier).toBe(option === 'potential' ? 8 : 5);
			expect(s.players.Red!.barrier).toBe(option === 'potential' ? 1 : 5);
		}
	);
	it('14 the three random powers are reproducible from the same seed', () => {
		const play = () => {
			let s = start();
			s.players.Blue!.statusLevel = 3;
			s = reveal(s, 'tidal-arsenal', 'Water Region');
			return choose(s, 'Red');
		};
		const a = play(),
			b = play();
		expect(a.players.Red!.powerInventory).toHaveLength(3);
		expect(a.players.Red!.powerInventory).toEqual(b.players.Red!.powerInventory);
	});
	it('15 temporary Arcane dice participate in the fight then leave the persistent pool', () => {
		let s = reveal(start(), 'battle-fury', 'Arcane Abyss');
		s = choose(s, 'Red');
		s = run(s, 'Red', { type: 'startCombat' });
		expect(s.combats[0].sides[0].damageDealt).toBeGreaterThanOrEqual(2);
		expect(s.players.Red!.attackDice).toEqual([]);
	});
	it('16 battle guard reduces the incoming monster hit', () => {
		let s = reveal(start(), 'battle-guard', 'Arcane Abyss');
		s = choose(s, 'Red');
		s = run(s, 'Red', { type: 'startCombat' });
		expect(s.players.Red!.barrier).toBe(8);
	});
	it('17 engaging in PvP adds two VP alongside the ordinary engagement award', () => {
		let s = start();
		s.players.Red!.statusLevel = 3;
		s = reveal(s, 'battle-reward');
		s = choose(s, 'Red');
		s = run(s, 'Red', { type: 'initiatePvp' });
		expect(s.players.Red!.victoryPoints).toBe(4);
	});
	it('18 failure recovery increases Potential and restores Barrier only after a failed fight', () => {
		let s = start();
		s.players.Red!.maxBarrier = 4;
		s.players.Red!.barrier = 4;
		s.players.Red!.brokenBarrier = 0;
		s = reveal(s, 'unbroken-assault', 'Arcane Abyss');
		s = choose(s, 'Red');
		s = run(s, 'Red', { type: 'startCombat' });
		s = choose(s, 'Red');
		expect(s.players.Red!.maxBarrier).toBe(8);
		expect(s.players.Red!.barrier).toBe(7);
	});
	it('19 a failed fight offers two VP and remains optional', () => {
		let s = reveal(start(), 'duelists-prize', 'Arcane Abyss');
		s = choose(s, 'Red');
		s = run(s, 'Red', { type: 'startCombat' });
		s = choose(s, 'Red');
		expect(s.players.Red!.victoryPoints).toBe(2);
	});
	it('20 Rest twice heals four Barrier through the real Rest effect', () => {
		let s = start();
		s.players.Red!.barrier = 2;
		s.players.Red!.brokenBarrier = 8;
		s = reveal(s, 'fires-rhythm', 'Fire Region');
		s = choose(s, 'Red', '2');
		expect(s.players.Red!.barrier).toBe(6);
	});
	it('21 Cultivate twice produces both rune grants', () => {
		let s = start();
		s.players.Red!.spirits = [spirit(1), spirit(2)];
		s = reveal(s, 'forests-rhythm', 'Forest Region');
		s = choose(s, 'Red', '2');
		expect(s.players.Red!.mats.filter((m) => m.hasRune)).toHaveLength(2);
	});
	it('22 Mountain wealth grants two independently chosen runes', () => {
		let s = reveal(start(), 'mountains-wealth');
		s = choose(s, 'Red', RUNES[0].runeId);
		s = choose(s, 'Red', RUNES[1].runeId);
		expect(s.players.Red!.mats.filter((m) => m.hasRune).map((m) => m.id)).toEqual([
			RUNES[0].runeId,
			RUNES[1].runeId
		]);
	});
	it('a region-specific power fails harmlessly at another destination', () => {
		let s = start();
		s.players.Blue!.statusLevel = 3;
		s = reveal(s, 'forest-bounty', 'Mountain Region');
		expect(s.players.Red!.navigationPowerOffers ?? []).toEqual([]);
		expect(s.players.Red!.unplacedAugments ?? []).toEqual([]);
	});
	it('a whole game uses, expires, and does not replay the bonus before winning through normal reward choices', () => {
		let s = start();
		s.players.Red!.attackDice = [{ instanceId: 'normal-arcane', tier: 'arcane' }];
		s = reveal(s, 'battle-fury', 'Arcane Abyss');
		s = choose(s, 'Red');
		s = run(s, 'Red', { type: 'startCombat' });
		s = run(s, 'Red', { type: 'resolveMonsterReward', picks: [0, 1, 2] });
		expect(s.players.Red!.victoryPoints).toBe(15);
		s = closeRound(s);
		expect(s.players.Red!.navigationPower).toBeNull();
		expect(s.players.Red!.attackDice).toHaveLength(1);
		s = run(s, 'Red', { type: 'lockNavigation', destination: 'Arcane Abyss' });
		s = run(s, 'Blue', { type: 'lockNavigation', destination: 'Mountain Region' });
		s = run(s, 'Red', { type: 'forceAdvancePhase' });
		s = run(s, 'Red', { type: 'startCombat' });
		s = run(s, 'Red', { type: 'resolveMonsterReward', picks: [0, 1, 2] });
		s = closeRound(s);
		expect(s.status).toBe('finished');
		expect(s.winnerSeat).toBe('Red');
		expect(s.players.Red!.victoryPoints).toBe(30);
	});
	it('Forest acquisition pays one Rune and gains one random Power without a draft', () => {
  let s=start();giveRune(s,'Red');
  s=run(s,'Red',{type:'lockNavigation',destination:'Forest Region'});
  s=run(s,'Blue',{type:'lockNavigation',destination:'Water Region'});
  s=run(s,'Red',{type:'forceAdvancePhase'});
  s=run(s,'Red',{type:'acquireNavigationPower',runeSlot:1});
  expect(s.players.Red!.mats.filter(m=>m.hasRune)).toHaveLength(0);
  expect(s.players.Red!.powerInventory).toHaveLength(1);
  expect(s.players.Red!.pendingPowerDrafts).toEqual([]);
  expect(applyGameCommand(s,actor('Red'),{type:'acquireNavigationPower',runeSlot:1},CATALOG).ok).toBe(false);
 });
	it('an offer cannot be resolved by another seat, and malformed choices change nothing', () => {
		let s = reveal(start(), 'ember-charge');
		const offer = s.players.Red!.navigationPowerOffers![0];
		const before = JSON.stringify(s);
		expect(
			applyGameCommand(
				s,
				actor('Blue'),
				{ type: 'resolveNavigationPower', offerId: offer.id, optionId: 'accept' } as GameCommand,
				CATALOG
			).ok
		).toBe(false);
		expect(
			applyGameCommand(
				s,
				actor('Red'),
				{ type: 'resolveNavigationPower', offerId: offer.id, optionId: 'invented' } as GameCommand,
				CATALOG
			).ok
		).toBe(false);
		expect(JSON.stringify(s)).toBe(before);
	});
	it('a multi-spirit trade transfers the chosen spirit and its attached augment together', () => {
		let s = start();
		s.players.Red!.spirits = [spirit(1), spirit(2)];
		s.players.Blue!.spirits = [spirit(1, { id: 'other-spirit' })];
		s.players.Red!.spiritAugmentAttachments = [
			{
				runeId: 'bound-augment',
				spiritId: 'owned-1',
				spiritSlotIndex: 1,
				className: 'Fighter',
				classId: 'class-0'
			}
		];
		s = reveal(s, 'shared-current');
		s = choose(s, 'Red');
		s = run(s, 'Red', {
			type: 'tradeNavigationPower',
			targetSeat: 'Blue',
			giveSpiritSlots: [1],
			receiveSpiritSlots: [1]
		});
		s = run(s, 'Blue', {
			type: 'respondNavigationPowerTrade',
			tradeId: s.players.Blue!.pendingNavigationTrade!.id,
			accept: true
		});
		expect(s.players.Red!.spirits.map((x) => x.id)).toContain('other-spirit');
		expect(s.players.Blue!.spirits.map((x) => x.id)).toContain('owned-1');
		expect(s.players.Red!.spiritAugmentAttachments).toEqual([]);
		const attachment = s.players.Blue!.spiritAugmentAttachments[0];
		expect(attachment.spiritId).toBe('owned-1');
		expect(s.players.Blue!.spirits.find((x) => x.id === 'owned-1')!.slotIndex).toBe(
			attachment.spiritSlotIndex
		);
	});
	it('two thieves cannot steal a different augment after their target moves', () => {
		let s = start(['Red', 'Blue', 'Orange']);
		s.players.Blue!.spirits = [spirit(1)];
		s.players.Blue!.spiritAugmentAttachments = [
			{
				runeId: 'first',
				spiritId: 'owned-1',
				spiritSlotIndex: 1,
				className: 'Fighter',
				classId: 'class-0'
			},
			{
				runeId: 'second',
				spiritId: 'owned-1',
				spiritSlotIndex: 1,
				className: 'Elementalist',
				classId: 'class-1'
			}
		];
		s.players.Red!.powerInventory = ['augment-relay'];
		s.players.Orange!.powerInventory = ['augment-relay'];
		s = run(s, 'Red', {
			type: 'lockNavigation',
			destination: 'Mountain Region',
			navigationPowerId: 'augment-relay'
		});
		s = run(s, 'Blue', { type: 'lockNavigation', destination: 'Mountain Region' });
		s = run(s, 'Orange', {
			type: 'lockNavigation',
			destination: 'Mountain Region',
			navigationPowerId: 'augment-relay'
		});
		s = run(s, 'Red', { type: 'forceAdvancePhase' });
		const stale = s.players.Orange!.navigationPowerOffers![0];
		const first = stale.options[0].id;
		s = choose(s, 'Red');
		const rejection = applyGameCommand(
			s,
			actor('Orange'),
			{ type: 'resolveNavigationPower', offerId: stale.id, optionId: first } as GameCommand,
			CATALOG
		);
		expect(rejection.ok).toBe(false);
		expect(s.players.Blue!.spiritAugmentAttachments.map((a) => a.runeId)).toEqual(['second']);
		s = choose(s, 'Orange', 'decline');
	});

	it.each(NAVIGATION_POWERS.map((p) => [p.id] as const))(
		'%s permits a complete game to reach its natural terminal state after resolution',
		(id) => {
			let s = start();
			s.players.Red!.spirits = [
				spirit(1, { isFaceDown: id === 'cinder-awakening' }),
				spirit(2),
				spirit(3)
			];
			s.players.Blue!.spirits = [spirit(1, { id: 'other-spirit' })];
			s.players.Red!.attackDice = [
				{ instanceId: 'a1', tier: 'arcane' },
				{ instanceId: 'a2', tier: 'arcane' }
			];
			s.players.Blue!.statusLevel = 3;
			giveRune(s, 'Red');
			giveRune(s, 'Blue');
			s.players.Blue!.spiritAugmentAttachments = [
				{
					runeId: 'fighter',
					spiritId: 'other-spirit',
					spiritSlotIndex: 1,
					className: 'Fighter',
					classId: 'class-0'
				}
			];
			const dest: NavigationDestination = [
				'abyssal-execution',
				'battle-fury',
				'battle-guard',
				'unbroken-assault',
				'duelists-prize',
				'guardians-accord'
			].includes(id)
				? 'Arcane Abyss'
				: ['fires-rhythm', 'cinder-awakening'].includes(id)
					? 'Fire Region'
					: ['forests-rhythm', 'forest-bounty'].includes(id)
						? 'Forest Region'
						: id === 'tidal-arsenal'
							? 'Water Region'
							: 'Mountain Region';
			s = reveal(s, id, dest);
			s = settleOffers(s);
			if (s.phase === 'encounter') {
				if (id === 'battle-reward') s = run(s, 'Blue', { type: 'initiatePvp' });
				else s = run(s, 'Blue', { type: 'passEncounter' });
				s = settleOffers(s);
			}
			if (dest === 'Arcane Abyss' && !s.players.Red!.pendingReward)
				s = run(s, 'Red', { type: 'startCombat' });
			s = settleOffers(s);
			if (s.players.Red!.pendingReward)
				s = run(s, 'Red', { type: 'resolveMonsterReward', picks: [0, 1, 2] });
			for (const seat of s.activeSeats)
				if (s.players[seat]!.unplacedAugments?.length)
					s = run(s, seat, { type: 'discardUnplacedAugments' });
			s = closeRound(s);
			for (let round = 0; round < 3 && s.status === 'active'; round++) {
				s = run(s, 'Red', { type: 'lockNavigation', destination: 'Arcane Abyss' });
				s = run(s, 'Blue', { type: 'lockNavigation', destination: 'Mountain Region' });
				s = run(s, 'Red', { type: 'forceAdvancePhase' });
				s = run(s, 'Red', { type: 'startCombat' });
				s = run(s, 'Red', { type: 'resolveMonsterReward', picks: [0, 1, 2] });
				s = closeRound(s);
			}
			expect(s.status).toBe('finished');
			expect(s.winnerSeat).toBe('Red');
			expect(s.players.Red!.victoryPoints).toBeGreaterThanOrEqual(30);
		}
	);
});

describe('power deadlines and bounded resolution', () => {
	it('deadline declines unclaimed healing and the next round discards the consumed card', () => {
		let s = reveal(start(), 'ember-charge');
		const barrier = s.players.Red!.barrier;
		s = run(s, 'Red', { type: 'forceAdvancePhase' });
		expect(s.players.Red!.barrier).toBe(barrier);
		expect(s.players.Red!.navigationPowerOffers).toEqual([]);
		for (let i = 0; i < 8 && s.round === 1; i++) s = run(s, 'Red', { type: 'forceAdvancePhase' });
		expect(s.round).toBe(2);
		expect(s.players.Red!.navigationPower).toBeNull();
	});
	it('deadline settles a compulsory rune-owner choice without accepting optional powers', () => {
		let s = start();
		giveRune(s, 'Blue');
		s = reveal(s, 'stone-shelter');
		s = choose(s, 'Red');
		expect(s.players.Blue!.navigationPowerOffers?.[0]?.mandatory).toBe(true);
		s = run(s, 'Red', { type: 'forceAdvancePhase' });
		expect(s.players.Blue!.navigationPowerOffers).toEqual([]);
		expect(s.players.Red!.mats.filter((m) => m.hasRune)).toHaveLength(1);
	});
	it('ordinary combat cannot skip an unresolved power, even from another seat', () => {
		const s = reveal(start(), 'battle-fury', 'Arcane Abyss');
		const result = applyGameCommand(s, actor('Blue'), { type: 'startCombat' }, CATALOG);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('power_pending');
	});
});

describe('Navigation Power race regressions', () => {
	it('does not accept a new trade with the old proposal ID', () => {
		let s = start();
		giveRune(s, 'Red');
		giveRune(s, 'Blue', 1);
		s = reveal(s, 'shared-current');
		s = choose(s, 'Red');
		const proposal = { type: 'tradeNavigationPower', targetSeat: 'Blue', giveRuneSlots: [1] };
		s = run(s, 'Red', proposal);
		const oldId = s.players.Blue!.pendingNavigationTrade!.id;
		s = run(s, 'Blue', { type: 'respondNavigationPowerTrade', tradeId: oldId, accept: false });
		s = run(s, 'Red', proposal);
		const result = applyGameCommand(
			s,
			actor('Blue'),
			{ type: 'respondNavigationPowerTrade', tradeId: oldId, accept: true },
			CATALOG
		);
		expect(result.ok).toBe(false);
		expect(s.players.Red!.mats[0].hasRune).toBe(true);
	});
	it('cannot evade a mandatory Rune transfer by spending the Rune', () => {
		let s = start();
		giveRune(s, 'Blue');
		s = reveal(s, 'stone-shelter');
		s = choose(s, 'Red');
		const result = applyGameCommand(
			s,
			actor('Blue'),
			{ type: 'acquireNavigationPower', runeSlot: 1 },
			CATALOG
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('power_pending');
		s = choose(s, 'Blue');
		expect(s.players.Red!.mats.some((m) => m.hasRune)).toBe(true);
	});
	it('preserves a stolen augment class when its old snapshot has no cached name', () => {
		let s = start();
		s.players.Blue!.spirits = [spirit(1)];
		s.players.Blue!.spiritAugmentAttachments = [
			{ runeId: 'legacy-fighter', classId: 'class-0', spiritId: 'owned-1', spiritSlotIndex: 1 }
		];
		s = reveal(s, 'augment-relay');
		s = choose(s, 'Red');
		expect(s.players.Red!.unplacedAugments![0].classId).toBe('class-0');
	});
});

it('accepts an unchanged trade after JSONB reorders persisted object keys', () => {
	let s = start();
	giveRune(s, 'Red');
	giveRune(s, 'Blue', 1);
	s = reveal(s, 'shared-current');
	s = choose(s, 'Red');
	s = run(s, 'Red', {
		type: 'tradeNavigationPower',
		targetSeat: 'Blue',
		giveRuneSlots: [1],
		receiveRuneSlots: [1]
	});
	const reorder = (v: any): any =>
		Array.isArray(v)
			? v.map(reorder)
			: v && typeof v === 'object'
				? Object.fromEntries(
						Object.entries(v)
							.reverse()
							.map(([k, value]) => [k, reorder(value)])
					)
				: v;
	s = reorder(JSON.parse(JSON.stringify(s)));
	const tradeId = s.players.Blue!.pendingNavigationTrade!.id;
	s = run(s, 'Blue', { type: 'respondNavigationPowerTrade', tradeId, accept: true });
	expect(s.players.Red!.mats.find((m) => m.hasRune)?.id).toBe(RUNES[1].runeId);
	expect(s.players.Blue!.mats.find((m) => m.hasRune)?.id).toBe(RUNES[0].runeId);
});

it('lets an older untyped Origin Rune pay for a power but never wildcard assets', () => {
	let s = start();
	s = reveal(s, 'ember-charge', 'Forest Region');
	s = choose(s, 'Red');
	giveRune(s, 'Red');
	delete s.players.Red!.mats[0].type;
	s = run(s, 'Red', { type: 'acquireNavigationPower', runeSlot: 1 });
	expect(s.players.Red!.pendingPowerDrafts).toEqual([]);
	expect(s.players.Red!.powerInventory).toHaveLength(1);
	for (const id of [
		'19d72567-4ac8-4214-a21f-596bc88de8f7',
		'7ca279f0-1ca8-484a-a86e-0a87aaa7b312'
	]) {
		let other = start();
		other = reveal(other, 'ember-charge', 'Forest Region');
		other = choose(other, 'Red');
		other.players.Red!.mats = [
			{ slotIndex: 1, id, hasRune: true, type: 'rune', originId: 'wildcard-origin' }
		];
		expect(
			applyGameCommand(
				other,
				actor('Red'),
				{ type: 'acquireNavigationPower', runeSlot: 1 },
				CATALOG
			).ok
		).toBe(false);
	}
});

it('resolves entry powers before anyone can spend their target Runes on location actions', () => {
	let s = start();
	giveRune(s, 'Blue');
	s = reveal(s, 'stone-shelter');
	const spend = applyGameCommand(
		s,
		actor('Blue'),
		{ type: 'acquireNavigationPower', runeSlot: 1 },
		CATALOG
	);
	expect(spend.ok).toBe(false);
	if (!spend.ok) expect(spend.error.code).toBe('power_pending');
	s = choose(s, 'Red');
	s = choose(s, 'Blue');
	expect(s.players.Red!.mats.filter((m) => m.hasRune)).toHaveLength(1);
});

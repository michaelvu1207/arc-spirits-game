import { describe, expect, test } from 'vitest';
import { applyGameCommand, createLobbyState, refreshActiveChoiceDeadline } from './runtime';
import { planBotPhaseActions, type BotRandom } from './server/botPolicy';
import { buildMonsterRewards, monsterGainFor, rewardClaimCount } from './monsterRewards';
import type {
	AttackDie,
	GameActor,
	GameCommand,
	NavigationDestination,
	PlayCatalog,
	PublicGameState
} from './types';
import { DEADLINE_MAX_EXTENSIONS, phaseDurationMs } from './types';
import { drawMonsterViaCommands } from './testing/monsterCards';

// Live monster-reward icon ids. The app loads monsters from the `monsters_v2`
// table (supabase.ts MONSTERS = 'monsters_v2'); its full reward vocabulary is the
// 7 icons in MONSTERS_V2_REWARD_ICONS below. VP_RAW + the named runes appear in
// the legacy `monsters` table and remain mapped for forward-compat / locations.
const VP_RAW = '24278b1c-c935-4d4e-aed5-408ce9c9a043'; // +1 VP (legacy table)
const VICTORY_POINT = '70792514-aa43-4526-a7a4-0f1e4ca55d71'; // +1 VP
const VP2 = '22e7f408-fa65-417e-a555-56ad87ecb428'; // +2 VP
const VP3 = '54a61c34-6e05-44df-a4d1-115e004af31e'; // +3 VP
const VP5 = '9cf8e1dd-55e0-4926-8dc8-2fb5b7b96bd4'; // +5 VP
const ABYSS_SUMMON = '12ff8ffe-20cb-4a86-a493-5e4ff8b9dc3e';
const AVATAR_BARRIER = '16daf8be-6ae0-4ace-b70c-cbb30e357664';
const ANY_RELIC = '6a85e06a-52cc-483c-aa59-38395a377307';
const ANY_RUNE = '36aab6c9-b98c-4e84-b097-e743f45dde82';
const TEAPOT = 'c8ef5d48-2289-4fee-a34d-b041d3e8bea6';
const FIRECRACKER = '895144a1-e0f6-4bdc-a4db-322423f1b922';
const FLOWER = '75134075-3347-49de-a740-eb99d20b1f1a';
const MAGNET = 'ca4df196-67fb-4507-973d-1dfac277953d';

// EXACTLY the distinct reward icons used by the live `monsters_v2` table — every
// one MUST resolve, or some monster's reward would be silently dropped on kill.
const MONSTERS_V2_REWARD_ICONS = [
	ABYSS_SUMMON,
	VICTORY_POINT,
	VP2,
	VP3,
	VP5,
	ANY_RELIC,
	ANY_RUNE
];

// The broader reward vocabulary (monsters_v2 + legacy monsters), all must resolve.
const ALL_LIVE_REWARD_ICONS = [
	...MONSTERS_V2_REWARD_ICONS,
	VP_RAW,
	TEAPOT,
	FIRECRACKER,
	FLOWER,
	MAGNET
];

// A monster whose reward track exercises VP, summon, a fixed rune and a choice.
const REWARD_TRACK = [VP_RAW, VP3, ABYSS_SUMMON, TEAPOT];

const CATALOG: PlayCatalog = {
	guardians: [
		{ id: 'g-a', name: 'Red Guard', originId: 'o1' },
		{ id: 'g-b', name: 'Blue Guard', originId: 'o2' }
	],
	mats: [],
	classes: [],
	dice: [{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack', sides: [1, 1, 2, 2, 3, 3] }],
	// 30 Spirit World (cost 1-5) + 10 Arcane Abyss (cost 8) spirits.
	spirits: Array.from({ length: 40 }, (_, i) => ({
		id: `s-${i}`,
		name: `Spirit ${i}`,
		cost: i < 30 ? (i % 5) + 1 : 8,
		classes: { Fighter: 1 },
		origins: { Forest: 1 }
	})),
	// barrier 1 + damage 1 ⇒ a player with arcane dice one-shots it without corrupting.
	// m-1 is the only Difficulty 1 card. The unkillable Difficulty 3 apex card stays in the
	// deck, so killing m-1 is never the LAST card (that would save the spirit world and end
	// the game, which these reward-flow tests don't want).
	monsters: [
		{ id: 'm-1', name: 'Abyss Maw', damage: 1, barrier: 1, rewardTrack: REWARD_TRACK, dicePool: [], chooseAmount: 2, stage: 1, order: 0 },
		{ id: 'm-apex', name: 'Abyss Apex', damage: 9, barrier: 99, rewardTrack: REWARD_TRACK, dicePool: [], chooseAmount: 2, stage: 1, order: 1 }
	],
	locations: []
};

const RED: GameActor = { memberId: 'm-red', displayName: 'Red', role: 'host', seatColor: 'Red' };
const BLUE: GameActor = { memberId: 'm-blue', displayName: 'Blue', role: 'player', seatColor: 'Blue' };

function apply(
	state: PublicGameState,
	actor: GameActor,
	command: GameCommand,
	catalog: PlayCatalog = CATALOG
): PublicGameState {
	const result = applyGameCommand(state, actor, command, catalog);
	if (!result.ok) throw new Error(`${command.type} failed: ${result.error.message}`);
	return result.state;
}

function tryApply(state: PublicGameState, actor: GameActor, command: GameCommand) {
	return applyGameCommand(state, actor, command, CATALOG);
}

const arcaneDice = (n: number): AttackDie[] =>
	Array.from({ length: n }, (_, i) => ({ instanceId: `d-${i}`, tier: 'arcane' as const }));

/** Drive a 2-player game to the Location phase, both at the Arcane Abyss, with Red
 *  holding enough arcane dice to one-shot the monster. Red draws and keeps the m-1 monster
 *  card through the real commands, so it is the only card in Red's hand (hand index 0). */
function atAbyss(catalog: PlayCatalog = CATALOG): PublicGameState {
	let s = createLobbyState({ roomCode: 'MONREW', guardianNames: ['Red Guard', 'Blue Guard'] });
	s = apply(s, RED, { type: 'claimSeat', seatColor: 'Red' }, catalog);
	s = apply(s, BLUE, { type: 'claimSeat', seatColor: 'Blue' }, catalog);
	s = apply(s, RED, { type: 'selectGuardian', guardianName: 'Red Guard' }, catalog);
	s = apply(s, BLUE, { type: 'selectGuardian', guardianName: 'Blue Guard' }, catalog);
	s = apply(s, RED, { type: 'startGame', seed: 7 }, catalog);
	s = apply(s, RED, { type: 'lockNavigation', destination: 'Arcane Abyss' }, catalog);
	s = apply(s, BLUE, { type: 'lockNavigation', destination: 'Arcane Abyss' }, catalog);
	// Locking no longer reveals instantly (a back-out grace was added); force-advance
	// past it to reach the Location phase. Both seats are already locked, so this just
	// reveals their chosen destinations.
	s = apply(s, RED, { type: 'forceAdvancePhase' }, catalog);
	if (s.phase !== 'location') throw new Error(`expected location phase, got ${s.phase}`);
	s = drawMonsterViaCommands(s, RED, catalog, { catalogId: 'm-1' });
	// Give Red a strong dice pool so the next fight is a guaranteed kill.
	s.players.Red!.attackDice = arcaneDice(6);
	return s;
}

/** Red fights and kills the card in their hand, returning the post-kill state (pendingReward set). */
function killMonster(catalog: PlayCatalog = CATALOG): PublicGameState {
	const s = apply(atAbyss(catalog), RED, { type: 'startCombat', handIndex: 0 }, catalog);
	if (!s.players.Red?.pendingReward) throw new Error('expected a pending reward after the kill');
	return s;
}

describe('buildMonsterRewards / monsterGainFor (reward semantics)', () => {
	test('every reward icon used by the live monsters_v2 table resolves', () => {
		// If this fails, some real monster reward would be silently dropped on kill.
		for (const icon of MONSTERS_V2_REWARD_ICONS) {
			expect(monsterGainFor(icon), `monsters_v2 icon ${icon} must resolve`).not.toBeNull();
		}
	});

	test('every live reward icon resolves to a claimable effect', () => {
		for (const icon of ALL_LIVE_REWARD_ICONS) {
			expect(monsterGainFor(icon), `icon ${icon} should resolve`).not.toBeNull();
		}
	});

	test('VP tokens resolve to the right amounts', () => {
		expect(monsterGainFor(VP_RAW)).toEqual({ type: 'vp', amount: 1 });
		expect(monsterGainFor(VICTORY_POINT)).toEqual({ type: 'vp', amount: 1 });
		expect(monsterGainFor(VP2)).toEqual({ type: 'vp', amount: 2 });
		expect(monsterGainFor(VP3)).toEqual({ type: 'vp', amount: 3 });
		expect(monsterGainFor(VP5)).toEqual({ type: 'vp', amount: 5 });
	});

	test('the abyss-summon token resolves to an abyss summon action', () => {
		expect(monsterGainFor(ABYSS_SUMMON)).toEqual({ type: 'action', action: 'abyssSummon' });
	});

	test('the Avatar Barrier token gains maximum barrier rather than restoring it', () => {
		expect(monsterGainFor(AVATAR_BARRIER)).toEqual({ type: 'gainMaxBarrier', amount: 1 });
	});

	test('a named relic token gives that relic (owner rule, 2026-11-12)', () => {
		const gain = monsterGainFor(TEAPOT);
		expect(gain?.type).toBe('rune');
		if (gain?.type === 'rune') expect(gain.rune).toMatchObject({ name: 'Cleansing Teapot', type: 'relic' });
	});

	test('legacy relic rewards downgrade named relics while retaining Fairy Rune', () => {
		const gain = monsterGainFor(ANY_RELIC);
		expect(gain?.type).toBe('chooseRune');
		if (gain?.type === 'chooseRune') {
			expect(gain.options.length).toBeGreaterThan(1);
			expect(gain.options.filter(o => o.type === 'rune').map(o => o.name).sort()).toEqual(['Fire Rune', 'Forest Rune', 'Mountain Rune', 'Water Rune']);
			expect(gain.options.filter(o => o.type === 'relic')).toHaveLength(1);
		}
	});

	test('the "any basic rune" wildcard offers the four origin runes', () => {
		const gain = monsterGainFor(ANY_RUNE);
		expect(gain?.type).toBe('chooseRune');
		if (gain?.type === 'chooseRune') expect(gain.options).toHaveLength(4);
	});

	test('an unknown icon yields no option and is dropped from the pool', () => {
		expect(monsterGainFor('not-a-real-icon')).toBeNull();
		const opts = buildMonsterRewards([VP_RAW, 'not-a-real-icon', VP3]);
		// Indexes stay aligned to the original track (1 dropped, 0 and 2 kept).
		expect(opts.map((o) => o.index)).toEqual([0, 2]);
	});

	test('duplicate tokens are distinct, individually selectable slots', () => {
		const opts = buildMonsterRewards([VP_RAW, VP_RAW, VP_RAW]);
		expect(opts.map((o) => o.index)).toEqual([0, 1, 2]);
	});

	test('rewardClaimCount is every resolvable token (a kill grants them all)', () => {
		expect(rewardClaimCount([VP3])).toBe(1);
		expect(rewardClaimCount(REWARD_TRACK)).toBe(4);
		expect(rewardClaimCount([VP3, 'not-a-real-icon'])).toBe(1);
		expect(rewardClaimCount([])).toBe(0);
	});
});

describe('monster-kill reward flow (engine)', () => {
	test('killing the monster opens a claim of every reward on the card', () => {
		const s = killMonster();
		const pending = s.players.Red!.pendingReward!;
		expect(pending.monsterName).toBe('Abyss Maw');
		expect(pending.rewardTrack).toEqual(REWARD_TRACK);
		expect(pending.chooseAmount).toBe(4);
		// The fight itself granted no VP (it comes from the claim).
		expect(s.players.Red!.victoryPoints).toBe(0);
		// The defeated card left Red's hand at once.
		expect(s.players.Red!.monsterHand).toEqual([]);
	});

	test('claiming grants EVERY reward, whatever the picks say', () => {
		for (const picks of [[0, 1, 2, 3], [0], []]) {
			let s = killMonster();
			s = apply(s, RED, { type: 'resolveMonsterReward', picks });
			const red = s.players.Red!;
			expect(red.victoryPoints).toBe(4); // 1 VP + 3 VP
			expect(red.pendingDraw?.sourceBag).toBe('Arcane Abyss Bag'); // the Abyss Summon
			expect(red.mats.some((r) => r.name === 'Cleansing Teapot' && r.relicTool)).toBe(true); // the Teapot relic
			expect(red.pendingReward).toBeNull();
		}
	});

	test('two Abyss Summon tokens queue two draws', () => {
		const catalog: PlayCatalog = {
			...CATALOG,
			monsters: [{ ...CATALOG.monsters![0], rewardTrack: [VICTORY_POINT, ABYSS_SUMMON, ABYSS_SUMMON] }]
		};
		let s = killMonster(catalog);
		s = apply(s, RED, { type: 'resolveMonsterReward', picks: [] }, catalog);
		expect(s.players.Red!.victoryPoints).toBe(1);
		expect(s.players.Red!.pendingDraw?.sourceBag).toBe('Arcane Abyss Bag');
		expect(s.players.Red!.pendingDrawQueue.map((d) => d.sourceBag)).toEqual(['Arcane Abyss Bag']);
	});

	test('a newly opened Abyss summon gets a fresh choice window and cannot auto-pass', () => {
		let s = killMonster();
		// Reproduce a long Location turn whose shared grace was already spent fighting.
		s.phaseDeadline = 1;
		s.phaseDeadlineExtensions = DEADLINE_MAX_EXTENSIONS;
		s = apply(s, RED, { type: 'resolveMonsterReward', picks: [0, 2] });
		expect(s.players.Red!.pendingDraw?.sourceBag).toBe('Arcane Abyss Bag');

		const now = 50_000;
		expect(refreshActiveChoiceDeadline(s, 'Red', now)).toBe(true);
		expect(s.phaseDeadlineExtensions).toBe(0);
		expect(s.phaseDeadline).toBe(now + phaseDurationMs('location'));

		const pass = tryApply(s, RED, { type: 'endLocationActions' });
		expect(pass.ok).toBe(false);
		if (!pass.ok) expect(pass.error.code).toBe('draw_pending');
	});

	test('claiming a named relic puts the relic tool in a rune slot', () => {
		let s = killMonster();
		const before = s.players.Red!.mats.filter((r) => r.hasRune).length;
		s = apply(s, RED, { type: 'resolveMonsterReward', picks: [3] }); // Teapot
		const after = s.players.Red!.mats.filter((r) => r.hasRune).length;
		expect(after).toBe(before + 1);
		expect(s.players.Red!.mats.some((r) => r.name === 'Cleansing Teapot' && r.relicTool)).toBe(true);
	});

	test('a pending reward blocks ending the location phase until claimed', () => {
		// A VP-only card, so the claim opens no summon draw.
		const catalog: PlayCatalog = {
			...CATALOG,
			monsters: [{ ...CATALOG.monsters![0], rewardTrack: [VICTORY_POINT, VP3] }]
		};
		const s = killMonster(catalog);
		const blocked = applyGameCommand(s, RED, { type: 'endLocationActions' }, catalog);
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) expect(blocked.error.code).toBe('reward_pending');
		// After claiming, the seat can end its actions.
		const claimed = apply(s, RED, { type: 'resolveMonsterReward', picks: [] }, catalog);
		expect(claimed.players.Red!.victoryPoints).toBe(4);
		const ended = applyGameCommand(claimed, RED, { type: 'endLocationActions' }, catalog);
		expect(ended.ok).toBe(true);
	});

	test('claiming with no kill is rejected', () => {
		const s = atAbyss();
		const r = tryApply(s, RED, { type: 'resolveMonsterReward', picks: [0] });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe('no_reward');
	});

	test('a "choose a rune" pick grants the selected option', () => {
		// A monster whose only reward is the Any-Relic choice.
		const catalog: PlayCatalog = {
			...CATALOG,
			monsters: [{ ...CATALOG.monsters![0], rewardTrack: [ANY_RELIC], chooseAmount: 2 }]
		};
		let s = createLobbyState({ roomCode: 'MONCHO', guardianNames: ['Red Guard', 'Blue Guard'] });
		const run = (st: PublicGameState, a: GameActor, c: GameCommand) => {
			const res = applyGameCommand(st, a, c, catalog);
			if (!res.ok) throw new Error(`${c.type}: ${res.error.message}`);
			return res.state;
		};
		s = run(s, RED, { type: 'claimSeat', seatColor: 'Red' });
		s = run(s, BLUE, { type: 'claimSeat', seatColor: 'Blue' });
		s = run(s, RED, { type: 'selectGuardian', guardianName: 'Red Guard' });
		s = run(s, BLUE, { type: 'selectGuardian', guardianName: 'Blue Guard' });
		s = run(s, RED, { type: 'startGame', seed: 7 });
		s = run(s, RED, { type: 'lockNavigation', destination: 'Arcane Abyss' });
		s = run(s, BLUE, { type: 'lockNavigation', destination: 'Arcane Abyss' });
		s.players.Red!.attackDice = arcaneDice(6);
		// Locking no longer reveals instantly — force-advance to reach the Location phase.
		s = run(s, RED, { type: 'forceAdvancePhase' });
		s = drawMonsterViaCommands(s, RED, catalog);
		s = run(s, RED, { type: 'startCombat', handIndex: 0 });
		const options = buildMonsterRewards(s.players.Red!.pendingReward!.rewardTrack);
		const chooseOpt = options[0];
		expect(chooseOpt.effect.type).toBe('chooseRune');
		const second =
			chooseOpt.effect.type === 'chooseRune' ? chooseOpt.effect.options[1].name : '';
		s = run(s, RED, { type: 'resolveMonsterReward', picks: [chooseOpt.index], choices: [1] });
		// The chosen option is granted wherever it belongs: a rune slot for relics/origin
		// runes, or the augment pouch for a class rune (a spirit augment).
		const grantedSecond =
			s.players.Red!.mats.some((r) => r.name === second) ||
			(s.players.Red!.unplacedAugments ?? []).some((a) => a.name === second);
		expect(grantedSecond).toBe(true);
		expect(s.players.Red!.pendingReward).toBeNull();
	});

	test('a host force-advance auto-claims an unclaimed reward (no silent forfeit)', () => {
		const s = killMonster();
		const round = s.round;
		const advanced = apply(s, RED, { type: 'forceAdvancePhase' });
		// Auto-claim granted every reward (1 VP + 3 VP + summon + rune) before leaving the
		// phase; the summon's unresolved draw went back to its bag.
		expect(advanced.players.Red!.pendingReward).toBeNull();
		expect(advanced.players.Red!.victoryPoints).toBe(4);
		expect(advanced.players.Red!.pendingDraw).toBeNull();
		expect(advanced.players.Red!.mats.some((r) => r.name === 'Cleansing Teapot' && r.relicTool)).toBe(true);
		// The claimed Teapot is a relic tool, so its keep / 2 VP / effect card stops the chain
		// at that step; the next forced advance goes on to the next round.
		expect(advanced.phase).toBe('awakening');
		expect(advanced.players.Red!.pendingDecisions.map((d) => d.kind)).toContain('relicTool');
		const next = apply(advanced, RED, { type: 'forceAdvancePhase' });
		expect(next.phase).toBe('navigation');
		expect(next.round).toBe(round + 1);
	});

	test('the pending reward is owner-only in the spectator projection', () => {
		// Verified indirectly: a non-owner viewer never sees another seat's reward.
		// (buildSessionProjection nulls pendingReward for non-owners — see runtime.)
		const s = killMonster();
		expect(s.players.Red!.pendingReward).not.toBeNull();
		expect(s.players.Blue!.pendingReward ?? null).toBeNull();
	});
});

describe('bots claim monster rewards', () => {
	// Deterministic RNG that always fights / always takes the default option.
	const yesRng: BotRandom = { int: () => 0, chance: () => true };

	test('a bot fights, claims its reward, and ends the phase with only legal commands', () => {
		const s = atAbyss();
		// Bot plays Red's seat. Plan its full Location-phase sequence.
		const commands = planBotPhaseActions(s, 'Red', CATALOG, yesRng);
		expect(commands.some((c) => c.type === 'startCombat')).toBe(true);
		expect(commands.some((c) => c.type === 'resolveMonsterReward')).toBe(true);
		expect(commands.at(-1)?.type).toBe('endLocationActions');

		// Replaying the plan must be fully legal and leave the seat ready.
		let working = s;
		for (const c of commands) working = apply(working, RED, c);
		expect(working.players.Red!.phaseReady).toBe(true);
		expect(working.players.Red!.pendingReward).toBeNull();
	});
});

describe('rune carry limit (cleanup)', () => {
	// Overflow Red's runes BEFORE the round wraps: cleanup only stops for seats with
	// housekeeping, and a workless resolution sequence collapses to the next round.
	function atCleanup(overflow: number): PublicGameState {
		const start = atAbyss();
		start.players.Red!.mats = Array.from({ length: overflow }, (_, i) => ({
			slotIndex: i + 1,
			hasRune: true,
			name: `R${i}`,
			type: 'rune'
		}));
		let s = apply(start, RED, { type: 'endLocationActions' });
		s = apply(s, BLUE, { type: 'endLocationActions' });
		// Benefits/awakening had no work → skipped; cleanup holds on Red's overflow.
		if (s.phase !== 'cleanup') throw new Error(`expected cleanup, got ${s.phase}`);
		return s;
	}

	test('overflow blocks cleanup until runes are discarded down to the limit', () => {
		let s = atCleanup(6);

		const blocked = tryApply(s, RED, { type: 'commitCleanup' });
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) expect(blocked.error.code).toBe('runes_overflow');
		expect(s.players.Blue!.phaseReady).toBe(true); // workless seat idles ready

		// Discard down to the limit; shedding the last overflow is the seat's final
		// piece of work, so the round rolls automatically — no commit needed.
		s = apply(s, RED, { type: 'discardRune', slotIndex: 6 });
		expect(s.phase).toBe('cleanup'); // still one over the limit
		s = apply(s, RED, { type: 'discardRune', slotIndex: 5 });
		expect(s.phase).toBe('navigation');
		expect(s.players.Red!.mats.filter((r) => r.hasRune).length).toBe(4);
	});

	test('discardRune is rejected outside the cleanup phase', () => {
		const s = atAbyss(); // location phase
		const r = tryApply(s, RED, { type: 'discardRune', slotIndex: 1 });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe('wrong_phase');
	});

	test('the carry limit is enforced into the next round (compaction backstop)', () => {
		// Overflow that survives to the next round (e.g. via a host force-advance):
		let s = atCleanup(7);
		// Host force-advances cleanup (bypasses the per-seat discard gate).
		s = apply(s, RED, { type: 'forceAdvancePhase' });
		expect(s.phase).toBe('navigation');
		// beginNavigation compacted + trimmed Red's runes to the carry limit.
		expect(s.players.Red!.mats.length).toBe(4);
		expect(s.players.Red!.mats.every((r) => r.hasRune)).toBe(true);
	});
});

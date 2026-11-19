/**
 * The "Any Spirit Augment" reward token (Michael, 2026-11-19): the augment hexagon with a question
 * mark. A kill that pays it gives a Spirit Augment whose type the owner picks when placing it (the
 * engine's generic Spirit Augment), and every augment reward on the monster cards is this token.
 *
 *   npx vitest run src/lib/play/anyAugmentReward.test.ts
 */
import { describe, expect, it } from 'vitest';
import { applyGameCommand } from './runtime';
import { botActorFor } from './server/botPolicy';
import { loadFrozenCatalog, loadLocalDesignCatalog } from './agents/catalog';
import { labelFor } from './agents/labels';
import { agentLegalCommands } from './agents/actionSurface';
import { createAgentLobby, pickGuardians, seatsFor } from './agents/setup';
import { ANY_AUGMENT_ICON, ANY_AUGMENT_RUNE, meaningFor } from './locationInteractions';
import { buildMonsterRewards } from './monsterRewards';
import { GENERIC_AUGMENT_RUNE_ID } from './effects/actions';
import { SPIRIT_AUGMENT_CLASSES } from './augments';
import type { MonsterState, PlayCatalog, PublicGameState } from './types';

const frozen: PlayCatalog = loadFrozenCatalog();

/** Red at the Arcane Abyss holding a monster that one hit kills and that pays one "Any Spirit Augment". */
function abyss(): PublicGameState {
	const seats = seatsFor(2);
	const guardians = pickGuardians(frozen, 5, 2);
	const state = createAgentLobby(frozen, 5, seats.map((seat, i) => ({ seat, guardian: guardians[i] })));
	const red = state.players.Red!;
	red.navigationDestination = 'Arcane Abyss';
	red.barrier = red.maxBarrier = 6;
	red.attackDice = Array.from({ length: 6 }, (_, i) => ({ instanceId: `d${i}`, tier: 'arcane' as const }));
	red.monsterHand = [
		{ id: 'm', name: 'Test Monster', hp: 1, maxHp: 1, damage: 0, difficulty: 2, rewardTrack: [ANY_AUGMENT_ICON], chooseAmount: 0, livesRemaining: 1, livesTotal: 1, ladderIndex: 0, ladderMax: 1 } as MonsterState
	];
	state.phase = 'location';
	return state;
}
const run = (state: PublicGameState, command: Parameters<typeof applyGameCommand>[2]) => {
	const r = applyGameCommand(state, botActorFor(state, 'Red'), command, frozen);
	if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
	return r.state;
};

describe('Any Spirit Augment reward', () => {
	it('the token means a Spirit Augment of the owner\'s choice', () => {
		expect(meaningFor(ANY_AUGMENT_ICON)?.kind).toBe('anyAugment');
		expect(ANY_AUGMENT_RUNE.runeId).toBe(GENERIC_AUGMENT_RUNE_ID);
		const [reward] = buildMonsterRewards([ANY_AUGMENT_ICON]);
		expect(reward.label).toBe('Spirit Augment of your choice');
		expect(reward.effect).toEqual({ type: 'rune', rune: ANY_AUGMENT_RUNE });
	});
	it('a kill pays one augment to place; it takes no rune slot; any of the six types can be chosen', () => {
		const killed = run(abyss(), { type: 'startCombat', handIndex: 0 });
		expect(killed.players.Red!.pendingReward?.rewardTrack).toEqual([ANY_AUGMENT_ICON]);
		const mats = killed.players.Red!.mats.length;
		const claimed = run(killed, { type: 'resolveMonsterReward', picks: [], choices: [] } as never);
		const red = claimed.players.Red!;
		expect(red.unplacedAugments).toEqual([{ runeId: GENERIC_AUGMENT_RUNE_ID, name: 'Spirit Augment' }]);
		expect(red.mats.length).toBe(mats);
		// The models are offered every type on every spirit that can take one.
		const places = agentLegalCommands(claimed, 'Red', frozen).commands.filter((c) => c.type === 'placeAugmentOnSpirit');
		const offered = new Set(places.map((c) => (c as { className?: string }).className));
		for (const cls of SPIRIT_AUGMENT_CLASSES) expect(offered.has(cls)).toBe(true);
		const pick = places.find((c) => (c as { className?: string }).className === 'Beast')!;
		expect(labelFor(pick, claimed, 'Red', frozen)).toContain('Beast');
		const placed = run(claimed, pick);
		expect(placed.players.Red!.spiritAugmentAttachments.at(-1)?.className).toBe('Beast');
		expect(placed.players.Red!.unplacedAugments ?? []).toHaveLength(0);
	});
	it('data: every augment reward on a monster card is the Any Spirit Augment token', () => {
		const live = loadLocalDesignCatalog('data');
		const tokens = live.monsters.flatMap((m) => m.rewardTrack ?? []);
		expect(tokens.filter((t) => t === ANY_AUGMENT_ICON).length).toBe(32);
		const specific = tokens.filter((t) => { const m = meaningFor(t); return m?.kind === 'specialRune' && m.classId; });
		expect(specific).toEqual([]);
	});
});

/**
 * Rule `goodKillBonus`: a Good-aligned player (not Fallen) gets 1 VP for every monster kill, on top of
 * the card's rewards; the models are told so in the rules brief, their status line and the fight label.
 *
 *   npx vitest run src/lib/play/goodKillBonus.test.ts
 */
import { describe, expect, it } from 'vitest';
import { applyGameCommand, GOOD_KILL_BONUS_VP } from './runtime';
import { botActorFor } from './server/botPolicy';
import { loadFrozenCatalog } from './agents/catalog';
import { buildRulesBrief } from './agents/rulesBrief';
import { labelFor } from './agents/labels';
import { createAgentLobby, pickGuardians, seatsFor } from './agents/setup';
import { renderSeatView, seatProjection } from './agents/view';
import type { MonsterState, PlayCatalog, PlayRules, PublicGameState } from './types';

const frozen: PlayCatalog = loadFrozenCatalog();
const buildSeatView = (state: PublicGameState, seat: 'Red', catalog: PlayCatalog) => renderSeatView(seatProjection(state, seat), seat, catalog);
const withRules = (rules?: PlayRules): PlayCatalog => ({ ...frozen, rules });
const ON = withRules({ goodKillBonus: true });
const fightLabel = (state: PublicGameState) => labelFor({ type: 'startCombat', handIndex: 0 }, state, 'Red', ON);

/** Red at the Arcane Abyss in the Location phase, holding a monster that one hit kills and that cannot hurt. */
function abyss(catalog: PlayCatalog, statusLevel: number, rewardTrack: string[] = []): PublicGameState {
	const seats = seatsFor(2);
	const guardians = pickGuardians(catalog, 5, 2);
	const state = createAgentLobby(catalog, 5, seats.map((seat, i) => ({ seat, guardian: guardians[i] })));
	const red = state.players.Red!;
	red.statusLevel = statusLevel;
	red.navigationDestination = 'Arcane Abyss';
	red.barrier = red.maxBarrier = 6;
	red.attackDice = Array.from({ length: 6 }, (_, i) => ({ instanceId: `d${i}`, tier: 'arcane' as const }));
	red.monsterHand = [
		{ id: 'm', name: 'Test Monster', hp: 1, maxHp: 1, damage: 0, rewardTrack, chooseAmount: 0, livesRemaining: 1, livesTotal: 1, ladderIndex: 0, ladderMax: 1 } as MonsterState
	];
	state.phase = 'location';
	return state;
}

function kill(catalog: PlayCatalog, statusLevel: number) {
	const state = abyss(catalog, statusLevel);
	const before = state.players.Red!.victoryPoints;
	const result = applyGameCommand(state, botActorFor(state, 'Red'), { type: 'startCombat', handIndex: 0 }, catalog);
	if (!result.ok) throw new Error(result.error.message);
	const combat = result.state.combats.at(-1)!;
	expect(combat.killed).toBe(true);
	return { gained: result.state.players.Red!.victoryPoints - before, log: combat.log };
}

describe('goodKillBonus', () => {
	it('off (default): a kill of a card without rewards pays nothing', () => {
		expect(kill(frozen, 0).gained).toBe(0);
		expect(kill(withRules({}), 2).gained).toBe(0);
	});
	it('on: Pure, Tainted and Corrupt get the bonus, Fallen does not', () => {
		for (const level of [0, 1, 2]) {
			const r = kill(ON, level);
			expect(r.gained).toBe(GOOD_KILL_BONUS_VP);
			expect(r.log.join(' ')).toContain('Good alignment: +1 VP');
		}
		const fallen = kill(ON, 3);
		expect(fallen.gained).toBe(0);
		expect(fallen.log.join(' ')).not.toContain('Good alignment');
	});
	it('the models are told: rules brief, status line and fight label; nothing changes when off', () => {
		expect(buildRulesBrief(ON)).toContain('ALIGNMENT BONUS: while you are Good-aligned (Pure, Tainted or Corrupt; not Fallen) every monster you defeat gives you 1 VP');
		expect(buildRulesBrief(ON)).toContain('(+1 while you are Good)');
		expect(buildRulesBrief(withRules({ goodKillBonus: false }))).toBe(buildRulesBrief(frozen));
		const good = abyss(ON, 0);
		expect(buildSeatView(good, 'Red', ON)).toContain('Good: +1 VP for every monster kill');
		expect(fightLabel(good)).toContain('a kill also gives you +1 VP for being Good');
		const fallen = abyss(ON, 3);
		expect(buildSeatView(fallen, 'Red', ON)).toContain('EVIL: no alignment bonus');
		expect(fightLabel(fallen)).toContain('you are Fallen, so no alignment bonus');
		expect(buildSeatView(abyss(frozen, 0), 'Red', frozen)).not.toContain('monster kill');
	});
});

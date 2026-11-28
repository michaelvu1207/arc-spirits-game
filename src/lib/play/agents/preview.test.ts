/**
 * Engine facts in prompts (destination preview, monster facts, pace), the private plan note,
 * and the rules-brief statements they rely on. Offline (frozen catalog, mock provider).
 *
 *   npx vitest run src/lib/play/agents/preview.test.ts
 */

import { describe, expect, it } from 'vitest';
import { applyDeadlineAdvance, applyGameCommand } from '../runtime';
import { botActorFor } from '../server/botPolicy';
import { slotSatisfies } from '../locationInteractions';
import type { GameCommand, PlayCatalog, PublicGameState, SeatColor } from '../types';
import { BudgetGuard } from './budget';
import { loadFrozenCatalog } from './catalog';
import { buildDecision } from './decision';
import { interactionSummary, interactionsAt } from './labels';
import { LlmSeatController } from './llmSeat';
import { monsterFactLines, paceLine } from './preview';
import { parseAnswer, renderDecisionMessage } from './prompt';
import { MockProvider } from './providers/mock';
import { buildRulesBrief, restClasses } from './rulesBrief';
import { runAgentGame } from './runner';
import { createAgentLobby, pickGuardians, seatsFor } from './setup';
import { MemorySink, replayTranscript, type DecisionRecord } from './transcript';

const catalog: PlayCatalog = loadFrozenCatalog();
const catalogInfo = { source: 'frozen', path: 'ml/catalog.json', hash: 'test' };

function newGame(seed = 5): PublicGameState {
	const colors = seatsFor(2);
	const guardians = pickGuardians(catalog, seed, 2);
	let state = createAgentLobby(
		catalog,
		seed,
		colors.map((seat, i) => ({ seat, guardian: guardians[i] }))
	);
	for (const seat of state.activeSeats) {
		const draft = state.players[seat]?.pendingPowerDrafts?.[0];
		if (draft?.length)
			state = apply(state, seat, { type: 'chooseNavigationPower', powerId: draft[0] });
	}
	return state;
}

function apply(state: PublicGameState, seat: SeatColor, cmd: GameCommand): PublicGameState {
	const result = applyGameCommand(state, botActorFor(state, seat), cmd, catalog);
	if (!result.ok) throw new Error(`${cmd.type}: ${result.error.code} ${result.error.message}`);
	return result.state;
}

const facts = (state: PublicGameState, seat: SeatColor = 'Red') =>
	buildDecision({
		state,
		seat,
		catalog,
		gameId: 'g',
		requestId: 'r',
		events: [],
		phaseDecisionIndex: 0
	}).request;

/** The preview line of action `n` at `destination`. */
function rowAt(lines: string[], destination: string, n: number): string {
	const start = lines.findIndex((l) => l.trim() === `${destination}:`);
	expect(start).toBeGreaterThanOrEqual(0);
	const line = lines.slice(start + 1).find((l) => l.trim().startsWith(`(${n})`));
	expect(line).toBeTruthy();
	return line!;
}

/** Red at the Abyss in the Location phase with one monster card (damage set by the test). */
function redWithMonster(damage: number): PublicGameState {
	let state = newGame(7);
	for (const seat of state.activeSeats)
		state = apply(state, seat, {
			type: 'lockNavigation',
			destination: (seat === 'Red' ? 'Arcane Abyss' : 'Fire Region') as never
		});
	applyDeadlineAdvance(state, catalog);
	expect(state.phase).toBe('location');
	state = apply(state, 'Red', { type: 'drawMonsterCards', difficulty: 1 });
	state = apply(state, 'Red', { type: 'keepMonsterCard', index: 0 });
	const red = state.players.Red!;
	red.monsterHand![0].damage = damage;
	red.monsterHand![0].hp = 50;
	red.monsterHand![0].maxHp = 50;
	return state;
}

describe('destination preview (navigation)', () => {
	it('Rest shows its real effect: +Barrier when damaged, no Barrier change when full', () => {
		const state = newGame();
		const red = state.players.Red!;
		red.maxBarrier = 6;
		red.barrier = 4;
		const damaged = rowAt(facts(state).facts!, 'Forest Region', 1);
		expect(damaged).toMatch(/Rest: possible; effect now: .*Barrier 4→6/);
		red.barrier = 6;
		const full = rowAt(facts(state).facts!, 'Forest Region', 1);
		expect(full).toMatch(/Rest: possible/);
		expect(full).not.toMatch(/Barrier \d+→/);
	});

	it('the Mountain Power swap needs a held Power (the reducer reason is shown)', () => {
		const state = newGame();
		state.players.Red!.powerInventory = [];
		expect(rowAt(facts(state).facts!, 'Mountain Region', 1)).toMatch(
			/NOT POSSIBLE now — You need a held Power to replace/
		);
		// Only a payment failure lists what pays the cost.
		expect(rowAt(facts(state).facts!, 'Mountain Region', 1)).not.toMatch(/that pays it/);
		state.players.Red!.powerInventory = ['battle-guard'];
		expect(rowAt(facts(state).facts!, 'Mountain Region', 1)).toMatch(
			/possible; effect now: pay Any Rune/
		);
	});

	it('the starting Any Rune pays "Any basic rune"; without a rune the reason and holdings show', () => {
		const state = newGame();
		expect(rowAt(facts(state).facts!, 'Forest Region', 2)).toMatch(
			/possible; effect now: pay Any Rune/
		);
		for (const m of state.players.Red!.mats) m.hasRune = false;
		expect(rowAt(facts(state).facts!, 'Forest Region', 2)).toMatch(
			/NOT POSSIBLE now — You cannot pay the cost for that interaction; you hold nothing that pays it/
		);
	});

	it("is the same whatever the hidden state is (other seat's secrets, bag order, real RNG)", () => {
		const base = newGame(9);
		const red = (s: PublicGameState) => JSON.stringify(facts(s).facts);
		const other = structuredClone(base);
		other.rng = { seed: (base.rng.seed ^ 0x5bd1e995) >>> 0, cursor: base.rng.cursor + 17 };
		const reverseArrays = (node: unknown): void => {
			if (Array.isArray(node)) {
				node.reverse();
				node.forEach(reverseArrays);
			} else if (node && typeof node === 'object') Object.values(node).forEach(reverseArrays);
		};
		reverseArrays(other.bags);
		const blue = other.players.Blue!;
		blue.powerInventory = ['thorn-ward', 'battle-fury'];
		blue.pendingDestination = 'Forest Region' as never;
		expect(red(other)).toBe(red(base));
	});
});

describe('monster facts', () => {
	it('a hit at least as large as your Barrier corrupts you (you strike back only with the initiative); a guard Power changes it', () => {
		const state = redWithMonster(4);
		const red = state.players.Red!;
		red.barrier = 4;
		red.maxBarrier = 4;
		red.powerInventory = ['battle-guard'];
		const lines = monsterFactLines(state, 'Red', catalog);
		// The monster always has the initiative; a player whose initiative die hits attacks at the same time.
		expect(lines[0]).toMatch(
			/hit 4\): its hit vs your Barrier 4: you are corrupted in 12\/12 trials \(striking back in \d+ of them\)/
		);
		// In navigation (before the reveal) the held Power is tried as committed.
		const nav = structuredClone(state);
		nav.phase = 'navigation';
		nav.revealedDestinations = false;
		nav.players.Red!.navigationDestination = null;
		const withPower = monsterFactLines(nav, 'Red', catalog, { heldPowers: true });
		expect(withPower.join('\n')).toMatch(
			/with your Power "Battle Guard" committed: its hit vs your Barrier 4: you survive/
		);
	});

	it("a Power that needs company (Guardian's Accord) adds nothing when the seat is alone", () => {
		const state = redWithMonster(4);
		const nav = structuredClone(state);
		nav.phase = 'navigation';
		nav.revealedDestinations = false;
		nav.players.Red!.navigationDestination = null;
		nav.players.Red!.barrier = 9;
		nav.players.Red!.maxBarrier = 9;
		nav.players.Red!.powerInventory = ['guardians-accord', 'battle-fury'];
		const text = monsterFactLines(nav, 'Red', catalog, { heldPowers: true }).join('\n');
		expect(text).not.toContain("Guardian's Accord");
		expect(text).toContain('Battle Fury');
	});

	it('the Abyss preview lists every monster deck a draw is possible from', () => {
		const state = newGame();
		// A card's deck is its stage; every card of the frozen catalog is stage 1.
		const open = ([1, 2, 3] as const).filter((d) =>
			state.bags.monsters.contents.some((entry) => entry.difficulty === d)
		);
		expect(open).toEqual([1]);
		const lines = facts(state).facts!;
		expect(lines.join('\n')).toContain('monster draw: possible from Difficulty 1 (your hand 0/3)');
	});

	it('a small hit is survived and the seat strikes back', () => {
		const state = redWithMonster(1);
		state.players.Red!.barrier = 4;
		expect(monsterFactLines(state, 'Red', catalog)[0]).toMatch(/you survive .* and strike back/);
	});

	it('location prompts at the Abyss carry the monster hand facts', () => {
		const state = redWithMonster(9);
		const req = facts(state);
		expect(req.facts?.join('\n')).toMatch(/MONSTER HAND .*\n.*you are corrupted in 12\/12 trials/);
	});
});

describe('pace and plan note', () => {
	it('pace is round, VP and VP per round still needed', () => {
		const state = newGame();
		state.round = 11;
		state.players.Red!.victoryPoints = 6;
		expect(paceLine(state, 'Red')).toMatch(
			/round 11 of \d+; you have 6 VP; 30 VP wins; 24 VP to go in \d+ rounds/
		);
	});

	it('every agent prompt carries the pace line and no plan note; replay still matches', async () => {
		const budget = new BudgetGuard({ maxTokens: Infinity, maxCalls: Infinity });
		const seat = () =>
			new LlmSeatController({
				provider: new MockProvider({ policy: 'random', seed: 1 }),
				model: 'random',
				budget
			});
		const sink = new MemorySink();
		await runAgentGame({
			catalog,
			catalogInfo,
			seed: 4,
			controllers: [seat(), seat()],
			rulesBrief: buildRulesBrief(catalog),
			budget,
			runId: 'pace',
			sink,
			maxDecisions: 30
		});
		const decisions = sink.records.filter(
			(r): r is DecisionRecord => r.type === 'decision' && !!r.prompt
		);
		expect(decisions.length).toBeGreaterThan(5);
		for (const d of decisions) {
			expect(d.prompt).toMatch(/^PACE: round \d+ of \d+/m);
			expect(d.prompt).not.toMatch(/PLAN NOTE|"plan"/);
		}
		expect(replayTranscript(sink.records, catalog).matches).toBe(true);
	});
});

describe('rules brief statements checked against the engine', () => {
	it('"Any basic rune" is paid by origin runes and the wild Any Rune, never by relics or augments', () => {
		const brief = buildRulesBrief(catalog);
		expect(brief).toContain('"Any basic rune" costs are paid with one basic rune');
		const req = { match: 'anyBasic' } as never;
		const anyRune = newGame().players.Red!.mats.find(
			(m) => m.hasRune && /any rune/i.test(m.name ?? '')
		);
		expect(anyRune).toBeTruthy();
		expect(slotSatisfies(anyRune!, req)).toBe(true);
		expect(
			slotSatisfies(
				{ hasRune: true, type: 'rune', originId: 'o', name: 'Mountain Rune' } as never,
				req
			)
		).toBe(true);
		expect(slotSatisfies({ hasRune: true, type: 'relic', name: 'X relic' } as never, req)).toBe(
			false
		);
		expect(slotSatisfies({ hasRune: true, type: 'augment', name: 'X' } as never, req)).toBe(false);
	});

	it('Rest: Barrier by status (Pure 4) capped at Max Barrier; the On Rest classes are listed from the catalog', () => {
		const brief = buildRulesBrief(catalog);
		expect(brief).toContain(
			'Rest restores Barrier by your status (Pure 4, Tainted 4, Corrupt 3, Fallen 2; never above your Max Barrier)'
		);
		for (const name of restClasses(catalog)) expect(brief).toContain(name);
		let state = newGame();
		for (const seat of state.activeSeats)
			state = apply(state, seat, { type: 'lockNavigation', destination: 'Forest Region' as never });
		applyDeadlineAdvance(state, catalog);
		const red = state.players.Red!;
		expect(red.statusLevel ?? 0).toBe(0);
		red.maxBarrier = 7;
		const rest = interactionsAt(catalog, 'Forest Region').find(
			(i) => interactionSummary(i) === 'Rest'
		);
		expect(rest).toBeTruthy();
		const restAt = (barrier: number) => {
			const copy = structuredClone(state);
			copy.players.Red!.barrier = barrier;
			return apply(copy, 'Red', { type: 'resolveLocationInteraction', rowIndex: rest!.rowIndex })
				.players.Red!.barrier;
		};
		expect(restAt(2)).toBe(6);
		expect(restAt(6)).toBe(7);
	});

	it('the brief says a hit equal to your Barrier corrupts, and the engine agrees', () => {
		expect(buildRulesBrief(catalog)).toContain(
			'When a hit (after damage reduction) is equal to or larger than your current Barrier'
		);
		const state = redWithMonster(4);
		state.players.Red!.barrier = 4;
		const after = apply(state, 'Red', { type: 'startCombat', handIndex: 0 });
		expect(after.players.Red!.statusLevel).toBe(1);
	});
});

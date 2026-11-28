/**
 * Agent harness tests — all offline (frozen ml/catalog.json + the deterministic mock provider).
 *
 *   npx vitest run src/lib/play/agents
 */

import { describe, expect, it } from 'vitest';
import { applyDeadlineAdvance, applyGameCommand } from '../runtime';
import { botActorFor } from '../server/botPolicy';
import { offerHeldRelicTools, FIRECRACKER_ID } from '../effects/relicTools';
import type { GameCommand, PlayCatalog, PublicGameState, SeatColor } from '../types';
import { agentLegalCommands, fairCut } from './actionSurface';
import { BudgetExceededError, BudgetGuard } from './budget';
import { loadFrozenCatalog } from './catalog';
import type { DecisionRequest, SeatController } from './contract';
import { buildDecision } from './decision';
import { EventLog } from './events';
import { LlmSeatController, safeFallback } from './llmSeat';
import { parseAnswer, renderDecisionMessage } from './prompt';
import { MockProvider, type MockOptions } from './providers/mock';
import { ProviderError } from './providers/types';
import { publicLabelFor } from './labels';
import { seatProjection } from './view';
import { buildRulesBrief } from './rulesBrief';
import { runAgentGame } from './runner';
import { createAgentLobby, pickGuardians, seatsFor } from './setup';
import { MemorySink, replayTranscript, type DecisionRecord } from './transcript';

const catalog: PlayCatalog = loadFrozenCatalog();
const brief = buildRulesBrief(catalog);
const catalogInfo = { source: 'frozen', path: 'ml/catalog.json', hash: 'test' };

function mockSeat(opts: MockOptions, budget: BudgetGuard): SeatController {
	return new LlmSeatController({
		provider: new MockProvider(opts),
		model: opts.policy ?? 'random',
		budget,
		label: `mock:${opts.policy ?? 'random'}`
	});
}

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

/** Answer the opening power draft for every seat (first card). */
function draftPowers(state: PublicGameState): PublicGameState {
	for (const seat of state.activeSeats) {
		const draft = state.players[seat]?.pendingPowerDrafts?.[0];
		if (draft?.length)
			state = apply(state, seat, { type: 'chooseNavigationPower', powerId: draft[0] });
	}
	return state;
}

/** Lock destinations and reveal; returns the state in the Location phase (or later). */
function goTo(state: PublicGameState, where: Partial<Record<SeatColor, string>>): PublicGameState {
	for (const seat of state.activeSeats) {
		state = apply(state, seat, {
			type: 'lockNavigation',
			destination: (where[seat] ?? 'Forest Region') as never
		});
	}
	applyDeadlineAdvance(state, catalog);
	return state;
}

function request(state: PublicGameState, seat: SeatColor, events: string[] = []): DecisionRequest {
	return buildDecision({
		state,
		seat,
		catalog,
		gameId: 'test',
		requestId: 'r',
		events,
		phaseDecisionIndex: 0
	}).request;
}

describe('full games (mock provider)', () => {
	it('a 2-seat game finishes, and the transcript replays to the same final state', async () => {
		const budget = new BudgetGuard({ maxTokens: Infinity, maxCalls: Infinity });
		const sink = new MemorySink();
		const summary = await runAgentGame({
			catalog,
			catalogInfo,
			seed: 3,
			controllers: [
				mockSeat({ policy: 'greedy', seed: 1 }, budget),
				mockSeat({ policy: 'random', seed: 2 }, budget)
			],
			rulesBrief: brief,
			budget,
			runId: 'test',
			sink
		});
		expect(summary.finished).toBe(true);
		expect(summary.stopReason).toBe('finished');
		expect(summary.winner).not.toBeNull();
		expect(summary.seats.every((s) => s.vpByRound.length > 0)).toBe(true);
		expect(sink.records[0].type).toBe('header');
		expect(sink.records.at(-1)?.type).toBe('result');
		const replay = replayTranscript(sink.records, catalog);
		expect(replay.matches).toBe(true);
		expect(replay.commands).toBe(summary.decisions);
	}, 60_000);

	it('a 4-seat game finishes; every agent prompt is the recorded user message', async () => {
		const budget = new BudgetGuard({ maxTokens: Infinity, maxCalls: Infinity });
		const sink = new MemorySink();
		const summary = await runAgentGame({
			catalog,
			catalogInfo,
			seed: 9,
			controllers: [1, 2, 3, 4].map((i) =>
				mockSeat({ policy: i % 2 ? 'greedy' : 'random', seed: i }, budget)
			),
			rulesBrief: brief,
			budget,
			runId: 'test4',
			sink
		});
		expect(summary.finished).toBe(true);
		const decisions = sink.records.filter((r): r is DecisionRecord => r.type === 'decision');
		const asked = decisions.filter((d) => !d.forced && !d.phaseCapped);
		expect(asked.length).toBeGreaterThan(50);
		for (const d of asked) {
			expect(d.prompt).toContain('LEGAL ACTIONS:');
			expect(d.actions.some((a) => a.id === d.chosen.id)).toBe(true);
			expect(d.attempts.length).toBeGreaterThan(0);
		}
		expect(new Set(decisions.map((d) => d.kind))).toContain('navigation');
	}, 120_000);
});

describe('hidden information', () => {
	it("another seat's secret destination and committed power do not change my prompt", () => {
		let base = draftPowers(newGame(2, 21));
		// Give Blue a power to commit so the power can differ too.
		base = apply(base, 'Blue', {
			type: 'debugGrant',
			grant: { kind: 'navigationPower', powerId: 'battle-fury' }
		});
		const a = apply(base, 'Blue', {
			type: 'lockNavigation',
			destination: 'Arcane Abyss',
			navigationPowerId: 'battle-fury'
		});
		const b = apply(base, 'Blue', { type: 'lockNavigation', destination: 'Fire Region' });
		const red = (s: PublicGameState) => {
			const r = request(s, 'Red');
			return renderDecisionMessage(r) + JSON.stringify(r.actions.map((x) => x.label));
		};
		expect(red(a)).toBe(red(b));
		// …while Blue's own view does show its secret choice.
		expect(request(a, 'Blue').viewText).toContain('you locked Arcane Abyss');
	});

	it("canaries in another seat's private fields never reach my prompt", () => {
		let state = draftPowers(newGame(2, 22));
		state = goTo(state, { Red: 'Arcane Abyss', Blue: 'Arcane Abyss' });
		expect(state.phase).toBe('location');
		const blue = state.players.Blue!;
		const card = {
			id: 'canary',
			name: 'CANARY_HAND',
			hp: 3,
			maxHp: 3,
			difficulty: 1 as const,
			damage: 1,
			rewardTrack: [],
			chooseAmount: 0,
			livesRemaining: 1,
			livesTotal: 1,
			ladderIndex: 0,
			ladderMax: 0
		};
		blue.monsterHand = [card];
		blue.pendingMonsterDraw = { cards: [{ ...card, name: 'CANARY_REVEAL' }], maxCards: 2 };
		blue.handDraws = [{ guid: 'g-canary', name: 'CANARY_DRAW', id: catalog.spirits[0].id }];
		blue.pendingDecisions = [
			{
				id: 'd-canary',
				source: 'class',
				kind: 'riderMountain',
				prompt: 'CANARY_DECISION',
				options: [{ id: 'restore', label: 'CANARY_OPTION' }]
			}
		];
		blue.pendingReward = {
			monsterId: 'm',
			monsterName: 'CANARY_REWARD',
			rewardTrack: [],
			chooseAmount: 0
		};
		blue.unplacedAugments = [{ runeId: 'aug', name: 'CANARY_AUGMENT' }];
		blue.powerInventory = ['thorn-ward'];
		state.players.Red!.powerInventory = [];
		blue.lastAction = { key: 'x', label: 'CANARY_LAST', log: ['CANARY_LOG'] } as never;
		const redPrompt = renderDecisionMessage(request(state, 'Red'));
		for (const canary of [
			'CANARY_HAND',
			'CANARY_REVEAL',
			'CANARY_DRAW',
			'CANARY_DECISION',
			'CANARY_OPTION',
			'CANARY_REWARD',
			'CANARY_AUGMENT',
			'CANARY_LAST',
			'CANARY_LOG',
			'Thorn Ward'
		]) {
			expect(redPrompt).not.toContain(canary);
		}
		const bluePrompt = renderDecisionMessage(request(state, 'Blue'));
		for (const canary of [
			'CANARY_HAND',
			'CANARY_REVEAL',
			'CANARY_DECISION',
			'CANARY_REWARD',
			'Thorn Ward'
		]) {
			expect(bluePrompt).toContain(canary);
		}
	});

	it('event lines reach only their audience', () => {
		const log = new EventLog();
		log.add('public line');
		log.add('only red', 'Red');
		expect(log.takeFor('Blue')).toEqual(['public line']);
		expect(log.takeFor('Red')).toEqual(['public line', 'only red']);
		expect(log.takeFor('Red')).toEqual([]);
	});

	it('a lock is reported to others without its destination; the reveal names all', async () => {
		const budget = new BudgetGuard({ maxTokens: Infinity, maxCalls: Infinity });
		const sink = new MemorySink();
		await runAgentGame({
			catalog,
			catalogInfo,
			seed: 4,
			controllers: [
				mockSeat({ policy: 'greedy', seed: 3 }, budget),
				mockSeat({ policy: 'greedy', seed: 4 }, budget)
			],
			rulesBrief: brief,
			budget,
			runId: 'hid',
			sink,
			maxDecisions: 40,
			// Sequential: with parallel navigation both seats choose before either lock exists.
			parallel: false
		});
		const decisions = sink.records.filter((r): r is DecisionRecord => r.type === 'decision');
		// The second navigation decision of round 1 is taken after the other seat locked.
		const second = decisions.filter((d) => d.round === 1 && d.kind === 'navigation')[1];
		const other = second.seat === 'Red' ? 'Blue' : 'Red';
		const otherChoice = decisions.find(
			(d) => d.round === 1 && d.kind === 'navigation' && d.seat === other
		)!;
		expect(second.prompt).toContain(`${other} locked a destination.`);
		const where = /Go to ([A-Za-z ]+?)( \(|$| and)/.exec(otherChoice.chosen.label)?.[1];
		expect(where).toBeTruthy();
		expect(second.prompt).not.toContain(`${other} → ${where}`);
	}, 60_000);
});

describe('answers: repair and fallback', () => {
	function scripted(script: string[]): { controller: LlmSeatController; provider: MockProvider } {
		const provider = new MockProvider({ policy: 'script', script });
		const controller = new LlmSeatController({
			provider,
			model: 'script',
			budget: new BudgetGuard()
		});
		return { controller, provider };
	}
	const state = draftPowers(newGame(2, 31));
	const req = request(state, 'Red');

	it('parses ids, canonical ids, fenced JSON and bare ids', () => {
		expect(parseAnswer('{"action":"a2","reason":"x"}', req.actions).id).toBe('a2');
		expect(parseAnswer('```json\n{"action": "A3"}\n```', req.actions).id).toBe('a3');
		expect(parseAnswer(JSON.stringify({ action: req.actions[1].actionId }), req.actions).id).toBe(
			'a2'
		);
		expect(parseAnswer('a4', req.actions).id).toBe('a4');
		expect(parseAnswer('I pick a99', req.actions).id).toBeNull();
		expect(parseAnswer('{"choice": "lockNavigation"}', req.actions).error).toContain('not one of');
	});

	it('an invalid answer gets one repair turn', async () => {
		const { controller, provider } = scripted([
			'I think going to the forest is wise.',
			'{"action":"a2","reason":"repaired"}'
		]);
		const answer = await controller.decide(req, { rulesBrief: brief });
		expect(answer.repaired).toBe(true);
		expect(answer.fallback).toBe(false);
		expect(answer.response.actionId).toBe('a2');
		expect(answer.attempts.map((a) => a.parsedId)).toEqual([null, 'a2']);
		expect(answer.attempts[0].error).toBeTruthy();
		expect(provider.calls).toBe(2);
	});

	it('two invalid answers → the safe fallback, recorded', async () => {
		const { controller } = scripted(['nope', '{"action":"a999"}']);
		const answer = await controller.decide(req, { rulesBrief: brief });
		expect(answer.fallback).toBe(true);
		expect(answer.fallbackReason).toContain('not one of');
		expect(answer.response.actionId).toBe(safeFallback(req.actions).action.id);
		expect(answer.attempts).toHaveLength(2);
	});

	it('the fallback yields when it can, else declines, else takes the first action', () => {
		const loc = goTo(draftPowers(newGame(2, 32)), { Red: 'Forest Region', Blue: 'Forest Region' });
		const locReq = request(loc, 'Red');
		expect(safeFallback(locReq.actions).action.command.type).toBe('endLocationActions');
		expect(safeFallback(req.actions).why).toBe('first-legal');
	});

	it('fallbacks appear in the game transcript and summary', async () => {
		const budget = new BudgetGuard({ maxTokens: Infinity, maxCalls: Infinity });
		const sink = new MemorySink();
		const summary = await runAgentGame({
			catalog,
			catalogInfo,
			seed: 6,
			controllers: [
				new LlmSeatController({
					provider: new MockProvider({
						policy: 'script',
						script: ['bad', 'worse', '???', '{"action":"a1"}']
					}),
					model: 'script',
					budget
				}),
				mockSeat({ policy: 'greedy', seed: 9 }, budget)
			],
			rulesBrief: brief,
			budget,
			runId: 'fb',
			sink,
			maxDecisions: 30
		});
		const red = summary.seats.find((s) => s.seat === 'Red')!;
		expect(red.fallbacks).toBeGreaterThanOrEqual(1);
		expect(red.repairs).toBeGreaterThanOrEqual(1);
		expect(red.invalidAnswers).toBeGreaterThanOrEqual(3);
		expect(summary.invalidAnswerRate).toBeGreaterThan(0);
		const fallbackRecord = sink.records.find(
			(r): r is DecisionRecord => r.type === 'decision' && r.fallback
		);
		expect(fallbackRecord?.attempts.every((a) => a.error)).toBe(true);
	}, 60_000);
});

describe('budget guards', () => {
	it('the spend cap stops the run before it is passed', async () => {
		// $100 per million prompt tokens: one ~6k-token decision ≈ $0.6.
		const budget = new BudgetGuard({ maxSpendUsd: 2, maxTokens: Infinity, maxCalls: Infinity });
		const priced = (seed: number) =>
			mockSeat({ policy: 'greedy', seed, pricePerMillionIn: 100, pricePerMillionOut: 100 }, budget);
		const summary = await runAgentGame({
			catalog,
			catalogInfo,
			seed: 7,
			controllers: [priced(1), priced(2)],
			rulesBrief: brief,
			budget,
			runId: 'b'
		});
		expect(summary.stopReason).toBe('budget');
		expect(summary.finished).toBe(false);
		expect(budget.spentUsd).toBeLessThanOrEqual(2);
		expect(budget.calls).toBeGreaterThan(0);
	}, 60_000);

	it('the token cap and the decision cap stop a game', async () => {
		const tokenBudget = new BudgetGuard({ maxTokens: 30_000, maxCalls: Infinity });
		const byTokens = await runAgentGame({
			catalog,
			catalogInfo,
			seed: 8,
			controllers: [mockSeat({ seed: 1 }, tokenBudget), mockSeat({ seed: 2 }, tokenBudget)],
			rulesBrief: brief,
			budget: tokenBudget,
			runId: 't'
		});
		expect(byTokens.stopReason).toBe('budget');
		expect(tokenBudget.tokens).toBeLessThanOrEqual(30_000);
		const free = new BudgetGuard({ maxTokens: Infinity, maxCalls: Infinity });
		const byDecisions = await runAgentGame({
			catalog,
			catalogInfo,
			seed: 8,
			controllers: [mockSeat({ seed: 1 }, free), mockSeat({ seed: 2 }, free)],
			rulesBrief: brief,
			budget: free,
			runId: 'd',
			maxDecisions: 25
		});
		expect(byDecisions.stopReason).toBe('decision-cap');
		expect(byDecisions.decisions).toBe(25);
	}, 60_000);
});

describe('decision points the bots skip reach the agent', () => {
	const kinds = (state: PublicGameState, seat: SeatColor) =>
		agentLegalCommands(state, seat, catalog).commands;

	it('the opening Navigation Power draft offers all three cards', () => {
		const state = newGame(2, 41);
		const offered = kinds(state, 'Red');
		expect(offered.filter((c) => c.type === 'chooseNavigationPower')).toHaveLength(3);
		expect(request(state, 'Red').kind).toBe('power-draft');
	});

	it('a held power can be committed with the destination', () => {
		let state = draftPowers(newGame(2, 42));
		const held = state.players.Red!.powerInventory![0];
		const offered = kinds(state, 'Red').filter((c) => c.type === 'lockNavigation');
		expect(offered.some((c) => c.type === 'lockNavigation' && c.navigationPowerId === held)).toBe(
			true
		);
		state = apply(
			state,
			'Red',
			offered.find((c) => c.type === 'lockNavigation' && c.navigationPowerId === held)!
		);
		expect(state.players.Red!.pendingNavigationPower).toBe(held);
	});

	it('Abyss monster cards: choose the deck, then keep the one revealed card or put it back', () => {
		let state = goTo(draftPowers(newGame(2, 43)), { Red: 'Arcane Abyss', Blue: 'Forest Region' });
		const draws = kinds(state, 'Red').filter((c) => c.type === 'drawMonsterCards');
		expect(draws.length).toBeGreaterThan(0);
		state = apply(state, 'Red', draws[0]);
		expect(state.players.Red!.pendingMonsterDraw!.cards).toHaveLength(1);
		// An empty hand: keep the card, or put it back on top of its deck.
		const keeps = kinds(state, 'Red').filter((c) => c.type === 'keepMonsterCard');
		expect(keeps).toEqual([
			{ type: 'keepMonsterCard', index: 0 },
			{ type: 'keepMonsterCard', index: 0, returnToDeck: true }
		]);
		expect(request(state, 'Red').kind).toBe('monster-reveal');
	});

	it('a Location-phase decision card (Rider) is answerable in the Location phase', () => {
		const state = goTo(draftPowers(newGame(2, 44)), {
			Red: 'Mountain Region',
			Blue: 'Forest Region'
		});
		state.players.Red!.pendingDecisions.push({
			id: 'dec-rider',
			source: 'class',
			kind: 'riderMountain',
			prompt: 'Rider: you navigated to the Mountain Region. Choose one.',
			options: [
				{ id: 'restore', label: 'Restore 3 Barrier' },
				{ id: 'maxBarrier', label: 'Gain 3 Max Barrier' },
				{ id: 'dice', label: 'Gain 3 Basic Attack Dice' }
			],
			expiresAt: 'benefits',
			expiryOptionId: 'auto'
		});
		const req = request(state, 'Red');
		const cards = req.actions.filter((a) => a.command.type === 'resolveDecision');
		expect(cards.map((a) => a.label)).toEqual([
			'Rider: you navigated to the Mountain Region. Choose one. → Restore 3 Barrier',
			'Rider: you navigated to the Mountain Region. Choose one. → Gain 3 Max Barrier',
			'Rider: you navigated to the Mountain Region. Choose one. → Gain 3 Basic Attack Dice'
		]);
		expect(req.kind).toBe('decision-card');
		const after = apply(state, 'Red', cards[2].command);
		expect(after.players.Red!.attackDice.length).toBe(3);
	});

	it('the Sentinel dice picker offers each distinct dice choice', () => {
		let state = draftPowers(newGame(2, 45));
		state = apply(state, 'Red', {
			type: 'debugGrant',
			grant: { kind: 'attackDice', tier: 'basic', amount: 2 }
		});
		state = apply(state, 'Red', {
			type: 'debugGrant',
			grant: { kind: 'attackDice', tier: 'exalted', amount: 1 }
		});
		state.players.Red!.pendingDecisions.push({
			id: 'dec-sentinel',
			source: 'class',
			kind: 'sentinelDiscard',
			prompt: 'Sentinel: choose attack dice to discard before the roll of your next combat.',
			options: [
				{ id: 'yes', label: 'Discard the chosen dice before my next combat roll' },
				{ id: 'no', label: 'Discard nothing' }
			]
		});
		const picks = kinds(state, 'Red').filter((c) => c.type === 'resolveDecision');
		// {b}, {x}, {b,b}, {b,x}, {b,b,x} and "no".
		expect(picks).toHaveLength(6);
		const labels = request(state, 'Red')
			.actions.filter((a) => a.command.type === 'resolveDecision')
			.map((a) => a.label);
		expect(labels.some((l) => l.includes('[dice: 2 basic + 1 exalted]'))).toBe(true);
		const chosen = picks.find(
			(c) => c.type === 'resolveDecision' && c.selectedInstanceIds?.length === 3
		)!;
		const after = apply(state, 'Red', chosen);
		expect(after.players.Red!.sentinelDiscardIds).toHaveLength(3);
	});

	it('a relic tool card offers keep / its effect, and no VP (relics give no VP since 2026-11-13)', () => {
		let state = draftPowers(newGame(2, 46));
		state = apply(state, 'Red', {
			type: 'debugGrant',
			grant: { kind: 'rune', runeId: FIRECRACKER_ID }
		});
		offerHeldRelicTools(state, state.players.Red!, [], { ...catalog, relicToolVp: 0 });
		const labels = request(state, 'Red')
			.actions.filter((a) => a.command.type === 'resolveDecision')
			.map((a) => a.label);
		expect(labels.some((l) => l.includes('Keep Firecracker'))).toBe(true);
		expect(labels.some((l) => /\bVP\b/.test(l))).toBe(false);
		expect(labels.some((l) => l.includes('gain the initiative if your side does not have it'))).toBe(
			true
		);
	});

	it('every offered command is accepted by the reducer', () => {
		let state = goTo(draftPowers(newGame(3, 47)), {
			Red: 'Water Region',
			Blue: 'Fire Region',
			Orange: 'Arcane Abyss'
		});
		for (const seat of state.activeSeats) {
			for (const cmd of kinds(state, seat)) {
				expect(
					applyGameCommand(state, botActorFor(state, seat), cmd, catalog).ok,
					`${seat} ${cmd.type}`
				).toBe(true);
			}
		}
		state = apply(state, 'Red', { type: 'resolveLocationInteraction', rowIndex: 0 });
		expect(state.players.Red!.handDraws.length).toBeGreaterThan(0);
		expect(request(state, 'Red').kind).toBe('summon');
	});
});

describe('rules brief', () => {
	it('is generated from the catalog and matches the start state it describes', () => {
		expect(buildRulesBrief(catalog)).toBe(brief);
		const state = newGame(2, 51);
		const red = state.players.Red!;
		expect(brief).toContain(`Barrier ${red.barrier}/${red.maxBarrier}`);
		expect(red.barrier).toBe(4);
		expect(red.attackDice).toHaveLength(0);
		expect(red.spirits).toHaveLength(4);
		expect(red.mats.filter((m) => m.hasRune).map((m) => m.name)).toEqual(['Any Rune']);
		expect(red.pendingPowerDrafts?.[0]).toHaveLength(3);
		for (const power of ['Thorn Ward', 'Battle Fury', 'Mountain’s Wealth'])
			expect(brief).toContain(power);
		for (const spirit of catalog.spirits) expect(brief).toContain(spirit.name);
	});

	it('states the summon sizes the engine uses', () => {
		let state = goTo(draftPowers(newGame(2, 52)), { Red: 'Water Region', Blue: 'Forest Region' });
		state = apply(state, 'Red', { type: 'resolveLocationInteraction', rowIndex: 0 });
		const red = state.players.Red!;
		expect(red.handDraws.length).toBe(4);
		expect(red.pendingDraw?.summonLimit).toBe(2);
		expect(brief).toContain('draw 4 from the Spirit World bag, summon up to 2');
	});
});

describe('review regressions', () => {
	it('other seats get no event line for private moves (monster cards, power cards, trades)', () => {
		const state = newGame(2, 61);
		const view = seatProjection(state, 'Red');
		const privateMoves: GameCommand[] = [
			{ type: 'drawMonsterCards', difficulty: 2 },
			{ type: 'keepMonsterCard', index: 0 },
			{ type: 'chooseNavigationPower', powerId: 'thorn-ward' },
			{ type: 'resolveNavigationPower', offerId: 'o', optionId: 'decline' },
			{ type: 'respondNavigationPowerTrade', tradeId: 't', accept: true },
			{
				type: 'tradeNavigationPower',
				targetSeat: 'Blue',
				giveSpiritSlots: [1],
				receiveSpiritSlots: [1]
			}
		];
		for (const cmd of privateMoves) expect(publicLabelFor(cmd, 'Red', view), cmd.type).toBeNull();
		expect(
			publicLabelFor({ type: 'lockNavigation', destination: 'Fire Region' }, 'Red', view)
		).toBe('Red locked a destination.');
	});

	it('the budget refuses NaN limits and NaN estimates', () => {
		expect(() => new BudgetGuard({ maxSpendUsd: Number('1usd') })).toThrow(/maxSpendUsd/);
		const budget = new BudgetGuard({ maxSpendUsd: 1 });
		expect(() => budget.beforeCall(Number.NaN)).toThrow(BudgetExceededError);
	});

	it('provider failures count as calls and possible spend, not as invalid answers', async () => {
		const budget = new BudgetGuard({ maxSpendUsd: 10, maxTokens: Infinity, maxCalls: Infinity });
		const failing = {
			name: 'failing',
			estimateCostUsd: async () => 0.01,
			complete: async () => {
				const error = new ProviderError('timeout: the model did not answer', null, false);
				error.httpAttempts = 2;
				error.possiblyBilledAttempts = 1;
				throw error;
			}
		};
		const controller = new LlmSeatController({ provider: failing, model: 'x', budget });
		const answer = await controller.decide(request(draftPowers(newGame(2, 62)), 'Red'), {
			rulesBrief: brief
		});
		expect(answer.fallback).toBe(true);
		expect(answer.attempts).toHaveLength(1); // a non-retryable failure is not repeated
		expect(answer.attempts[0].providerError).toBe(true);
		expect(budget.calls).toBe(2);
		expect(budget.spentUsd).toBeCloseTo(0.01, 10);
	});

	it('identical unplaced augments are offered once; a long list keeps every kind of move', () => {
		let state = goTo(draftPowers(newGame(2, 63)), { Red: 'Forest Region', Blue: 'Forest Region' });
		state = apply(state, 'Red', { type: 'debugGrant', grant: { kind: 'augment', amount: 3 } });
		const placements = agentLegalCommands(state, 'Red', catalog).commands.filter(
			(c) => c.type === 'placeAugmentOnSpirit'
		);
		expect(placements.length).toBeGreaterThan(0);
		expect(placements.every((c) => c.type === 'placeAugmentOnSpirit' && c.augmentIndex === 0)).toBe(
			true
		);
		const many: GameCommand[] = [
			...Array.from(
				{ length: 120 },
				(_, i): GameCommand => ({
					type: 'placeAugmentOnSpirit',
					augmentIndex: 0,
					augmentRuneId: 'a',
					spiritSlotIndex: i
				})
			),
			{ type: 'resolveLocationInteraction', rowIndex: 0 },
			{ type: 'drawMonsterCards', difficulty: 1 },
			{ type: 'endLocationActions' }
		];
		const cut = fairCut(many, 10);
		expect(cut).toHaveLength(10);
		for (const type of [
			'placeAugmentOnSpirit',
			'resolveLocationInteraction',
			'drawMonsterCards',
			'endLocationActions'
		]) {
			expect(
				cut.some((c) => c.type === type),
				type
			).toBe(true);
		}
	});

	it('a budget stop in the middle of a decision keeps the cost of the calls already made', async () => {
		const priced: MockOptions = {
			policy: 'script',
			script: ['not json'],
			pricePerMillionIn: 100,
			pricePerMillionOut: 100
		};
		const probe = new MockProvider(priced);
		const firstRequest = request(draftPowers(newGame(2, 64)), 'Red');
		const estimate = await probe.estimateCostUsd({
			model: 'm',
			messages: [
				{ role: 'system', content: brief },
				{ role: 'user', content: renderDecisionMessage(firstRequest) }
			],
			maxTokens: 200
		});
		const budget = new BudgetGuard({
			maxSpendUsd: estimate * 1.5,
			maxTokens: Infinity,
			maxCalls: Infinity
		});
		const summary = await runAgentGame({
			catalog,
			catalogInfo,
			seed: 64,
			controllers: [
				new LlmSeatController({ provider: new MockProvider(priced), model: 'script', budget }),
				mockSeat({ policy: 'greedy', seed: 1 }, budget)
			],
			rulesBrief: brief,
			budget,
			runId: 'mid'
		});
		expect(summary.stopReason).toBe('budget');
		const total = summary.seats.reduce((n, s) => n + s.costUsd, 0);
		expect(budget.spentUsd).toBeGreaterThan(0);
		expect(total).toBeCloseTo(budget.spentUsd, 10);
		expect(summary.budget.spentUsd).toBeCloseTo(budget.spentUsd, 10);
	}, 60_000);
});

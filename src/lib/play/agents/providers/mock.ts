/**
 * Deterministic offline provider. It reads the prompt TEXT exactly as an LLM would (the action
 * list, the "decision #k" line) and answers in the same JSON format, so the whole prompt →
 * parse → apply path runs in tests and CI with no network.
 *
 * Policies:
 *   random  — seeded; prefers non-yield actions early in a phase, yields more as the phase goes on
 *   greedy  — seeded; picks by group priority (rewards, decision cards, awakening, fights, …,
 *             yield last), like an eager new player; exercises far more of the rules than random
 *   first   — always the first offered action
 *   script  — replays `script` answers in order (raw text, may be invalid), then `random`
 */

import { createRng, nextInt, type RngState } from '../../rng';
import { estimateTokens, type ChatProvider, type ChatRequest, type ChatResponse } from './types';

export type MockPolicy = 'random' | 'greedy' | 'first' | 'script';

export interface MockOptions {
	policy?: MockPolicy;
	seed?: number;
	script?: string[];
	/** Fake prices (USD per 1M tokens) so budget guards can be tested offline. */
	pricePerMillionIn?: number;
	pricePerMillionOut?: number;
}

const GREEDY_ORDER = [
	'reward',
	'decision',
	'power',
	'awaken',
	'augment',
	'fight',
	'monster-card',
	'summon',
	'attack',
	'location',
	'move',
	'other',
	'discard',
	'yield'
];

const ACTION_LINE = /^\s*(a\d+)\s+\(([a-z-]+)\)/;

export function parseOfferedActions(text: string): { id: string; group: string }[] {
	const out: { id: string; group: string }[] = [];
	for (const line of text.split('\n')) {
		const match = ACTION_LINE.exec(line);
		if (match) out.push({ id: match[1], group: match[2] });
	}
	return out;
}

export class MockProvider implements ChatProvider {
	readonly name = 'mock';
	readonly #policy: MockPolicy;
	readonly #rng: RngState;
	readonly #script: string[];
	readonly #in: number;
	readonly #out: number;
	calls = 0;

	constructor(opts: MockOptions = {}) {
		this.#policy = opts.policy ?? 'random';
		this.#rng = createRng(opts.seed ?? 1);
		this.#script = [...(opts.script ?? [])];
		this.#in = opts.pricePerMillionIn ?? 0;
		this.#out = opts.pricePerMillionOut ?? 0;
	}

	async estimateCostUsd(request: ChatRequest): Promise<number> {
		return (estimateTokens(request.messages) * this.#in + request.maxTokens * this.#out) / 1e6;
	}

	async complete(request: ChatRequest): Promise<ChatResponse> {
		this.calls += 1;
		const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
		// A repair turn carries no action list: read the list from the first decision message.
		const listSource = parseOfferedActions(lastUser).length
			? lastUser
			: (request.messages.find((m) => m.role === 'user' && parseOfferedActions(m.content).length)
					?.content ?? '');
		const offered = parseOfferedActions(listSource);
		let text: string;
		if (this.#policy === 'script' && this.#script.length > 0) {
			text = this.#script.shift()!;
		} else if (this.#policy === 'greedy') {
			text = JSON.stringify({
				action: this.#pickGreedy(offered, listSource),
				reason: 'mock: greedy group priority'
			});
		} else if (this.#policy === 'first') {
			text = JSON.stringify({
				action: offered[0]?.id ?? 'a1',
				reason: 'mock: first offered action'
			});
		} else {
			text = JSON.stringify({
				action: this.#pickRandom(offered, listSource),
				reason: 'mock: seeded random choice'
			});
		}
		const promptChars = request.messages.reduce((n, m) => n + m.content.length, 0);
		const promptTokens = Math.ceil(promptChars / 4);
		const completionTokens = Math.ceil(text.length / 4);
		return {
			text,
			promptTokens,
			completionTokens,
			costUsd: (promptTokens * this.#in + completionTokens * this.#out) / 1e6,
			costEstimated: false,
			servedModel: `mock:${this.#policy}`
		};
	}

	#pickGreedy(offered: { id: string; group: string }[], text: string): string {
		if (offered.length === 0) return 'a1';
		const index = Number(/decision #(\d+) in this phase/.exec(text)?.[1] ?? '1');
		// Yield once the phase has gone on for a while, so loops (attach/detach…) end.
		const yieldNow = index > 12 && offered.some((a) => a.group === 'yield');
		const order = yieldNow ? ['yield'] : GREEDY_ORDER;
		for (const group of order) {
			const pool = offered.filter((a) => a.group === group);
			if (pool.length) return pool[nextInt(this.#rng, pool.length)].id;
		}
		return offered[nextInt(this.#rng, offered.length)].id;
	}

	#pickRandom(offered: { id: string; group: string }[], text: string): string {
		if (offered.length === 0) return 'a1';
		const index = Number(/decision #(\d+) in this phase/.exec(text)?.[1] ?? '1');
		const yields = offered.filter((a) => a.group === 'yield');
		const others = offered.filter((a) => a.group !== 'yield');
		// Yield probability grows with the number of actions already taken this phase.
		const yieldChance = Math.min(90, 10 + 15 * (index - 1));
		if (yields.length && (others.length === 0 || nextInt(this.#rng, 100) < yieldChance)) {
			return yields[nextInt(this.#rng, yields.length)].id;
		}
		const pool = others.length ? others : offered;
		return pool[nextInt(this.#rng, pool.length)].id;
	}
}

/**
 * League agents are folders: `<agentsDir>/<id>/`
 *
 *   agent.json   {"name", "model", "effort", "memory", "learn"}; "default" model or effort = the
 *                league default (league.json). model: an `openai-codex/…` or `anthropic/…` id
 *                (gateway of that provider) or `mock:<policy>` (offline). memory: `fresh`
 *                (default) or `history`.
 *   strategy.md  the strategy text (empty = free choice)
 *   notebook.md  the agent's lessons between games (written by the league; learn: true only)
 *
 * To add an agent, copy a folder, rename it (lower-case letters, digits, -) and edit it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEAT_MEMORIES, type SeatMemory } from '../memory';
import { assertGatewayModel } from '../providers/gateway';
import type { MockPolicy } from '../providers/mock';
import type { Strategy } from '../strategy';

export interface LeagueAgent {
	id: string;
	dir: string;
	name: string;
	/** `openai-codex/…` or `anthropic/…` (gateway) or `mock:<policy>`. */
	model: string;
	effort: string;
	memory: SeatMemory;
	learn: boolean;
	/** The seat strategy: id = the agent id, text = strategy.md. */
	strategy: Strategy;
	/** Spirits the agent's opening four must include in every game (tests only; agent.json `openingSpirits`). */
	openingSpirits?: string[];
}

interface AgentFile {
	name?: string;
	model?: string;
	effort?: string;
	memory?: string;
	learn?: boolean;
	openingSpirits?: string[];
}

const MOCK_POLICIES: MockPolicy[] = ['random', 'greedy', 'first'];
export const NOTEBOOK_FILE = 'notebook.md';

const readText = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

export function isMockModel(model: string): boolean {
	return model.startsWith('mock:');
}

/**
 * A short model name for reports: `openai-codex/gpt-6.1-sol` → "GPT-6.1 Sol",
 * `anthropic/claude-opus-5-5` → "Claude Opus 5.5", `mock:greedy` → "mock greedy".
 */
export function modelName(model: string): string {
	if (isMockModel(model)) return `mock ${model.slice(5)}`;
	const words: string[] = [];
	for (const part of model.slice(model.indexOf('/') + 1).split('-')) {
		const last = words.length - 1;
		// Numbers in a row are one version (claude-opus-5-5 → 5.5); GPT keeps its dash (GPT-6.1).
		if (/^\d/.test(part) && last >= 0 && /^[\d.]+$/.test(words[last])) words[last] += `.${part}`;
		else if (/^\d/.test(part) && words[last] === 'GPT') words[last] += `-${part}`;
		else words.push(part === 'gpt' ? 'GPT' : /^\d/.test(part) ? part : part[0].toUpperCase() + part.slice(1));
	}
	return words.join(' ');
}

/** Model name and effort: "GPT-6.1 Sol low" (mock seats have no effort). */
export function modelLabel(agent: Pick<LeagueAgent, 'model' | 'effort'>): string {
	return isMockModel(agent.model) ? modelName(agent.model) : `${modelName(agent.model)} ${agent.effort}`;
}

/** Read one agent folder (defaults fill "default" model and effort). */
export function loadAgent(dir: string, id: string, defaults: { model: string; effort: string }) {
	if (!/^[a-z0-9-]+$/.test(id))
		throw new Error(`agent folder "${id}": use lower-case letters, digits and - only`);
	const file = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')) as AgentFile;
	const model = !file.model || file.model === 'default' ? defaults.model : file.model;
	const effort = !file.effort || file.effort === 'default' ? defaults.effort : file.effort;
	const memory = (file.memory ?? 'fresh') as SeatMemory;
	if (!SEAT_MEMORIES.includes(memory))
		throw new Error(`agent ${id}: memory must be ${SEAT_MEMORIES.join(' or ')}`);
	if (isMockModel(model)) {
		if (!MOCK_POLICIES.includes(model.slice(5) as MockPolicy))
			throw new Error(`agent ${id}: unknown mock policy "${model}"`);
	} else assertGatewayModel(model);
	const name = file.name?.trim() || id;
	const agent: LeagueAgent = {
		id,
		dir,
		name,
		model,
		effort,
		memory,
		learn: file.learn !== false,
		strategy: { id, name, text: readText(join(dir, 'strategy.md')).trim() }
	};
	if (file.openingSpirits !== undefined) {
		if (!Array.isArray(file.openingSpirits) || file.openingSpirits.some((n) => typeof n !== 'string' || !n.trim()))
			throw new Error(`agent ${id}: openingSpirits must be a list of spirit names`);
		if (file.openingSpirits.length > 4) throw new Error(`agent ${id}: at most 4 openingSpirits`);
		if (file.openingSpirits.length) agent.openingSpirits = file.openingSpirits.map((n) => n.trim());
	}
	return agent;
}

/** Every agent folder (one with an agent.json), sorted by id. */
export function loadAgents(
	agentsDir: string,
	defaults: { model: string; effort: string }
): LeagueAgent[] {
	if (!existsSync(agentsDir)) throw new Error(`no agents folder at ${agentsDir}`);
	return readdirSync(agentsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(join(agentsDir, d.name, 'agent.json')))
		.map((d) => d.name)
		.sort()
		.map((id) => loadAgent(join(agentsDir, id), id, defaults));
}

/** One learning agent per strategy (folders that exist are left as they are). */
export function createAgentsFromStrategies(
	agentsDir: string,
	strategies: Strategy[],
	file: Omit<AgentFile, 'name'> = {}
): string[] {
	const made: string[] = [];
	for (const s of strategies) {
		const dir = join(agentsDir, s.id);
		if (existsSync(join(dir, 'agent.json'))) continue;
		mkdirSync(dir, { recursive: true });
		const agent: AgentFile = {
			name: s.name,
			model: 'default',
			effort: 'default',
			memory: 'fresh',
			learn: true,
			...file
		};
		writeFileSync(join(dir, 'agent.json'), `${JSON.stringify(agent, null, '\t')}\n`);
		writeFileSync(join(dir, 'strategy.md'), s.text ? `${s.text}\n` : '');
		if (!existsSync(join(dir, NOTEBOOK_FILE))) writeFileSync(join(dir, NOTEBOOK_FILE), '');
		made.push(s.id);
	}
	return made;
}

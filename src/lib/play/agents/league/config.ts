/**
 * `league.json`, the one settings file of a league folder. Missing fields take the defaults
 * below; paths may start with `~/`, and relative paths are relative to the league folder.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { GATEWAY_PROVIDERS, type GatewayProviderId } from '../providers/gateway';

export interface LeagueGateway {
	label: string;
	url: string;
	/** The gateway's token file (read once, kept in memory, never written anywhere). */
	tokenFile: string;
	/** The provider this account serves (`openai-codex` default, or `anthropic`). */
	provider?: GatewayProviderId;
	/** Games in flight with a seat on this account. */
	games: number;
}

export interface LeagueConfig {
	agentsDir: string;
	/** The design data the owner edits (watched for changes). */
	dataDir: string;
	/** One per account; an agent's calls go to an account of its model's provider. */
	gateways: LeagueGateway[];
	/** Games in flight when every seat is a mock agent (no gateway). */
	mockGamesInFlight: number;
	defaultModel: string;
	defaultEffort: string;
	seed: number;
	/** Games per data version, then the league stops (null: play on forever). */
	maxGames: number | null;
	seatsPerGame: number;
	/** Decision cap per game (all seats). */
	maxDecisions: number;
	maxPhaseDecisions: number;
	/** Event lines per decision message (fresh seats see the events only there). */
	eventsPerPrompt: number;
	gatewayApi: 'responses' | 'chat';
	/** Per account: calls in flight (ceiling) and the call-start rate (adapts up to the max). */
	maxConcurrentCalls: number;
	callsPerMin: number;
	maxCallsPerMin: number;
	/** Seconds a stop waits for running after-game notebook calls before it aborts them. */
	stopGraceSec: number;
	/** A model benchmark: agents without strategy or learning; the report ranks agents, models
	 *  and efforts (Plackett-Luce rating with a 95% range, as the tournament). */
	benchmark: boolean;
}

export const DEFAULT_LEAGUE_CONFIG: LeagueConfig = {
	agentsDir: 'agents',
	dataDir: '~/arcspirits-harness/design-data/game',
	gateways: [],
	mockGamesInFlight: 8,
	defaultModel: 'openai-codex/gpt-6.1-sol',
	defaultEffort: 'low',
	seed: 2026,
	maxGames: null,
	seatsPerGame: 4,
	maxDecisions: 3000,
	maxPhaseDecisions: 30,
	eventsPerPrompt: 60,
	gatewayApi: 'responses',
	maxConcurrentCalls: 48,
	callsPerMin: 120,
	maxCallsPerMin: 300,
	stopGraceSec: 60,
	benchmark: false
};

/** `~/x` → home; relative → under `base`. */
export function resolvePath(base: string, path: string): string {
	const home = path.replace(/^~(?=\/|$)/, homedir());
	return isAbsolute(home) ? home : resolve(join(base, home));
}

export function loadLeagueConfig(leagueDir: string): LeagueConfig {
	const path = join(leagueDir, 'league.json');
	if (!existsSync(path)) throw new Error(`no league.json in ${leagueDir}`);
	const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LeagueConfig>;
	const config: LeagueConfig = { ...DEFAULT_LEAGUE_CONFIG, ...raw };
	const positive = (name: keyof LeagueConfig, min = 1) => {
		const v = config[name];
		if (typeof v !== 'number' || !Number.isFinite(v) || v < min)
			throw new Error(`league.json: "${name}" must be a number ≥ ${min}`);
	};
	for (const name of [
		'mockGamesInFlight',
		'seatsPerGame',
		'maxDecisions',
		'maxPhaseDecisions',
		'eventsPerPrompt',
		'maxConcurrentCalls',
		'callsPerMin',
		'maxCallsPerMin'
	] as const)
		positive(name);
	positive('seed', 0);
	positive('stopGraceSec', 0);
	if (config.maxGames !== null) positive('maxGames');
	if (typeof config.benchmark !== 'boolean') throw new Error('league.json: "benchmark" must be true or false');
	if (config.seatsPerGame < 2 || config.seatsPerGame > 4)
		throw new Error('league.json: "seatsPerGame" must be 2, 3 or 4');
	const labels = new Set<string>();
	for (const g of config.gateways) {
		if (!g.label || !g.url || !g.tokenFile || !(g.games >= 1))
			throw new Error('league.json: each gateway needs "label", "url", "tokenFile" and "games" ≥ 1');
		if (g.provider !== undefined && !GATEWAY_PROVIDERS.includes(g.provider))
			throw new Error(
				`league.json: gateway "${g.label}": "provider" must be ${GATEWAY_PROVIDERS.join(' or ')}`
			);
		if (labels.has(g.label)) throw new Error(`league.json: gateway label "${g.label}" is listed twice`);
		labels.add(g.label);
	}
	return {
		...config,
		agentsDir: resolvePath(leagueDir, config.agentsDir),
		dataDir: resolvePath(leagueDir, config.dataDir),
		gateways: config.gateways.map((g) => ({ ...g, tokenFile: resolvePath(leagueDir, g.tokenFile) }))
	};
}

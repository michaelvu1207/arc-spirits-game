import type { GameCommand, PublicGameState, SeatColor } from '../types';

export const BOT_CONTRACT_VERSION = 'arc-bot-v1';
export const ML_BOT_PROFILE_KEY = 'neural';
/** Champion net + Gumbel root search at the strategic nodes (nav/encounter). */
export const EXPERT_BOT_PROFILE_KEY = 'expert';
export const DEFAULT_BOT_PROFILE_KEY = ML_BOT_PROFILE_KEY;

export const BOT_PROFILE_KEYS = [ML_BOT_PROFILE_KEY, EXPERT_BOT_PROFILE_KEY] as const;

export type BotProfileKey = (typeof BOT_PROFILE_KEYS)[number];
export type BotActionId = `${typeof BOT_CONTRACT_VERSION}:${string}`;

export interface BotLegalActionV1 {
	actionId: BotActionId;
	command: GameCommand;
}

export interface BotObservationV1 {
	contract: typeof BOT_CONTRACT_VERSION;
	seat: SeatColor;
	state: PublicGameState;
	legalActions: BotLegalActionV1[];
}

export interface BotDecisionV1 {
	contract: typeof BOT_CONTRACT_VERSION;
	actionId: BotActionId;
}

export function isBotProfileKey(value: unknown): value is BotProfileKey {
	return typeof value === 'string' && BOT_PROFILE_KEYS.includes(value as BotProfileKey);
}

export function normalizeBotProfileKey(value: unknown): BotProfileKey {
	const key = typeof value === 'string' ? value.toLowerCase() : '';
	return isBotProfileKey(key) ? key : DEFAULT_BOT_PROFILE_KEY;
}

export function actionIdForCommand(command: GameCommand): BotActionId {
	return `${BOT_CONTRACT_VERSION}:${stableJson(command)}`;
}

export function legalActionForCommand(command: GameCommand): BotLegalActionV1 {
	return {
		actionId: actionIdForCommand(command),
		command
	};
}

export function buildBotObservation(
	state: PublicGameState,
	seat: SeatColor,
	commands: GameCommand[]
): BotObservationV1 {
	return {
		contract: BOT_CONTRACT_VERSION,
		seat,
		state,
		legalActions: commands.map(legalActionForCommand)
	};
}

export function commandForDecision(
	observation: BotObservationV1,
	decision: BotDecisionV1
): GameCommand | null {
	if (decision.contract !== BOT_CONTRACT_VERSION) return null;
	return (
		observation.legalActions.find((action) => action.actionId === decision.actionId)?.command ??
		null
	);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

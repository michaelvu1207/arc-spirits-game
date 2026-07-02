import { describe, expect, test } from 'vitest';
import type { GameCommand, PublicGameState } from '../types';
import {
	BOT_CONTRACT_VERSION,
	DEFAULT_BOT_PROFILE_KEY,
	actionIdForCommand,
	buildBotObservation,
	commandForDecision,
	normalizeBotProfileKey
} from './contract';

describe('bot contract', () => {
	test('normalizes legacy heuristic profile names to the ML policy key', () => {
		expect(normalizeBotProfileKey('neural')).toBe(DEFAULT_BOT_PROFILE_KEY);
		expect(normalizeBotProfileKey('fast')).toBe(DEFAULT_BOT_PROFILE_KEY);
		expect(normalizeBotProfileKey('pvphunter')).toBe(DEFAULT_BOT_PROFILE_KEY);
		expect(normalizeBotProfileKey(null)).toBe(DEFAULT_BOT_PROFILE_KEY);
	});

	test('builds stable action ids from canonical command JSON', () => {
		const command = {
			optionId: 'rest',
			type: 'resolveDecision',
			decisionId: 'choice-1'
		} as GameCommand;

		expect(actionIdForCommand(command)).toBe(
			`${BOT_CONTRACT_VERSION}:{"decisionId":"choice-1","optionId":"rest","type":"resolveDecision"}`
		);
	});

	test('resolves a decision back to one of the advertised legal commands', () => {
		const command = { type: 'lockNavigation', destination: 'Cyber City' } as GameCommand;
		const observation = buildBotObservation({} as PublicGameState, 'Red', [command]);

		expect(
			commandForDecision(observation, {
				contract: BOT_CONTRACT_VERSION,
				actionId: actionIdForCommand(command)
			})
		).toEqual(command);
	});
});

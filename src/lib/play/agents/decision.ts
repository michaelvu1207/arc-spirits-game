/**
 * Build one {@link DecisionRequest} for a seat. This is the function a live-room adapter calls
 * too: give it the authoritative state, the seat and the seat's event lines, and it returns
 * the viewer-safe request plus the offered commands.
 */

import { actionIdForCommand } from '../bots/contract';
import type {
	GameCommand,
	PlayCatalog,
	PublicGameState,
	SeatColor,
	SpectatorProjection
} from '../types';
import { agentLegalCommands, type SurfaceResult } from './actionSurface';
import {
	AGENT_CONTRACT_VERSION,
	PROMPT_VERSION,
	type DecisionKind,
	type DecisionRequest,
	type OfferedAction
} from './contract';
import { groupFor, labelFor } from './labels';
import { decisionFacts, paceLine } from './preview';
import { renderSeatView, seatProjection } from './view';

export function decisionKind(
	view: SpectatorProjection,
	seat: SeatColor,
	surface: SurfaceResult
): DecisionKind {
	const me = view.players[seat];
	const types = new Set(surface.commands.map((c) => c.type));
	if (surface.powerPrompt) {
		if (types.has('resolveNavigationPower')) return 'power-offer';
		if (types.has('respondNavigationPowerTrade')) return 'power-trade-response';
		return 'power-draft';
	}
	if (types.has('resolveDecision')) return 'decision-card';
	switch (view.phase) {
		case 'navigation':
			return 'navigation';
		case 'encounter':
			return 'encounter';
		case 'location':
			if (me?.pendingCorruptionDiscard && types.has('discardSpirit')) return 'corruption-payment';
			if (types.has('keepMonsterCard')) return 'monster-reveal';
			if (types.has('resolveMonsterReward')) return 'monster-reward';
			if (types.has('spawnHandSpirit') || types.has('discardHandDraws')) return 'summon';
			return 'location';
		case 'benefits':
			return 'benefits';
		case 'awakening':
			return 'awakening';
		case 'cleanup':
			return me?.pendingCorruptionDiscard && types.has('discardSpirit')
				? 'corruption-payment'
				: 'cleanup';
	}
}

const SITUATION: Record<DecisionKind, string> = {
	'power-draft': 'Choose one Navigation Power card to keep (the others are discarded).',
	'power-offer': 'A Navigation Power asks you to choose.',
	'power-trade-response': 'Another player proposes a Shared Current trade. Accept or decline.',
	navigation:
		'Choose your destination for this round. It stays secret until every player has locked.',
	encounter: 'Encounter: decide whether to attack (only Evil players can) or pass.',
	location: 'Location phase: choose your next action here, or end your Location turn.',
	'monster-reveal': 'Two monster cards are revealed: keep one.',
	'monster-reward': 'You defeated a monster: claim its rewards.',
	summon: 'Choose which drawn spirit to summon (or summon none).',
	'corruption-payment': 'You were corrupted: choose which spirit to sacrifice.',
	'decision-card': 'Answer your decision card (or take another action).',
	benefits: 'Benefits step: claim your rewards, then finish the step.',
	awakening: 'Awakening step: awaken spirits, place augments, answer cards, then finish the step.',
	cleanup: 'Cleanup: discard down to the limits, then finish the round.'
};

export interface BuiltDecision {
	request: DecisionRequest;
	surface: SurfaceResult;
	view: SpectatorProjection;
}

export function offeredActions(
	commands: GameCommand[],
	view: SpectatorProjection,
	seat: SeatColor,
	catalog: PlayCatalog
): OfferedAction[] {
	return commands.map((command, i) => ({
		id: `a${i + 1}`,
		actionId: actionIdForCommand(command),
		label: labelFor(command, view, seat, catalog),
		group: groupFor(command),
		command
	}));
}

export function buildDecision(input: {
	state: PublicGameState;
	seat: SeatColor;
	catalog: PlayCatalog;
	gameId: string;
	requestId: string;
	events: string[];
	phaseDecisionIndex: number;
	surface?: SurfaceResult;
}): BuiltDecision {
	const { state, seat, catalog } = input;
	const surface = input.surface ?? agentLegalCommands(state, seat, catalog);
	const view = seatProjection(state, seat);
	const kind = decisionKind(view, seat, surface);
	const request: DecisionRequest = {
		contract: AGENT_CONTRACT_VERSION,
		promptVersion: PROMPT_VERSION,
		requestId: input.requestId,
		gameId: input.gameId,
		seat,
		round: view.round,
		phase: view.phase,
		kind,
		situation:
			SITUATION[kind] +
			(surface.truncated ? ' (Long list: only the first options are shown.)' : ''),
		viewText: renderSeatView(view, seat, catalog),
		events: input.events,
		actions: offeredActions(surface.commands, view, seat, catalog),
		phaseDecisionIndex: input.phaseDecisionIndex,
		// A forced move (one action) is not asked, so it needs no facts.
		facts: surface.commands.length > 1 ? decisionFacts(state, seat, catalog, kind) : [],
		pace: paceLine(state, seat)
	};
	return { request, surface, view };
}

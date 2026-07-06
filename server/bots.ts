/**
 * In-process bot driving for the room server. This REUSES the engine's bot policy
 * wholesale — botSeatNeedsToAct + botActorFor (server/botPolicy.ts) and getNeuralPolicy /
 * planNeuralPhaseActions / planUniformLegalPhaseActions (ml/neuralBot.ts) — exactly as
 * src/lib/play/server/botSim.ts::tickBots does. The ONLY thing reimplemented is the small
 * seat-detection glue (which is trivial and pure) and the driving loop, which now applies
 * commands through the room host's in-memory queue instead of one Supabase CAS write per
 * command. No per-command DB round-trip; revision bumps + delta broadcasts + interval
 * snapshots come from the host.
 */

import { botSeatNeedsToAct, botActorFor } from '../src/lib/play/server/botPolicy';
import {
	getNeuralPolicy,
	planNeuralPhaseActions,
	planUniformLegalPhaseActions
} from '../src/lib/play/ml/neuralBot';
import type { NeuralPolicy } from '../src/lib/play/ml/net';
import { SEAT_COLORS } from '../src/lib/play/types';
import type { GameActor, GameCommand, PublicGameState, SeatColor } from '../src/lib/play/types';
import { BOT_NAME_PREFIX } from '../src/lib/play/roomLifecycle';
import {
	DEFAULT_BOT_PROFILE_KEY,
	EXPERT_BOT_PROFILE_KEY,
	ML_BOT_PROFILE_KEY,
	normalizeBotProfileKey
} from '../src/lib/play/bots/contract';

export { getNeuralPolicy, botActorFor };
export type { NeuralPolicy };

/** True if a display name belongs to a legacy 🤖 bot member. */
function isBotDisplayName(displayName: string | null | undefined): boolean {
	return typeof displayName === 'string' && displayName.startsWith(BOT_NAME_PREFIX);
}

/** Difficulty/strategy parsed from a legacy 🤖 display name, normalized to a contract key. */
function difficultyFromBotName(displayName: string | null | undefined): string {
	if (!isBotDisplayName(displayName)) return DEFAULT_BOT_PROFILE_KEY;
	const rest = (displayName as string).slice(BOT_NAME_PREFIX.length).trim();
	const parts = rest.split(/\s+/);
	if (parts.length < 2) return DEFAULT_BOT_PROFILE_KEY;
	return normalizeBotProfileKey(parts[0]);
}

/** Is the seat's member a bot? Authoritative source is the `botMembers` map (the `is_bot`
 *  column); the legacy 🤖 name is a fallback for rows predating the column. Ported from
 *  botSim.seatIsBot. */
export function seatIsBot(
	state: PublicGameState,
	seat: SeatColor,
	botMembers: Map<string, string | null>
): boolean {
	const memberId = state.seats[seat]?.memberId;
	if (memberId == null) return false;
	if (botMembers.has(memberId)) return true;
	return isBotDisplayName(state.seats[seat]?.displayName);
}

/** Seats currently occupied by a bot member, in seat order. */
export function seatedBotSeats(
	state: PublicGameState,
	botMembers: Map<string, string | null>
): SeatColor[] {
	return SEAT_COLORS.filter((seat) => seatIsBot(state, seat, botMembers));
}

/** The bot member id seated at `seat`, or null. */
export function botMemberIdAt(
	state: PublicGameState,
	seat: SeatColor,
	botMembers: Map<string, string | null>
): string | null {
	if (!seatIsBot(state, seat, botMembers)) return null;
	return state.seats[seat]?.memberId ?? null;
}

/** Any bot-occupied seat in the room? */
export function hasBotSeats(
	state: PublicGameState,
	botMembers: Map<string, string | null>
): boolean {
	return SEAT_COLORS.some((seat) => seatIsBot(state, seat, botMembers));
}

/** Live bot-tuning knobs from the environment (mirrors botSim's ARC_* switches). */
export interface BotTuning {
	/** ARC_EXPERT_BOTS=1 upgrades neural bots to the search (expert) tier. */
	expertAll: boolean;
	/** ARC_LIVE_BOT_TEMP overrides the live sampling temperature (default 0.65; 0 = argmax). */
	temperature: number;
}

export function botTuningFromEnv(): BotTuning {
	return {
		expertAll: process.env.ARC_EXPERT_BOTS === '1',
		temperature:
			process.env.ARC_LIVE_BOT_TEMP !== undefined ? parseFloat(process.env.ARC_LIVE_BOT_TEMP) : 0.65
	};
}

/**
 * Plan the phase commands for ONE bot seat — the exact strategy selection tickBots uses:
 * neural (or expert search) when a policy is loaded and the profile is neural/expert, else
 * uniform-legal. A planner throw degrades to uniform, then to an empty plan (never escapes).
 */
export function planSeatCommands(
	state: PublicGameState,
	seat: SeatColor,
	catalog: import('../src/lib/play/types').PlayCatalog,
	neuralPolicy: NeuralPolicy | null,
	profileKey: string,
	tuning: BotTuning
): GameCommand[] {
	const expert =
		profileKey === EXPERT_BOT_PROFILE_KEY ||
		(profileKey === ML_BOT_PROFILE_KEY && tuning.expertAll);
	try {
		return (profileKey === ML_BOT_PROFILE_KEY || profileKey === EXPERT_BOT_PROFILE_KEY) &&
			neuralPolicy
			? planNeuralPhaseActions(state, seat, catalog, neuralPolicy, {
					search: expert,
					temperature: tuning.temperature
				})
			: planUniformLegalPhaseActions(state, seat, catalog);
	} catch {
		try {
			return planUniformLegalPhaseActions(state, seat, catalog);
		} catch {
			return [];
		}
	}
}

/** Resolve a seat's bot profile key (bot_profile column, else legacy name parse). */
export function botProfileForSeat(
	state: PublicGameState,
	seat: SeatColor,
	botMemberId: string,
	botMembers: Map<string, string | null>
): string {
	return normalizeBotProfileKey(
		botMembers.get(botMemberId) ?? difficultyFromBotName(state.seats[seat]?.displayName)
	);
}

/**
 * Advance every seated bot through the CURRENT phase once, applying each command through
 * `applyBotCommand` (the host's in-memory queue). Mirrors tickBots' inner loop; returns the
 * number of commands actually applied. `getState` is re-read after each seat so the next
 * bot sees the freshest phase.
 */
export async function stepBotSeats(params: {
	getState: () => PublicGameState;
	applyBotCommand: (actor: GameActor, command: GameCommand) => Promise<{ ok: boolean }>;
	catalog: import('../src/lib/play/types').PlayCatalog;
	botMembers: Map<string, string | null>;
	neuralPolicy: NeuralPolicy | null;
	tuning: BotTuning;
}): Promise<number> {
	const { getState, applyBotCommand, catalog, botMembers, neuralPolicy, tuning } = params;
	let issued = 0;
	for (const seat of seatedBotSeats(getState(), botMembers)) {
		let state = getState();
		if (state.status !== 'active') break;
		const botMemberId = botMemberIdAt(state, seat, botMembers);
		if (!botMemberId) continue;
		if (!botSeatNeedsToAct(state, seat)) continue;

		const profileKey = botProfileForSeat(state, seat, botMemberId, botMembers);
		const commands = planSeatCommands(state, seat, catalog, neuralPolicy, profileKey, tuning);
		const actor = botActorFor(state, seat);
		for (const command of commands) {
			const outcome = await applyBotCommand(actor, command);
			if (!outcome.ok) break; // a planned command can be stale — stop this seat, re-plan next tick
			issued += 1;
		}
	}
	return issued;
}

/**
 * Seats that still hold up the current phase (need to act). Used by the host's
 * bot-blocked fast-forward: when every holdout is a bot (no human is still choosing), the
 * phase's wall-clock deadline is pure dead time and can be enforced immediately.
 */
export function phaseHoldoutSeats(state: PublicGameState): SeatColor[] {
	return state.activeSeats.filter((seat) => botSeatNeedsToAct(state, seat));
}

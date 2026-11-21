/**
 * The typed context every class/trait effect runs inside.
 *
 * `applyTrigger` builds one `EffectContext` per fired trigger and threads it to
 * each action handler, replacing the old bare `(state, player, log)` argument
 * triple. Later phases widen the *consumers* of these fields (combat, awakening,
 * interactions) without having to re-thread plumbing — everything an effect can
 * possibly need is already on the context.
 */

import type {
	NavigationDestination,
	PlayCatalog,
	PrivatePlayerState,
	PublicGameState,
	SeatColor
} from '../types';
import type { EffectTrigger } from './registry';
import { colocatedPlayers } from './colocated';

/** What an in-flight combat exposes to an effect (e.g. onMonsterKill). */
export interface EffectCombatInfo {
	/** Damage the acting player dealt this combat. */
	dealt: number;
	/** Damage dealt beyond what was needed to kill (≥ 0). */
	overkill: number;
	/** Whether the target was killed. */
	killed: boolean;
	/** The opposing seat in a PvP combat (absent for monster fights). */
	opponent?: SeatColor;
	/** The opposing SIDE's pooled initiative in a group Encounter (PvP) combat. When
	 *  present, initiative-comparing effects (Bastion) use this instead of a single
	 *  representative seat's initiative, so they judge against the whole attacking side. */
	opponentInitiative?: number;
	/** True when a monster deals this hit (fightMonster); read by Bastion under `bastionVsMonsters`. */
	vsMonster?: boolean;
}

/** What a resolved trade interaction gave up (Mage hooks `onLocationInteraction`). */
export interface TradePayload {
	/** Number of (non-relic) runes spent on the trade's cost. */
	runes: number;
	/** Number of relics spent on the trade's cost. */
	relics: number;
}

/**
 * Everything a class/trait effect handler may read or mutate. `state`, `seat`,
 * `player`, `catalog`, `log` and `trigger` are always present; the rest are
 * populated only for the triggers that carry them.
 */
export interface EffectContext {
	/** The full game state (mutated in place by handlers). */
	state: PublicGameState;
	/** The acting seat. */
	seat: SeatColor;
	/** The acting player (always `state.players[seat]`). */
	player: PrivatePlayerState;
	/** The play catalog (spirits/classes/runes/etc.). */
	catalog: PlayCatalog;
	/** Human-readable log the effect appends to. */
	log: string[];
	/** Which trigger fired. */
	trigger: EffectTrigger;
	/** Number of relevant traits the acting player has for the firing class. */
	traitCount: number;

	/** The triggering command, when a trigger is driven by one. */
	command?: unknown;
	/** Opposing seat for interaction/PvP triggers. */
	opponent?: SeatColor;
	/** Previous status level, for onStatusChange. */
	oldStatus?: number;
	/** New status level, for onStatusChange. */
	newStatus?: number;
	/** In-flight combat info, for combat triggers. */
	combat?: EffectCombatInfo;
	/** What a resolved trade gave up, for `onLocationInteraction` (Mage). */
	trade?: TradePayload;
	/** Active players sharing this player's location (excludes self, order-stable). */
	colocated: PrivatePlayerState[];
}

/** A catalog with no entries — the fallback when none is threaded to a trigger. */
export const EMPTY_CATALOG: PlayCatalog = {
	guardians: [],
	spirits: [],
	mats: [],
	classes: [],
	dice: [],
	monsters: []
};

/** Inputs `applyTrigger` accepts; `traitCount`/`colocated` are derived if omitted. */
export interface BuildContextInput {
	state: PublicGameState;
	seat: SeatColor;
	player: PrivatePlayerState;
	trigger: EffectTrigger;
	log: string[];
	traitCount: number;
	catalog?: PlayCatalog;
	command?: unknown;
	opponent?: SeatColor;
	oldStatus?: number;
	newStatus?: number;
	combat?: EffectCombatInfo;
	trade?: TradePayload;
	/** Override the co-located set (defaults to {@link colocatedPlayers}). */
	colocated?: PrivatePlayerState[];
}

/** Assemble a fully-populated {@link EffectContext}, deriving optional fields. */
export function buildEffectContext(input: BuildContextInput): EffectContext {
	return {
		state: input.state,
		seat: input.seat,
		player: input.player,
		catalog: input.catalog ?? EMPTY_CATALOG,
		log: input.log,
		trigger: input.trigger,
		traitCount: input.traitCount,
		command: input.command,
		opponent: input.opponent,
		oldStatus: input.oldStatus,
		newStatus: input.newStatus,
		combat: input.combat,
		trade: input.trade,
		colocated: input.colocated ?? colocatedPlayers(input.state, input.seat)
	};
}

/** A navigation destination, re-exported for handlers that gate on location. */
export type { NavigationDestination };

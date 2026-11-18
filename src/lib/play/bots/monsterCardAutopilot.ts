/**
 * Monster-card autopilot — the deterministic Arcane Abyss card play every bot tier shares.
 *
 * A player's monster cards are their own: they draw them into a private hand (max 3) and fight
 * them from it. Nothing is placed in the Abyss. None of the bot planners (neural / expert /
 * uniform-legal / heuristic) choose among the card commands themselves, so each runs this first
 * during its location turn:
 *
 *   1. a pending two-card reveal → keep the card this seat is most likely to kill;
 *   2. room in the hand and no likely kill in it → draw from the highest difficulty deck whose
 *      weakest card is still a likely kill (P ≥ 0.5), else from the lowest difficulty that has cards.
 *
 * The fight itself stays with the planners; `bestStartCombatCommand` names the hand card to fight.
 * Cards are ranked by kill probability, then lower Barrier left, then more claimable VP. Every
 * command is checked with `canApply`, so the plan is always legal. Pure: the input state is never
 * mutated.
 */

import { applyGameCommand, monsterCardFromCatalog } from '../runtime';
import { monsterBarrierLeft } from '../combat';
import { canApply } from '../legality';
import { buildMonsterRewards } from '../monsterRewards';
import { botActorFor, computeKillProbability } from '../server/botPolicy';
import type {
	GameCommand,
	MonsterState,
	PlayCatalog,
	PlayCatalogMonster,
	PublicGameState,
	RuntimeBagEntry,
	SeatColor
} from '../types';

/** A drawn card must be at least this likely a kill before the bot reaches for a harder deck. */
const LIKELY_KILL = 0.5;
/** A player holds at most this many monster cards. */
const MAX_HAND = 3;
/** draw → keep is two steps; the cap only guards against a reducer surprise. */
const MAX_CARD_STEPS = 4;

/** True when `monster` can still be fought (Barrier left). */
export function isLiveMonster(monster: MonsterState | null | undefined): monster is MonsterState {
	return !!monster && monster.hp > 0;
}

/** The card a catalog monster becomes when drawn (the runtime's own builder). */
export { monsterCardFromCatalog };

/** The card a monster-deck entry would reveal as (catalog data when known, else the entry). */
function deckEntryCard(entry: RuntimeBagEntry, catalog: PlayCatalog): MonsterState {
	const known = (catalog.monsters ?? []).find((monster) => monster.id === entry.id);
	return monsterCardFromCatalog(
		known ?? {
			id: entry.id ?? entry.guid,
			name: entry.name,
			damage: entry.damage ?? 0,
			barrier: entry.barrier ?? 1,
			rewardTrack: [],
			dicePool: [],
			chooseAmount: 2,
			stage: 1,
			order: 0
		},
		catalog
	);
}

/** VP a kill of `card` grants (a kill grants every reward on the card). */
function claimableVp(card: MonsterState): number {
	return buildMonsterRewards(card.rewardTrack).reduce(
		(sum, option) => sum + (option.effect.type === 'vp' ? option.effect.amount : 0),
		0
	);
}

export interface CardScore {
	killProbability: number;
	effectiveHp: number;
	vp: number;
}

export function scoreCard(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	card: MonsterState
): CardScore {
	return {
		killProbability: computeKillProbability(state, seat, catalog, { monster: card }),
		effectiveHp: monsterBarrierLeft(card),
		vp: claimableVp(card)
	};
}

/** Negative when `a` is the better card to fight. */
function compareScores(a: CardScore, b: CardScore): number {
	return b.killProbability - a.killProbability || a.effectiveHp - b.effectiveHp || b.vp - a.vp;
}

/** Index of the card `seat` is most likely to kill (ties: lower effective HP, then more VP); -1 if none. */
export function bestMonsterCardIndex(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cards: readonly MonsterState[]
): number {
	let best = -1;
	let bestScore: CardScore | null = null;
	cards.forEach((card, index) => {
		const score = scoreCard(state, seat, catalog, card);
		if (!bestScore || compareScores(score, bestScore) < 0) {
			best = index;
			bestScore = score;
		}
	});
	return best;
}

/** The most killable card left in one difficulty deck (deck order stays unknown), or null. */
function weakestDeckCard(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	difficulty: 1 | 2 | 3
): { card: MonsterState; score: CardScore } | null {
	let best: { card: MonsterState; score: CardScore } | null = null;
	const seen = new Set<string>();
	for (const entry of state.bags?.monsters?.contents ?? []) {
		if (entry.difficulty !== difficulty) continue;
		const card = deckEntryCard(entry, catalog);
		if (seen.has(card.id)) continue;
		seen.add(card.id);
		const score = scoreCard(state, seat, catalog, card);
		if (!best || compareScores(score, best.score) < 0) best = { card, score };
	}
	return best;
}

/**
 * The card in `seat`'s own monster hand it is most likely to kill, with its hand index; null for
 * an empty hand (or one holding only defeated cards). This is "the monster this seat would fight".
 */
export function bestHandMonster(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog
): { card: MonsterState; handIndex: number; score: CardScore } | null {
	const hand = state.players[seat]?.monsterHand ?? [];
	let best: { card: MonsterState; handIndex: number; score: CardScore } | null = null;
	for (let handIndex = 0; handIndex < hand.length; handIndex++) {
		const card = hand[handIndex];
		if (!isLiveMonster(card)) continue;
		const score = scoreCard(state, seat, catalog, card);
		if (!best || compareScores(score, best.score) < 0) best = { card, handIndex, score };
	}
	return best;
}

/**
 * The monster `seat` would face at the Abyss: its best hand card, else (empty hand — it would draw
 * on arrival) the most killable card of the lowest difficulty deck that still has cards. Null when
 * the hand is empty and every deck is empty. Navigation scores the Abyss against it.
 */
export function abyssPreviewMonster(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog
): MonsterState | null {
	if (!state.players[seat]) return null;
	const inHand = bestHandMonster(state, seat, catalog);
	if (inHand) return inHand.card;
	for (const difficulty of [1, 2, 3] as const) {
		const weakest = weakestDeckCard(state, seat, catalog, difficulty);
		if (weakest) return weakest.card;
	}
	return null;
}

/**
 * The fight command for the hand card `seat` is most likely to kill, or null when it holds no
 * live card or cannot start a combat now. Planners decide WHETHER to fight; this names WHICH card.
 */
export function bestStartCombatCommand(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog
): Extract<GameCommand, { type: 'startCombat' }> | null {
	const best = bestHandMonster(state, seat, catalog);
	if (!best) return null;
	const command = { type: 'startCombat', handIndex: best.handIndex } as const;
	return canApply(state, botActorFor(state, seat), command, catalog) === false ? null : command;
}

/**
 * The single next card command for `seat`, or null when there is nothing to do. Planners that
 * thread their own working copy call this in a loop (apply, ask again) until it returns null.
 */
export function nextMonsterCardCommand(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog
): GameCommand | null {
	if (state.status !== 'active' || state.phase !== 'location') return null;
	const player = state.players[seat];
	if (!player || player.navigationDestination !== 'Arcane Abyss') return null;
	const actor = botActorFor(state, seat);
	const legal = (command: GameCommand) => canApply(state, actor, command, catalog) === true;

	const reveal = player.pendingMonsterDraw?.cards ?? [];
	if (reveal.length > 0) {
		const keep: GameCommand = { type: 'keepMonsterCard', index: bestMonsterCardIndex(state, seat, catalog, reveal) };
		return legal(keep) ? keep : null;
	}

	// Draw only while the hand has room and holds no likely kill (an empty hand always draws).
	const hand = player.monsterHand ?? [];
	if (hand.length >= MAX_HAND) return null;
	if ((bestHandMonster(state, seat, catalog)?.score.killProbability ?? 0) >= LIKELY_KILL) return null;

	const drawable = ([1, 2, 3] as const).filter((difficulty) =>
		legal({ type: 'drawMonsterCards', difficulty })
	);
	if (drawable.length === 0) {
		// Every deck is empty: take the permanent monster when the game has one.
		const permanent: GameCommand = { type: 'drawMonsterCards', difficulty: 1, permanent: true };
		return legal(permanent) ? permanent : null;
	}
	const confident = [...drawable]
		.reverse()
		.find((difficulty) => (weakestDeckCard(state, seat, catalog, difficulty)?.score.killProbability ?? 0) >= LIKELY_KILL);
	return { type: 'drawMonsterCards', difficulty: confident ?? drawable[0] };
}

/**
 * The monster-card commands `seat` should issue NOW, in order (empty when not applicable): only in
 * the location phase at the Arcane Abyss. A draw reveals cards deterministically (top of the
 * difficulty deck), so the plan simulates it on a private copy and follows up with the keep in the
 * same batch. Run it before deciding whether to `startCombat`.
 */
export function planMonsterCardCommands(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog
): GameCommand[] {
	const commands: GameCommand[] = [];
	let working = state;
	for (let step = 0; step < MAX_CARD_STEPS; step++) {
		const command = nextMonsterCardCommand(working, seat, catalog);
		if (!command) break;
		const result = applyGameCommand(working, botActorFor(working, seat), command, catalog);
		if (!result.ok) break;
		commands.push(command);
		working = result.state;
	}
	return commands;
}

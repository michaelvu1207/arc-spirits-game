/**
 * Feature encoders for the ML bot. Two pure functions turn engine state into the
 * fixed-length float vectors the candidate-scoring net consumes:
 *
 *   • encodeObs(state, seat)        → OBS_DIM floats  (the situation, from `seat`'s POV)
 *   • encodeAction(state, seat, cmd, next, catalog) → ACT_DIM floats (one candidate move)
 *
 * The net scores each legal candidate as score(concat(obs, actionFeat)); a softmax over
 * candidates is the policy. Keeping BOTH encoders here (and versioned by OBS_DIM/ACT_DIM)
 * guarantees the TypeScript forward pass and the Python trainer see identical features.
 *
 * Design rules:
 *   - Pure & deterministic: no RNG, no clock, and only stable catalog lookups.
 *   - Everything roughly normalized into [0,1] / small ranges so the net trains stably.
 *   - Append-only: add new features at the END and bump OBS_DIM/ACT_DIM, never reorder
 *     (old exported weights would silently misalign otherwise).
 */

import {
	GAME_PHASES,
	SEAT_COLORS,
	VP_TO_WIN,
	ALL_DESTINATIONS,
	isEvilAlignment,
	type GameCommand,
	type PlayCatalog,
	type PrivatePlayerState,
	type PublicGameState,
	type SeatColor
} from '../types';
import { awakenedClassCounts } from '../effects/apply';
import { buildMonsterRewards } from '../monsterRewards';

/** Rough horizon used to normalize the round counter. */
const ROUND_NORM = 36;
/** Generic divisor for "pool" counts (dice, mats, barrier) → keeps features ~[0,1]. */
const POOL_NORM = 10;
const BARRIER_NORM = 20;

function clamp01(x: number): number {
	return x < 0 ? 0 : x > 1 ? 1 : x;
}

function diceCountByTier(p: PrivatePlayerState): Record<string, number> {
	const out: Record<string, number> = { basic: 0, enchanted: 0, exalted: 0, arcane: 0 };
	for (const d of p.attackDice ?? []) out[d.tier] = (out[d.tier] ?? 0) + 1;
	return out;
}

function faceDownCount(p: PrivatePlayerState): number {
	return (p.spirits ?? []).filter((s) => s.isFaceDown).length;
}

function pendingRewardVpPotential(p: PrivatePlayerState | undefined): number {
	const pending = p?.pendingReward;
	if (!pending) return 0;
	return buildMonsterRewards(pending.rewardTrack)
		.map((opt) => (opt.effect.type === 'vp' ? opt.effect.amount : 0))
		.sort((a, b) => b - a)
		.slice(0, pending.chooseAmount)
		.reduce((sum, vp) => sum + vp, 0);
}

function classFeature(classes: Record<string, number> | undefined, name: string, norm = 3): number {
	return clamp01((classes?.[name] ?? 0) / norm);
}

function catalogSpiritClasses(catalog: PlayCatalog | undefined, spiritId: string | null | undefined): Record<string, number> | undefined {
	if (!catalog || !spiritId) return undefined;
	return catalog.spirits.find((spirit) => spirit.id === spiritId)?.classes;
}

/** 1 = leading, 0 = last. Placement of `seat` among active seats by VP (ties → better). */
function placementFraction(state: PublicGameState, seat: SeatColor): number {
	const me = state.players[seat]?.victoryPoints ?? 0;
	const others = state.activeSeats.filter((s) => s !== seat);
	if (others.length === 0) return 1;
	const ahead = others.filter((s) => (state.players[s]?.victoryPoints ?? 0) > me).length;
	return 1 - ahead / others.length;
}

/**
 * State features from `seat`'s point of view: global tempo, my resources, the field
 * (best opponent), and relative standing. ORDER IS PART OF THE CONTRACT — see header.
 */
export function encodeObs(state: PublicGameState, seat: SeatColor): number[] {
	const f: number[] = [];
	const me = state.players[seat];

	// ── Global / tempo ───────────────────────────────────────────────
	f.push(clamp01(state.round / ROUND_NORM));
	for (const ph of GAME_PHASES) f.push(state.phase === ph ? 1 : 0); // 6 phase one-hot
	f.push(clamp01(state.activeSeats.length / SEAT_COLORS.length));
	f.push(state.revealedDestinations ? 1 : 0);

	// Monster (Arcane Abyss) presence + threat.
	const mon = state.monster;
	f.push(mon ? 1 : 0);
	f.push(mon ? clamp01(mon.hp / Math.max(1, mon.maxHp)) : 0);
	f.push(mon ? clamp01(mon.livesRemaining / Math.max(1, mon.livesTotal)) : 0);
	f.push(mon ? clamp01(mon.ladderIndex / Math.max(1, mon.ladderMax)) : 0);
	f.push(mon ? clamp01(mon.damage / BARRIER_NORM) : 0);

	// ── Me ───────────────────────────────────────────────────────────
	if (me) {
		f.push(clamp01(me.victoryPoints / VP_TO_WIN));
		f.push(clamp01((VP_TO_WIN - me.victoryPoints) / VP_TO_WIN)); // distance to win
		f.push(clamp01(me.barrier / BARRIER_NORM));
		f.push(clamp01(me.maxBarrier / BARRIER_NORM));
		f.push(clamp01(me.brokenBarrier / BARRIER_NORM));
		f.push(clamp01(me.statusLevel / 3));
		f.push(clamp01((me.corruptionCount ?? 0) / 5));
		f.push(isEvilAlignment(me.statusLevel) ? 1 : 0);
		const dice = diceCountByTier(me);
		f.push(clamp01((me.attackDice?.length ?? 0) / POOL_NORM));
		f.push(clamp01(dice.basic / POOL_NORM));
		f.push(clamp01(dice.enchanted / POOL_NORM));
		f.push(clamp01(dice.exalted / POOL_NORM));
		f.push(clamp01(dice.arcane / POOL_NORM));
		f.push(clamp01((me.spirits?.length ?? 0) / 7));
		f.push(clamp01(faceDownCount(me) / 7));
		f.push(clamp01((me.mats?.length ?? 0) / POOL_NORM));
		f.push(clamp01((me.relics ?? 0) / POOL_NORM));
		f.push(clamp01((me.spiritAugments ?? 0) / POOL_NORM));
		f.push(clamp01((me.unplacedAugments?.length ?? 0) / POOL_NORM));
		f.push(me.pendingDraw ? 1 : 0);
		f.push(me.pendingDraw ? clamp01((me.pendingDraw.summonLimit - me.pendingDraw.summonedCount) / 5) : 0);
		f.push((me.handDraws?.length ?? 0) > 0 ? 1 : 0);
		f.push(me.pendingReward ? 1 : 0);
		f.push((me.pendingCorruptionDiscard?.count ?? 0) > 0 ? 1 : 0);
		f.push(clamp01((me.awakenOffers?.length ?? 0) / 7));
		f.push(me.phaseReady ? 1 : 0);
	} else {
		for (let i = 0; i < 26; i++) f.push(0); // must match the `me` block length above
	}

	// ── Field (best opponent) + relative standing ────────────────────
	const opps = state.activeSeats.filter((s) => s !== seat).map((s) => state.players[s]).filter(Boolean) as PrivatePlayerState[];
	const myVp = me?.victoryPoints ?? 0;
	let maxOppVp = 0;
	let sumOppVp = 0;
	let maxOppDice = 0;
	let maxOppBarrier = 0;
	let fallenOpps = 0;
	for (const o of opps) {
		maxOppVp = Math.max(maxOppVp, o.victoryPoints);
		sumOppVp += o.victoryPoints;
		maxOppDice = Math.max(maxOppDice, o.attackDice?.length ?? 0);
		maxOppBarrier = Math.max(maxOppBarrier, o.maxBarrier);
		if (isEvilAlignment(o.statusLevel)) fallenOpps += 1;
	}
	const meanOppVp = opps.length ? sumOppVp / opps.length : 0;
	f.push(clamp01(maxOppVp / VP_TO_WIN));
	f.push(clamp01(meanOppVp / VP_TO_WIN));
	f.push(clamp01(maxOppDice / POOL_NORM));
	f.push(clamp01(maxOppBarrier / BARRIER_NORM));
	f.push(clamp01(fallenOpps / SEAT_COLORS.length));
	f.push(placementFraction(state, seat));
	f.push(clamp01(0.5 + (myVp - maxOppVp) / (2 * VP_TO_WIN))); // VP lead over best, centered at 0.5

	// Co-location: how many opponents share my revealed destination (PvP exposure).
	let coLocated = 0;
	if (state.revealedDestinations && me) {
		const myDest = me.navigationDestination;
		for (const o of opps) if (myDest && o.navigationDestination === myDest) coLocated += 1;
	}
	f.push(clamp01(coLocated / SEAT_COLORS.length));

	// ── Spirit-class composition (KEY: lets the net see it's near a Cultivator maxBarrier
	// breakpoint, or holds a VP win-con class) — the signal the candidate scorer needs to learn
	// the non-corrupt economy/class-win lines. Append-only.
	const cc = me ? awakenedClassCounts(me) : {};
	f.push(clamp01((cc['Cultivator'] ?? 0) / 5)); // 2/3/4/5 = maxBarrier breakpoints
	f.push(clamp01((cc['World Ender'] ?? 0) / 3)); // +1 VP / round
	f.push(clamp01((cc['Golden Ruler'] ?? 0) / 3)); // +1 VP / round
	f.push(clamp01((cc['World Guardian'] ?? 0) / 3)); // +6 VP capstone
	f.push(clamp01((cc['Healer'] ?? 0) / 3)); // +1 VP on rest
	f.push(clamp01((cc['Sharpshooter'] ?? 0) / 3)); // PvP enabler
	f.push(clamp01((cc['Cursed Spirit'] ?? 0) / 3)); // corruption enabler
	f.push(clamp01((cc['Spirit Animal'] ?? 0) / 7)); // flat monster-damage route
	f.push(clamp01((cc['Elementalist'] ?? 0) / 3)); // dice quality / damage scaling
	f.push(clamp01((cc['Arc Mage'] ?? 0) / 3)); // arcane dice conversion
	f.push(clamp01((cc['Fighter'] ?? 0) / 3)); // direct combat scaling
	f.push(clamp01((cc['Adaptive Fighter'] ?? 0) / 3)); // flexible combat scaling
	f.push(clamp01((cc['Dragon Warrior'] ?? 0) / 3)); // combat scaling
	f.push(clamp01((cc['Fairy'] ?? 0) / 3)); // combat/support scaling

	return f;
}

/** Number of features encodeObs emits. Asserted in tests; also written to meta.json. */
export const OBS_DIM = 62;

// Command-type vocabulary for the action one-hot. Append-only; index is the contract.
export const COMMAND_VOCAB: GameCommand['type'][] = [
	'lockNavigation',
	'selectNavigationDestination',
	'resolveLocationInteraction',
	'endLocationActions',
	'spawnHandSpirit',
	'discardHandDraws',
	'redrawHandDraws',
	'startCombat',
	'resolveMonsterReward',
	'initiatePvp',
	'passEncounter',
	'takeSpirit',
	'replaceSpirit',
	'absorbSpirit',
	'refillMarket',
	'awakenSpirit',
	'manualAwaken',
	'resolveDecision',
	'placeAugmentOnSpirit',
	'resolveAwakenReward',
	'discardSpirit',
	'discardRune',
	'commitBenefits',
	'commitAwakening',
	'commitCleanup',
	'commitRound',
	'flipSpirit',
	'forceAdvancePhase'
];
const VOCAB_INDEX: Partial<Record<GameCommand['type'], number>> = {};
COMMAND_VOCAB.forEach((t, i) => (VOCAB_INDEX[t] = i));

/** Number of generic numeric slots appended after the command one-hot. */
const ACTION_PARAM_SLOTS = 12;

/**
 * Action features for one candidate command: a command-type one-hot followed by
 * ACTION_PARAM_SLOTS generic numeric slots whose meaning is per-command (the net
 * learns to read them in the context of the one-hot). ORDER IS PART OF THE CONTRACT.
 */
export function encodeAction(
	state: PublicGameState,
	seat: SeatColor,
	cmd: GameCommand,
	next?: PublicGameState,
	catalog?: PlayCatalog
): number[] {
	const f: number[] = new Array(COMMAND_VOCAB.length + ACTION_PARAM_SLOTS).fill(0);
	const idx = VOCAB_INDEX[cmd.type];
	if (idx !== undefined) f[idx] = 1;
	const p = COMMAND_VOCAB.length; // base offset of the param slots
	const me = state.players[seat];

	switch (cmd.type) {
		case 'lockNavigation': {
			// Destination one-hot across the 5 destinations (slots p..p+4) + threat/colocation.
			const di = ALL_DESTINATIONS.indexOf(cmd.destination as (typeof ALL_DESTINATIONS)[number]);
			if (di >= 0 && di < 5) f[p + di] = 1;
			const isAbyss = cmd.destination === 'Arcane Abyss';
			f[p + 5] = isAbyss ? 1 : 0;
			f[p + 6] = isAbyss && state.monster ? clamp01(state.monster.damage / BARRIER_NORM) : 0;
			// How crowded the destination already is (other seats whose secret choice we can't
			// see pre-reveal → 0; post-reveal occupancy if available).
			const occ = state.locationOccupancy?.[cmd.destination as (typeof ALL_DESTINATIONS)[number]] ?? [];
			f[p + 7] = clamp01(occ.length / SEAT_COLORS.length);
			break;
		}
		case 'resolveLocationInteraction': {
			f[p] = clamp01(cmd.rowIndex / 8);
			f[p + 1] = cmd.choices && cmd.choices.length ? clamp01((cmd.choices[0] ?? 0) / 3) : 0;
			break;
		}
		case 'spawnHandSpirit': {
			// Featurize the drawn spirit being summoned (cost / face-down nature).
			const draw = me?.handDraws?.find((h) => h.guid === cmd.guid);
			if (draw) {
				f[p] = clamp01((draw.cost ?? 0) / 8);
				f[p + 1] = 1; // marker: a known draw
			}
			break;
		}
		case 'takeSpirit':
		case 'replaceSpirit': {
			const mi = (cmd as { marketIndex: number }).marketIndex;
			const slot = state.market?.[mi];
			f[p] = clamp01(mi / 8);
			f[p + 1] = slot?.spiritId ? 1 : 0;
			const classes = catalogSpiritClasses(catalog, slot?.spiritId);
			const spirit = catalog?.spirits.find((entry) => entry.id === slot?.spiritId);
			f[p + 2] = spirit ? clamp01((spirit.cost ?? 0) / 8) : 0;
			f[p + 3] = classFeature(classes, 'Spirit Animal'); // flat monster damage
			f[p + 4] = classFeature(classes, 'Elementalist'); // dice-quality scaling
			f[p + 5] = classFeature(classes, 'Arc Mage'); // dice conversion to arcane
			f[p + 6] = clamp01(((classes?.Fighter ?? 0) + (classes?.['Adaptive Fighter'] ?? 0)) / 3);
			f[p + 7] = clamp01(((classes?.['Dragon Warrior'] ?? 0) + (classes?.Fairy ?? 0)) / 3);
			f[p + 8] = classFeature(classes, 'Sharpshooter'); // die on summon + simultaneous attack
			f[p + 9] = classFeature(classes, 'Cultivator', 5); // max-barrier route support
			break;
		}
		case 'awakenSpirit':
		case 'flipSpirit':
		case 'discardSpirit': {
			const si = (cmd as { slotIndex: number }).slotIndex;
			f[p] = clamp01(si / 7);
			const sp = me?.spirits?.[si];
			f[p + 1] = sp?.isFaceDown ? 1 : 0;
			f[p + 2] = sp ? clamp01((sp.cost ?? 0) / 8) : 0;
			break;
		}
		case 'resolveMonsterReward': {
			f[p] = clamp01((cmd.picks?.length ?? 0) / 4);
			const picks = cmd.picks ?? [];
			f[p + 1] = clamp01((picks[0] ?? 0) / 8);
			f[p + 2] = clamp01((picks[1] ?? 0) / 8);
			f[p + 3] = clamp01((picks[2] ?? 0) / 8);
			const choices = cmd.choices ?? [];
			f[p + 4] = clamp01((choices[0] ?? 0) / 6);
			f[p + 5] = clamp01((choices[1] ?? 0) / 6);
			f[p + 6] = clamp01((choices[2] ?? 0) / 6);
			break;
		}
		case 'initiatePvp': {
			f[p] = me ? clamp01((me.attackDice?.length ?? 0) / POOL_NORM) : 0;
			break;
		}
		default:
			break;
	}

	// ── Effect deltas (EFFECT-AWARE) ─────────────────────────────────────
	// When the candidate's resulting state is supplied, append what this action CHANGES for `seat`.
	// Critical: lets the candidate scorer distinguish a maxBarrier-granting (economy) action from
	// a corruption / no-op one — they otherwise look identical (same command type + row index).
	// Append-only; counted in ACTION_EFFECT_SLOTS.
	const a = state.players[seat];
	const b = next?.players[seat];
	if (next && a && b) {
		const faceUp = (p: PrivatePlayerState) => (p.spirits ?? []).filter((s) => !s.isFaceDown).length;
		const deltaMaxBarrier = b.maxBarrier - a.maxBarrier;
		const deltaVp = b.victoryPoints - a.victoryPoints;
		const deltaDice = (b.attackDice?.length ?? 0) - (a.attackDice?.length ?? 0);
		const deltaBarrier = b.barrier - a.barrier;
		const deltaStatus = b.statusLevel - a.statusLevel;
		const deltaFaceUp = faceUp(b) - faceUp(a);
		const pendingVpBefore = pendingRewardVpPotential(a);
		const pendingVpAfter = pendingRewardVpPotential(b);
		const deltaPendingRewardVp = Math.max(0, pendingVpAfter - pendingVpBefore);
		const createdMonsterReward = !a.pendingReward && !!b.pendingReward;
		const advancedPhaseOrReady =
			next.phase !== state.phase ||
			next.round !== state.round ||
			(!a.phaseReady && b.phaseReady);
		const monsterProgress = state.monster
			? Math.max(
					0,
					(state.monster.livesRemaining - (next.monster?.livesRemaining ?? 0)) +
						((next.monster?.ladderIndex ?? state.monster.ladderIndex) - state.monster.ladderIndex)
				)
			: 0;
		const noProgressTableChurn =
			cmd.type === 'refillMarket' &&
			!advancedPhaseOrReady &&
			!createdMonsterReward &&
			deltaMaxBarrier === 0 &&
			deltaVp === 0 &&
			deltaDice === 0 &&
			deltaBarrier === 0 &&
			deltaStatus === 0 &&
			deltaFaceUp === 0 &&
			pendingVpAfter === pendingVpBefore;

		f.push(clamp01(deltaMaxBarrier / 5)); // ΔmaxBarrier — the economy engine
		f.push(clamp01(deltaVp / 5)); // ΔVP — immediate score
		f.push(clamp01(deltaDice / 5)); // Δdice
		f.push(clamp01(deltaBarrier / 10)); // Δbarrier — heal/restore
		f.push(clamp01(deltaStatus / 3)); // Δstatus — corruption step
		f.push(clamp01(deltaFaceUp / 5)); // Δawakened spirits
		f.push(next.winnerSeat === seat ? 1 : 0); // does this action WIN the game?
		f.push(clamp01(deltaPendingRewardVp / 10)); // Δclaimable monster-reward VP — delayed scoring
		f.push(createdMonsterReward ? 1 : 0); // killing combat created a reward choice
		f.push(advancedPhaseOrReady ? 1 : 0); // yield/phase progress marker
		f.push(clamp01(monsterProgress / 4)); // shared monster ladder/lives progress
		f.push(noProgressTableChurn ? 1 : 0); // legal but strategically empty table churn
	} else {
		for (let i = 0; i < ACTION_EFFECT_SLOTS; i++) f.push(0);
	}

	return f;
}

/** Number of effect-delta slots appended by encodeAction when a next-state is provided. */
const ACTION_EFFECT_SLOTS = 12;

/** Number of features encodeAction emits. */
export const ACT_DIM = COMMAND_VOCAB.length + ACTION_PARAM_SLOTS + ACTION_EFFECT_SLOTS;

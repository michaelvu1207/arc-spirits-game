/**
 * Applies class-effect triggers to game state (pure; mutates the passed state).
 *
 * Reads trait counts from the acting player's awakened spirits, builds a typed
 * {@link EffectContext}, and runs the encoded {@link EffectAction}s from the
 * registry through {@link runAction}. The context is the single object every
 * handler reads/writes, so later phases widen capability by populating more
 * context fields rather than re-threading function arguments.
 */

import type { PlayCatalog, PrivatePlayerState, PublicGameState, SeatColor } from '../types';
import { CLASS_ABILITIES } from './abilities';
import { CLASS_EFFECTS, selectBreakpoint, type EffectTrigger } from './registry';
import { buildEffectContext, type EffectCombatInfo, type TradePayload } from './context';
import { colocatedPlayers } from './colocated';
import { runAction } from './actions';
import { runClassHandler } from './handlers';
import { recordCultivateAwakenProgress } from './awakenHandlers';
import { augmentContributions } from '../augments';
import { originRuneForName } from '../locationInteractions';

/** Class trait counts from AWAKENED spirits only (unawakened classes are inactive).
 *  Placed spirit augments also contribute their class — but only while their host
 *  spirit is awakened (they follow the spirit); see {@link augmentContributions}. */
export function awakenedClassCounts(player: PrivatePlayerState): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const spirit of player.spirits) {
		if (spirit.isFaceDown) continue;
		for (const [cls, n] of Object.entries(spirit.classes ?? {})) {
			counts[cls] = (counts[cls] ?? 0) + (typeof n === 'number' ? n : 1);
		}
	}
	for (const { className, awake } of augmentContributions(player)) {
		if (awake) counts[className] = (counts[className] ?? 0) + 1;
	}
	return counts;
}

/** Unique spirit names per origin (awakened or not — origin is always active). */
export function uniqueSpiritsByOrigin(player: PrivatePlayerState): Record<string, Set<string>> {
	const byOrigin: Record<string, Set<string>> = {};
	for (const spirit of player.spirits) {
		for (const origin of Object.keys(spirit.origins ?? {})) {
			(byOrigin[origin] ??= new Set()).add(spirit.name);
		}
	}
	return byOrigin;
}

/** Optional trigger context — catalog/combat/interaction info threaded by callers. */
export interface TriggerOptions {
	catalog?: PlayCatalog;
	command?: unknown;
	opponent?: SeatColor;
	oldStatus?: number;
	newStatus?: number;
	combat?: EffectCombatInfo;
	trade?: TradePayload;
	/**
	 * Override the class counts the trigger fires against. Default is the player's whole
	 * awakened tableau. `onSpiritSummon` passes the JUST-SUMMONED spirit's own classes so
	 * its grant (Sharpshooter +Enchanted, Healer restore) fires once for THAT spirit —
	 * not on every summon while the class is merely in play.
	 */
	counts?: Record<string, number>;
}

/**
 * Fire a trigger for a seat, applying every matching class effect through a
 * fully-built {@link EffectContext}. Optional `opts` thread catalog/combat/
 * interaction info for the handlers that need them; absent fields default to
 * undefined / an empty catalog, so existing call sites stay behavior-identical.
 */
export function applyTrigger(
	state: PublicGameState,
	seat: SeatColor,
	trigger: EffectTrigger,
	log: string[],
	opts: TriggerOptions = {}
): void {
	const player = state.players[seat];
	if (!player) return;
	// Default: fire against the player's whole awakened tableau. A caller may scope the
	// trigger to a specific class-count set (e.g. onSpiritSummon → the summoned spirit's
	// own classes) so the effect resolves once for that spirit, not the whole board.
	const counts = opts.counts ?? awakenedClassCounts(player);
	const colocated = colocatedPlayers(state, seat);

	// Every awakened class with at least one ability — declarative or bespoke — for
	// this trigger. The canonical source is CLASS_ABILITIES; CLASS_EFFECTS is also
	// unioned in so the test harnesses' synthetic `CLASS_EFFECTS[name] = …`
	// injections (declarative-only classes not in CLASS_ABILITIES) still fire.
	// Iterating a stable, deduped key set keeps order deterministic.
	const candidateClasses = new Set<string>([
		...Object.keys(CLASS_ABILITIES),
		...Object.keys(CLASS_EFFECTS)
	]);

	const makeCtx = (count: number) =>
		buildEffectContext({
			state,
			seat,
			player,
			trigger,
			log,
			traitCount: count,
			colocated,
			catalog: opts.catalog,
			command: opts.command,
			opponent: opts.opponent,
			oldStatus: opts.oldStatus,
			newStatus: opts.newStatus,
			combat: opts.combat,
			trade: opts.trade
		});

	for (const cls of candidateClasses) {
		const count = counts[cls] ?? 0;
		if (count <= 0) continue;

		// Attribute every log line a class produces to its source trait, so the combat /
		// reward / awakening log says WHAT granted each effect (e.g. "Spirit Animal:
		// Gained +1 combat damage."). Lines a handler already self-attributes (they start
		// with the class name) are left untouched to avoid a doubled prefix.
		const attributeFrom = (start: number) => {
			for (let i = start; i < log.length; i += 1) {
				if (!log[i].startsWith(cls)) log[i] = `${cls}: ${log[i]}`;
			}
		};

		// 1. Declarative breakpoints first. Read from the live CLASS_EFFECTS view (the
		// derived projection of CLASS_ABILITIES' `breakpoints` entries) so synthetic
		// test injections are honored.
		for (const effect of CLASS_EFFECTS[cls] ?? []) {
			if (effect.trigger !== trigger) continue;
			const selected = selectBreakpoint(effect.breakpoints, count);
			if (!selected) continue;
			const ctx = makeCtx(count);
			const before = log.length;
			for (const action of selected.bp.actions) runAction(ctx, action, selected.multiplier);
			attributeFrom(before);
		}

		// 2. Bespoke `run` abilities (if any) for this class + trigger.
		for (const ability of CLASS_ABILITIES[cls] ?? []) {
			if (ability.on !== trigger || !ability.run) continue;
			const before = log.length;
			runClassHandler(makeCtx(count), cls, trigger);
			attributeFrom(before);
		}
	}
}

/**
 * Rest intrinsically restores two current barrier, then fires every `onRest`
 * class ability. The location row
 * therefore needs only the Rest action icon; restoration is part of the action,
 * not a separate reward-icon gain.
 */
export function applyRest(
	state: PublicGameState,
	seat: SeatColor,
	log: string[],
	opts: TriggerOptions = {}
): void {
	const player = state.players[seat];
	if (!player) return;

	const before = player.barrier;
	player.barrier = Math.min(player.maxBarrier, player.barrier + 2);
	player.brokenBarrier = Math.max(0, player.maxBarrier - player.barrier);
	const restored = player.barrier - before;
	if (restored > 0) log.push(`Restored ${restored} barrier.`);

	applyTrigger(state, seat, 'onRest', log, opts);
	log.push('Rested.');
}

/**
 * Cultivate grants one origin rune for every pair of same-origin spirit traits.
 * Its class payoff remains separate: the Cultivator
 * trigger grants max barrier on the 2/3/4/5 → +1/+2/+5/+10 ladder, while Arc
 * Mage, Captain, and other classes hook into the same `onCultivate` event.
 *
 * Repeated Cultivate tokens collapse to a SINGLE call (like Rest fires `onRest`
 * once), so there is no per-token multiplier. We still record the cultivate moment
 * for the text-awaken spirits that gate on it, then dispatch the class trigger.
 */
export function applyCultivate(
	state: PublicGameState,
	seat: SeatColor,
	log: string[],
	opts: TriggerOptions = {}
): void {
	const player = state.players[seat];
	if (!player) return;

	// Record cultivate-time progress for Contessa, Arcane Huntress and the three
	// unique-origin Fairies before resolving the intrinsic yield.
	const allPlayers = (state.activeSeats ?? [])
		.map((s) => state.players[s])
		.filter((p): p is NonNullable<typeof p> => !!p);
	recordCultivateAwakenProgress(player, allPlayers);

	// Intrinsic Cultivate yield (every player, no class required): gain ONE origin rune
	// for every TWO spirit origin traits sharing that origin.
	// Awakened and face-down spirits both count (origin is always active; only class
	// abilities need awakening). Only the four core origins with a basic rune (Mountain
	// Region / Forest Region / Fire Region / Water Region) produce pairs. Rune Traveler's
	// per-turn `doubleRunes` doubles the rune yield.
	const originTraits: Record<string, number> = {};
	for (const spirit of player.spirits) {
		for (const [origin, n] of Object.entries(spirit.origins ?? {})) {
			originTraits[origin] = (originTraits[origin] ?? 0) + (typeof n === 'number' ? n : 1);
		}
	}
	const runeMult = player.doubleRunes ? 2 : 1;
	for (const [origin, traits] of Object.entries(originTraits)) {
		const rune = originRuneForName(origin);
		if (!rune) continue;
		const pairs = Math.floor(traits / 2);
		const count = pairs * runeMult;
		for (let i = 0; i < count; i += 1) {
			player.mats.push({
				slotIndex: player.mats.length + 1,
				hasRune: true,
				id: rune.runeId,
				name: rune.name,
				type: rune.type,
				originId: rune.originId ?? undefined,
				classId: rune.classId ?? undefined,
				special: rune.special
			});
		}
		if (count > 0) log.push(`Cultivated ${count} ${rune.name}${count === 1 ? '' : 's'}.`);
	}
	// Class-hook dispatch: fire onCultivate class effects for the acting seat.
	applyTrigger(state, seat, 'onCultivate', log, opts);
}

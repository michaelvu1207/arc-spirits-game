/**
 * Action handlers: the executable half of the declarative effect registry.
 *
 * `runAction` dispatches one {@link EffectAction} against an {@link EffectContext},
 * mutating `ctx.player`/`ctx.state` in place. The `multiplier` carries the `'1+'`
 * per-trait scaling from `selectBreakpoint`: numeric amounts are multiplied by it
 * (a numeric breakpoint always passes `multiplier = 1`, so the original
 * Fighter/Elementalist ladders are unchanged).
 */

import { DICE_TIER_ORDER, isEvilAlignment, MAX_ATTACK_DICE } from '../types';
import type { DiceTier, PendingAugment, PrivatePlayerState, PublicGameState } from '../types';
import { nextId } from '../rng';
import type { EffectAction, EffectCondition } from './registry';
import type { EffectContext } from './context';

/** The attack-dice pool is capped at a flat 10 for every player (no longer tied to max barrier). */
function diceCap(): number {
	return MAX_ATTACK_DICE;
}



/**
 * Synthetic rune id for a generic, classless Spirit Augment gained via `gainAugment`
 * (Captain, Herder, Strategist, Cursed-Spirit Fallen). It has no catalog icon,
 * so the placement UI shows the name-letter fallback; placement binds it with no
 * className, so it adds capacity-occupying weight but no class trait.
 */
export const GENERIC_AUGMENT_RUNE_ID = 'generic-spirit-augment';

/**
 * The ONE path for gaining Spirit Augments (class abilities, location and Falconer trades,
 * monster/claim rewards, relic tools, navigation Powers): the augments go to the to-place pouch.
 *
 * Smith — "When you gain a Spirit Augment, you may gain 1 more of your choice. The extra augment
 * does not cause this ability again." With an awakened Smith, each augment gained here adds 1
 * generic augment (the owner picks its type at placement, or discards it: "you may"). The extras
 * are pushed directly, so they never call this again. Returns the number of Smith extras.
 */
export function gainSpiritAugments(
	player: PrivatePlayerState,
	augments: PendingAugment[],
	log?: string[]
): number {
	if (augments.length === 0) return 0;
	player.unplacedAugments ??= [];
	player.unplacedAugments.push(...augments);
	if (!hasAwakenedClass(player, 'Smith')) return 0;
	for (let i = 0; i < augments.length; i += 1) {
		player.unplacedAugments.push({ runeId: GENERIC_AUGMENT_RUNE_ID, name: 'Spirit Augment' });
	}
	log?.push(
		augments.length === 1
			? 'Smith: gained 1 more Spirit Augment of your choice (you may discard it).'
			: `Smith: gained ${augments.length} more Spirit Augments of your choice (you may discard them).`
	);
	return augments.length;
}

function upgradeDice(
	player: PrivatePlayerState,
	times: number,
	log: string[],
	from?: DiceTier,
	to?: DiceTier
): void {
	let upgraded = 0;

	// Tier-targeted conversion (e.g. Sorcerer: exalted → arcane). Convert up
	// to `times` dice that sit at exactly the `from` tier into the `to` tier.
	if (from && to) {
		for (let t = 0; t < times; t += 1) {
			const target = player.attackDice.find((d) => d.tier === from);
			if (!target) break;
			target.tier = to;
			upgraded += 1;
		}
		if (upgraded > 0) log.push(`Upgraded ${upgraded} ${from} attack dice to ${to}.`);
		return;
	}

	// Default ladder (Elementalist): step the lowest basic/enchanted die up one tier.
	// This caps at EXALTED — arcane attack dice can only be obtained through specific
	// methods (the targeted `from`/`to` conversions above, e.g. Sorcerer), never
	// the generic upgrade ladder. So only basic/enchanted dice are ever targeted.
	for (let t = 0; t < times; t += 1) {
		let target: (typeof player.attackDice)[number] | undefined;
		for (const tier of DICE_TIER_ORDER) {
			if (tier === 'exalted') break;
			const die = player.attackDice.find((d) => d.tier === tier);
			if (die) {
				target = die;
				break;
			}
		}
		if (!target) break;
		const idx = DICE_TIER_ORDER.indexOf(target.tier);
		target.tier = DICE_TIER_ORDER[idx + 1];
		upgraded += 1;
	}
	if (upgraded > 0) log.push(`Upgraded ${upgraded} attack dice to a higher tier.`);
}

/** Restore one player's barrier (capped at max barrier); keeps broken barrier consistent. */
function restoreOne(
	player: PrivatePlayerState,
	amount: number,
	log: string[],
	who?: string
): void {
	const before = player.barrier;
	player.barrier = Math.min(player.maxBarrier, player.barrier + amount);
	player.brokenBarrier = Math.max(0, player.maxBarrier - player.barrier);
	const restored = player.barrier - before;
	if (restored > 0) {
		log.push(who ? `${who} restored ${restored} barrier.` : `Restored ${restored} barrier.`);
	}
}

/** Evaluate a declarative {@link EffectCondition} against the context. */
function evalCondition(ctx: EffectContext, cond: EffectCondition): boolean {
	switch (cond.kind) {
		case 'isEvil':
			return isEvilAlignment(ctx.player.statusLevel);
		case 'isGood':
			return !isEvilAlignment(ctx.player.statusLevel);
		case 'killed':
			return ctx.combat?.killed === true;
		case 'notKilled':
			return ctx.combat?.killed !== true;
		case 'overkillAtLeast':
			return (ctx.combat?.overkill ?? 0) >= cond.amount;
		case 'statusAtLeast':
			return ctx.player.statusLevel >= cond.level;
		case 'hasColocated':
			return ctx.colocated.length > 0;
		case 'hasAttackDice':
			return ctx.player.attackDice.length >= cond.amount;
		case 'becameTainted':
			return ctx.player.becameTaintedThisRound === true;
		case 'becameCorrupt':
			return ctx.player.becameCorruptThisRound === true;
		case 'becameFallen':
			return ctx.player.becameFallenThisRound === true;
		case 'corruptedThisRound':
			return ctx.player.corruptedThisRound === true;
		case 'vpAtLeast':
			return ctx.player.victoryPoints >= cond.amount;
	}
}

/** True when an awakened spirit, or a Spirit Augment on an awakened spirit, gives `cls`. */
export function hasAwakenedClass(player: PrivatePlayerState, cls: string): boolean {
	if (player.spirits.some((s) => !s.isFaceDown && (s.classes?.[cls] ?? 0) > 0)) return true;
	return (player.spiritAugmentAttachments ?? []).some(
		(att) =>
			att.className === cls &&
			player.spirits.some((s) => s.slotIndex === att.spiritSlotIndex && !s.isFaceDown)
	);
}

/**
 * Apply one effect action. `multiplier` scales numeric "amount" kinds (1 for the
 * classic numeric ladder; the trait count for a `'1+'` breakpoint).
 */
export function runAction(ctx: EffectContext, action: EffectAction, multiplier = 1): void {
	const { state, player, log } = ctx;
	const scaled = (n: number) => n * multiplier;
	switch (action.kind) {
		case 'gainAttackDice': {
			const cap = diceCap();
			const want = scaled(action.amount);
			let added = 0;
			for (let i = 0; i < want && player.attackDice.length < cap; i += 1) {
				player.attackDice.push({ instanceId: nextId(state.rng, 'die'), tier: action.tier });
				added += 1;
			}
			if (added > 0) {
				log.push(`Gained ${added} ${action.tier} attack dice.`);
				// Exalted dice gained so far in this gain (Druid gives one more for each).
				let exaltedGained = action.tier === 'exalted' ? added : 0;
				// Wildling: "When you gain an attack dice, gain 1 Exalted Attack Dice." One extra die
				// per gain, within the cap. It is pushed directly, so it does not trigger Wildling again.
				if (hasAwakenedClass(player, 'Wildling') && player.attackDice.length < cap) {
					player.attackDice.push({ instanceId: nextId(state.rng, 'die'), tier: 'exalted' });
					log.push('Wildling: gained 1 exalted attack dice.');
					exaltedGained += 1;
				}
				// Druid: "When you gain an Exalted Attack Dice, you may gain 1 more. The extra dice does
				// not cause this ability again." One more Exalted die for each Exalted die gained above
				// (the source's and Wildling's), within the cap, taken automatically. Druid dice are
				// pushed directly: they trigger neither Druid nor Wildling, so the two cannot loop.
				if (exaltedGained > 0 && hasAwakenedClass(player, 'Druid')) {
					let extra = 0;
					for (let i = 0; i < exaltedGained && player.attackDice.length < cap; i += 1) {
						player.attackDice.push({ instanceId: nextId(state.rng, 'die'), tier: 'exalted' });
						extra += 1;
					}
					if (extra > 0) log.push(`Druid: gained ${extra} more exalted attack dice.`);
				}
			}
			else log.push(`Attack-dice pool is already at the cap (${cap}).`);
			break;
		}
		case 'gainMaxBarrier': {
			const amount = scaled(action.amount);
			const oldMax = player.maxBarrier;
			player.maxBarrier = Math.min(10, player.maxBarrier + amount);
			const grew = player.maxBarrier - oldMax;
			// A new maximum barrier token arrives intact: increase both capacity and
			// current barrier, so 1/6 becomes 2/7 rather than 1/7.
			player.barrier = Math.min(player.maxBarrier, player.barrier + grew);
			player.brokenBarrier = Math.max(0, player.maxBarrier - player.barrier);
			log.push(`Gained ${grew} max barrier.`);
			break;
		}
		case 'upgradeDice': {
			// An upgrade is not a gain: it triggers neither Wildling nor Druid.
			upgradeDice(player, scaled(action.times), log, action.from, action.to);
			break;
		}
		case 'restoreBarrier': {
			const amount = scaled(action.amount);
			restoreOne(player, amount, log);
			if (action.includeColocated) {
				for (const ally of ctx.colocated) restoreOne(ally, amount, log, ally.playerColor);
			}
			break;
		}
		case 'gainRune': {
			// Rune Traveler's per-turn doubleRunes flag doubles any rune gained.
			const amount = scaled(action.amount) * (player.doubleRunes ? 2 : 1);
			for (let i = 0; i < amount; i += 1) {
				player.mats.push({
					slotIndex: player.mats.length + 1,
					hasRune: true,
					name: 'Rune',
					type: 'rune'
				});
			}
			log.push(`Gained ${amount} rune(s).`);
			break;
		}
		case 'gainVP': {
			const amount = scaled(action.amount);
			player.victoryPoints += amount;
			log.push(`Gained ${amount} VP.`);
			break;
		}
		case 'gainInitiative': {
			const amount = scaled(action.amount);
			player.initiative += amount;
			log.push(`Gained ${amount} initiative.`);
			break;
		}
		case 'reduceIncomingDamage': {
			const amount = scaled(action.amount);
			player.damageReduction += amount;
			log.push(`Reduced incoming damage by ${amount}.`);
			break;
		}
		case 'deflect': {
			const amount = scaled(action.amount);
			player.deflect += amount;
			log.push(`Will deflect ${amount} damage.`);
			break;
		}
		case 'combatBonus': {
			const amount = scaled(action.amount);
			player.combatDamageBonus += amount;
			log.push(`Gained +${amount} combat damage.`);
			break;
		}
		case 'combatBonusFromBrokenBarrier': {
			// Live-pool bonus: +1 damage per broken barrier, capped at `max` (Woundreaver).
			// Broken barrier is the corrupted side of the max barrier pool (maxBarrier − barrier).
			const brokenBarrier = player.maxBarrier - player.barrier;
			const amount = Math.min(brokenBarrier, action.max);
			if (amount > 0) {
				player.combatDamageBonus += amount;
				log.push(`Gained +${amount} combat damage from broken barrier.`);
			}
			break;
		}
		case 'gainAugment': {
			const amount = scaled(action.amount);
			// A gained Spirit Augment must be PLACEABLE — it goes into the to-place pouch
			// (unplacedAugments) so the AugmentPlacement drag-modal lets the owner attach it
			// to a spirit (counting toward capacity), exactly like reward/awaken augments.
			// These are generic (no classId): the owner picks the type at placement — matching
			// "gain any Spirit Augment". Smith's extra is added by gainSpiritAugments.
			if (amount <= 0) break;
			log.push(
				amount === 1
					? 'Gained a Spirit Augment — place it on a spirit.'
					: `Gained ${amount} Spirit Augments — place them on a spirit.`
			);
			gainSpiritAugments(
				player,
				Array.from({ length: amount }, () => ({ runeId: GENERIC_AUGMENT_RUNE_ID, name: 'Spirit Augment' })),
				log
			);
			break;
		}
		case 'gainRelic': {
			const amount = scaled(action.amount);
			// A relic is a usable, gold rune-slot item (wild type). Push it into the rune
			// slots so it actually shows and can be spent on trades/awakens — the `relics`
			// tally is kept for stats + awaken parity.
			for (let i = 0; i < amount; i += 1) {
				player.mats.push({
					slotIndex: player.mats.length + 1,
					hasRune: true,
					name: 'Relic',
					type: 'relic'
				});
			}
			player.relics += amount;
			log.push(`Gained ${amount} relic(s).`);
			break;
		}
		case 'restoreBrokenBarrier': {
			const brokenBarrier = player.maxBarrier - player.barrier;
			const amount =
				action.fraction === 'halfRoundUp'
					? Math.ceil(brokenBarrier / 2)
					: scaled(action.amount ?? 0);
			const before = player.barrier;
			player.barrier = Math.min(player.maxBarrier, player.barrier + amount);
			player.brokenBarrier = player.maxBarrier - player.barrier;
			const removed = player.barrier - before;
			if (removed > 0) log.push(`Restored ${removed} broken barrier.`);
			break;
		}
		case 'setStunImmune':
			if (!player.stunImmune) {
				player.stunImmune = true;
				log.push('You cannot be stunned.');
			}
			break;
		case 'discardAttackDice': {
			const want = scaled(action.amount);
			let discarded = 0;
			for (let i = 0; i < want && player.attackDice.length > 0; i += 1) {
				player.attackDice.pop();
				discarded += 1;
			}
			if (discarded > 0) log.push(`Discarded ${discarded} attack dice.`);
			break;
		}
		case 'discardAttackDiceByIds': {
			const remove = new Set(action.instanceIds);
			const before = player.attackDice.length;
			player.attackDice = player.attackDice.filter((d) => !remove.has(d.instanceId));
			const discarded = before - player.attackDice.length;
			if (discarded > 0) log.push(`Discarded ${discarded} attack dice.`);
			break;
		}
		case 'conditional': {
			const branch = evalCondition(ctx, action.when) ? action.then : action.else ?? [];
			for (const next of branch) runAction(ctx, next, multiplier);
			break;
		}
		case 'extraAction': {
			const amount = scaled(action.amount);
			player.extraActions[action.actionKey] = (player.extraActions[action.actionKey] ?? 0) + amount;
			log.push(`Gained ${amount} extra ${action.actionKey} action(s).`);
			break;
		}
		case 'setDoubleRunes': {
			if (!player.doubleRunes) {
				player.doubleRunes = true;
				log.push('Runes gained this turn are doubled.');
			}
			if (action.includeColocated) {
				for (const ally of ctx.colocated) {
					if (!ally.doubleRunes) {
						ally.doubleRunes = true;
						log.push(`${ally.playerColor}'s runes this turn are doubled.`);
					}
				}
			}
			break;
		}
		case 'manual':
			player.manualPrompts.push({ id: nextId(state.rng, 'mp'), source: 'class', text: action.prompt });
			break;
		case 'choose':
			player.pendingDecisions.push({
				id: nextId(state.rng, 'dec'),
				source: 'class',
				kind: action.decisionKind,
				prompt: action.prompt,
				options: action.options.map((o) => ({ id: o.id, label: o.label }))
			});
			log.push(`Decision: ${action.prompt}`);
			break;
	}
}

/** Re-export for callers wanting the bare state type. */
export type { PublicGameState };

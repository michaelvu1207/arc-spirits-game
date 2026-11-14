import { nextId } from '../../rng';
import type { RelicGuardMode } from '../../types';
import type { ClassAbility, ClassDecisions, ClassHandler } from './types';

// Relic Sentinel — "When you Take Damage, you may choose to take 0 damage if you discard a
// relic." (The old +6 VP Benefits claim is gone.)
//
// Combat resolves in one step (no pause between hits), so the owner makes the choice in
// advance: in each Awakening Phase where they hold a relic, a decision card sets the guard
// rule — 'lethal' (only a hit that would empty the barrier and corrupt), 'everyHit' (every hit
// while a relic is held) or 'never'. The rule persists between rounds; unset reads as 'lethal'.
// `takeDamage` (combat.ts) applies it.

export const RELIC_GUARD_MODES: { id: RelicGuardMode; label: string }[] = [
	{ id: 'lethal', label: 'Only when a hit would break my last Barrier (corrupt me)' },
	{ id: 'everyHit', label: 'On every hit, while I hold a relic' },
	{ id: 'never', label: 'Never — keep my relics' }
];

const holdsRelic = (player: Parameters<ClassHandler>[0]['player']) =>
	player.mats.some((slot) => slot.type === 'relic' && slot.hasRune);

const armRelicGuard: ClassHandler = (ctx) => {
	if ((ctx.player.relicGuardMode ?? 'lethal') === 'never') return;
	if (!holdsRelic(ctx.player)) return;
	ctx.player.relicGuard = true;
};

/** Offer the guard rule while a relic is held. The current rule is the first option. */
const offerGuardRule: ClassHandler = (ctx) => {
	const { player, state, log } = ctx;
	player.pendingDecisions = (player.pendingDecisions ?? []).filter(
		(d) => d.kind !== 'relicSentinelGuard'
	);
	if (!holdsRelic(player)) return;
	const current = player.relicGuardMode ?? 'lethal';
	const ordered = [
		...RELIC_GUARD_MODES.filter((m) => m.id === current),
		...RELIC_GUARD_MODES.filter((m) => m.id !== current)
	];
	player.pendingDecisions.push({
		id: nextId(state.rng, 'dec'),
		source: 'class',
		kind: 'relicSentinelGuard',
		prompt: 'Relic Sentinel: when do you discard a relic to take 0 damage from a hit?',
		options: ordered.map((m) => ({
			id: m.id,
			label: m.id === current ? `${m.label} (current)` : m.label
		}))
	});
	log.push('Decision: Relic Sentinel — set when to discard a relic for a hit.');
};

export const ability: ClassAbility[] = [
	{ on: 'onTakeDamage', run: armRelicGuard },
	{ on: 'awakeningPhase', run: offerGuardRule }
];

export const decisions: ClassDecisions = {
	relicSentinelGuard(ctx, optionId) {
		const mode = RELIC_GUARD_MODES.find((m) => m.id === optionId);
		if (!mode) return;
		ctx.player.relicGuardMode = mode.id;
		ctx.log.push(`Relic Sentinel: ${mode.label.toLowerCase()}.`);
	}
};

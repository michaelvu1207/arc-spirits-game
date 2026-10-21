/**
 * Handler-table escape hatch for irreducibly bespoke class effects.
 *
 * The declarative `CLASS_EFFECTS` registry covers most classes, but a handful
 * express logic that can't be reduced to data-only `EffectAction`s — they branch
 * on live state (barrier parity, opponent initiative), mutate the spirit list, or
 * defer a "may" choice to the player. Those closures are authored alongside their
 * declarative siblings in the canonical {@link CLASS_ABILITIES} source; this file
 * DERIVES the legacy `CLASS_HANDLERS` table (and `HANDLER_CLASSES`) from it so
 * every existing import keeps working unchanged.
 *
 * `applyTrigger` runs the declarative breakpoints FIRST, then any matching handler
 * here, so a class can use both paths (none currently do, but the order is fixed).
 * Each handler receives the same {@link EffectContext} the declarative path uses
 * and mutates `ctx.player` / `ctx.state` in place. Determinism: any randomness must
 * flow through `ctx.state.rng`; these handlers use none directly (the only "random"
 * piece — Fatestriker's optional reroll — is deferred to a manual prompt).
 */

import { CLASS_ABILITIES } from './abilities';
import type { EffectContext } from './context';
import type { EffectTrigger } from './registry';

// `ClassHandler` now lives in the leaf module `./classes/types` so the per-class
// files can import it without cycling through this file; re-exported for existing sites.
export type { ClassHandler } from './classes/types';
import type { ClassHandler } from './classes/types';

/**
 * Bespoke handlers keyed by class name → trigger, DERIVED from the canonical
 * {@link CLASS_ABILITIES} source: for each class, its `run` abilities indexed by
 * `on`. A class listed here is "handled" (never a silent no-op): it either
 * mutates state or emits a prompt.
 */
export const CLASS_HANDLERS: Record<string, Partial<Record<EffectTrigger, ClassHandler>>> =
	Object.fromEntries(
		Object.entries(CLASS_ABILITIES)
			.map(([cls, abilities]) => {
				const handlers: Partial<Record<EffectTrigger, ClassHandler>> = {};
				for (const a of abilities) {
					if (a.run) handlers[a.on] = a.run;
				}
				return [cls, handlers] as const;
			})
			.filter(([, handlers]) => Object.keys(handlers).length > 0)
	);

/** Classes routed through the handler table (kept in sync with {@link CLASS_HANDLERS}). */
export const HANDLER_CLASSES = new Set<string>(Object.keys(CLASS_HANDLERS));

/**
 * Run any bespoke handler matching `cls`/`trigger` against the context. Called by
 * `applyTrigger` after the declarative breakpoints resolve. No-op when the class
 * has no handler for this trigger.
 */
export function runClassHandler(ctx: EffectContext, cls: string, trigger: EffectTrigger): void {
	CLASS_HANDLERS[cls]?.[trigger]?.(ctx);
}

/**
 * Shared types for the per-class ability modules.
 *
 * Each class lives in its own file under `effects/classes/`, exporting an
 * `ability: ClassAbility[]`. `abilities.ts` imports them all and assembles the
 * canonical {@link ClassAbility} map; `registry.ts` (CLASS_EFFECTS) and
 * `handlers.ts` (CLASS_HANDLERS) derive their views from that map. These two
 * types live here — a leaf module — so the class files never import from
 * `abilities.ts`/`handlers.ts` (which would create an import cycle).
 */

import type { EffectContext } from '../context';
import type { EffectBreakpoint, EffectTrigger } from '../registry';

/** A single bespoke effect handler. Mutates the context in place. Determinism:
 *  any randomness must flow through `ctx.state.rng`. */
export type ClassHandler = (ctx: EffectContext) => void;

/**
 * One ability for a class: a declarative breakpoint ladder OR a bespoke handler,
 * hung off the {@link EffectTrigger} (`on`) it fires for. Exclusive union — an
 * ability carries `breakpoints` xor `run`, never both.
 */
export type ClassAbility = { on: EffectTrigger } & (
	| { breakpoints: EffectBreakpoint[]; run?: never }
	| { run: ClassHandler; breakpoints?: never }
);

/**
 * Per-class decision resolvers, keyed by `decisionKind`. A class file may export a
 * `decisions` object alongside its `ability`; `abilities.ts` collects them into
 * `CLASS_DECISIONS`, which `decisions.ts` exposes as the runtime `DECISION_RESOLVERS`
 * map. Colocating a resolver with its ability keeps each "may" choice in one file.
 */
export type ClassDecisions = Record<
	string,
	(ctx: EffectContext, optionId: string, selectedInstanceIds?: string[]) => void
>;

/** The shape each `classes/<name>.ts` module exports (decisions optional). */
export interface ClassModule {
	ability: ClassAbility[];
	decisions?: ClassDecisions;
}

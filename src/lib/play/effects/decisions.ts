/**
 * Runtime resolver map for player-decision cards (the `choose` effect action).
 *
 * Each `PendingDecision.kind` maps to a resolver. Resolvers now live COLOCATED with
 * their class in `./classes/<name>.ts` (exported as `decisions`); `abilities.ts`
 * merges them into {@link CLASS_DECISIONS}. This module simply exposes that merged
 * map as `DECISION_RESOLVERS`, the name the runtime's `resolveDecision` command
 * looks resolvers up by — so adding a "may" choice is a single-file change.
 */

import type { EffectContext } from './context';
import { CLASS_DECISIONS } from './abilities';

export const DECISION_RESOLVERS: Record<
	string,
	(ctx: EffectContext, optionId: string, selectedInstanceIds?: string[]) => void
> = {
	...CLASS_DECISIONS
};

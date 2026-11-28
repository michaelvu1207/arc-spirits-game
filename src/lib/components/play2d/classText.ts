/**
 * The class text a game screen prints: the card data (`classes.effect_schema`) with the text of
 * every rule in force applied (`ruleAdjustedClassSchema` in rules.ts, the same function the AI
 * players' rules brief uses). So a class reads on screen as it plays, also while the card data
 * still carries the text of an earlier rule.
 */
import type { ClassBreakpoint, ClassTrait } from '$lib/types';
import type { PlayRules } from '$lib/play/types';
import { ruleAdjustedClassSchema } from '$lib/play/rules';

export interface ClassTextInForce {
	schema: ClassBreakpoint[];
	/** A rule in force gives at least one breakpoint another text than the card data. The data's
	 *  one-line summary (`classes.description`) may then no longer be true. */
	changed: boolean;
}

export function classTextInForce(
	catalog: { rules: PlayRules | undefined } | null | undefined,
	cls: Pick<ClassTrait, 'name' | 'effect_schema'> | null | undefined
): ClassTextInForce {
	const data = (cls?.effect_schema ?? []) as ClassBreakpoint[];
	if (!cls) return { schema: data, changed: false };
	const schema = ruleAdjustedClassSchema(catalog, cls.name, data) ?? data;
	// `ruleAdjustedClassSchema` returns the same tier objects where it changes nothing.
	const changed = schema !== data && schema.some((tier, i) => tier !== data[i]);
	return { schema, changed };
}

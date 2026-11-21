/**
 * The rule switches of the game data in force (the live package on the web, the working data in
 * the local game), loaded once for the game screens that show a number the switches change (the
 * average damage of an attack under `buffedDice`). Until they load, and if they cannot be read,
 * the default rules apply.
 */
import { supabaseAssets } from '$lib/supabase';
import { parseRules } from '$lib/play/rules';
import type { PlayRules } from '$lib/play/types';

let rules = $state<PlayRules | undefined>(undefined);
let asked = false;

/** A catalog-like object for `ruleValue` and `expectedAttack`; reactive, it fills in once the rules load. */
export function clientRules(): { rules: PlayRules | undefined } {
	if (!asked && typeof window !== 'undefined') {
		asked = true;
		void (async () => {
			try {
				const { data } = await supabaseAssets.from('rules').select('*');
				rules = parseRules(data ?? []).rules;
			} catch {
				/* default rules */
			}
		})();
	}
	return { rules };
}

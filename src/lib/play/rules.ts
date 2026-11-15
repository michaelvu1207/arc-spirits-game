/**
 * Rule switches: rules.json (an object of named switches in the game-data folder) →
 * PlayCatalog.rules. They let a rule change be A/B tested from game data while old game
 * records still replay exactly:
 *
 *   { "feralMonsterStrikeFirst": false, "summonReplaceWhenFull": true, "cultivatorRelicOnce": true }
 *
 * Every switch is optional. Absent ⇒ its default, which is the rule before 2026-11-13. Loaders
 * write `catalog.rules` only with the switches that differ from the default (and not at all when
 * none do), so a catalog built without the table — every catalog saved before tonight — keeps
 * its hash and its games replay to the recorded state hash.
 *
 * The switches (proposals C2, C3, C6 in ~/arcspirits-harness/experiments/analysis/proposals.md):
 * - feralMonsterStrikeFirst (default true): false ⇒ against a monster, Feral no longer strikes
 *   first; it still deals 3 more damage. Against an Evil player it is unchanged.
 * - summonReplaceWhenFull (default false): true ⇒ with all 7 spirit slots full, a summon may
 *   replace one spirit of the player's choice (`spawnHandSpirit.replaceSlotIndex`); the replaced
 *   spirit is discarded exactly like `discardSpirit` (back to its bag, its augment lost, discard
 *   effects fire) but does not count as a corruption sacrifice.
 * - cultivatorRelicOnce (default false): true ⇒ Cultivator (5) grants its relic only the first
 *   time per game (the Max Barrier part is unchanged).
 *
 * Proposal C (P1-P4 in ~/arcspirits-harness/experiments/evil/report.md):
 * - pvpPaysOnCorrupt (default false): true ⇒ an Evil attacker gets 3 VP per Good player corrupted
 *   in the exchange and nothing for the attack itself (old: 2 + 2 per corrupted); each Good player
 *   in the exchange gets 2 VP per Evil attacker corrupted (old: nothing). See `pvpVpForAttack`.
 * - pvpGoodBounty (default true): only read under pvpPaysOnCorrupt. false ⇒ no Good bounty: the
 *   attacker still gets 3 VP per Good player corrupted, Good players get nothing (Michael,
 *   2026-11-13). Default true keeps the proposal-C test records replaying.
 * - abyssSummonDraw4Pick2 (default false): true ⇒ an Arcane Abyss Summon draws 4 and summons up
 *   to 2 (old: draw 3, summon 1). See `summonDrawSizes` in runtime.ts.
 * - firetailVsMonsters (default false): true ⇒ Firetail's +3 Initiative also applies in every monster
 *   combat (old: only in a round when another player is at your location).
 * - moonPerksNeedAttack (default false): true ⇒ Queen's 1 VP and Sorcerer's Enchanted die in the
 *   Awakening Phase only in a round in which that player attacked a player
 *   (`attackedPlayerThisRound`, written only under this rule).
 * - corruptorCountsAsCorruption (default false): true ⇒ Corruptor's drop to Fallen is one
 *   corruption: corruption count +1, Barrier restored, corruption effects (Cultist), and the usual
 *   sacrifice. The Spirit World → Arcane swap is unchanged.
 * - fallenDebtBelowZero (default false): true ⇒ while Fallen, each owed sacrifice that cannot be
 *   paid in spirits costs 1 VP even below 0: VP may go negative (no separate debt is kept).
 *
 * Sun / Bastion / PvP (2026-11-13):
 * - sunRework (default false): true ⇒ new texts for Mage, Chorus, Shieldbearer, Nomad, Gardener and
 *   Cleric (King unchanged); see RULE_CLASS_TEXT below and each class file.
 * - bastionVsMonsters (default false): true ⇒ Bastion halves every monster hit, whatever the
 *   monster's initiative (as when monsters had infinite initiative). PvP unchanged.
 * - pvpEngageVp (default false): only read under pvpPaysOnCorrupt. true ⇒ the Evil attacker also
 *   gets 2 VP for the attack itself (2 + 3 per Good player corrupted). See `pvpVpForAttack`.
 * - pvpAttackerSacrificeCap (default false): true ⇒ an Evil attacker corrupted in a PvP exchange it
 *   started owes at most 1 sacrifice for that corruption (its corruption count still rises).
 *
 * Powers (2026-11-13):
 * - powerRework (default false): true ⇒ the Navigation Power set is `NAVIGATION_POWERS_V2`
 *   (navigationPowers.ts): 11 general and 11 niche Powers, none needing another player to be Evil.
 *   Drafts, random Power gains and the rules brief read `navigationPowerPool(catalog)`.
 *
 * Mystic (2026-11-14, Michael):
 * - mysticCultivateDouble (default false): true ⇒ Mystic (2) is "When you Cultivate, you may gain
 *   twice as many runes." The engine always takes the second rune (runes over the carry limit are
 *   discarded by the player's choice, so more is never worse). It does not stack with another
 *   doubling of the turn. The old Mystic (2), 2 Max Barrier after a corruption, is off.
 *
 * Cultivate (2026-11-14, Michael):
 * - cultivateRuneOrRelic (default false): true ⇒ a Cultivate gives one reward per origin. 3+ spirits
 *   of the origin: its rune. 5+ spirits: its rune, or the origin's relic instead (the relic one
 *   time per player); the player chooses on a card (effects/originCultivate.ts). Old: at 5+ the
 *   rune and, the first time, also the relic.
 */

import type { ClassBreakpoint } from '$lib/types';
import type { PlayCatalog, PlayRules } from './types';

export type RuleName = keyof PlayRules;

export const RULE_DEFAULTS: Required<PlayRules> = {
	feralMonsterStrikeFirst: true,
	summonReplaceWhenFull: false,
	cultivatorRelicOnce: false,
	pvpPaysOnCorrupt: false,
	pvpGoodBounty: true,
	abyssSummonDraw4Pick2: false,
	firetailVsMonsters: false,
	moonPerksNeedAttack: false,
	corruptorCountsAsCorruption: false,
	fallenDebtBelowZero: false,
	sunRework: false,
	bastionVsMonsters: false,
	pvpEngageVp: false,
	pvpAttackerSacrificeCap: false,
	powerRework: false,
	mysticCultivateDouble: false,
	cultivateRuneOrRelic: false
};

const RULE_NAMES = Object.keys(RULE_DEFAULTS) as RuleName[];

/**
 * rules.json content (an object; a one-row array as served by a table is accepted too) → the
 * switches that differ from their default, or `undefined` when none do. Unknown names and
 * non-boolean values are reported in `problems` and ignored.
 */
export function parseRules(raw: unknown): { rules: PlayRules | undefined; problems: string[] } {
	const problems: string[] = [];
	const rows = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
	const rules: PlayRules = {};
	for (const row of rows) {
		if (!row || typeof row !== 'object') {
			problems.push(`rules: expected an object, got ${JSON.stringify(row)}`);
			continue;
		}
		for (const [name, value] of Object.entries(row as Record<string, unknown>)) {
			if (name === 'local' || name === 'id' || name.startsWith('_')) continue; // notes / row ids
			if (!RULE_NAMES.includes(name as RuleName)) {
				problems.push(`rules: unknown switch "${name}" (known: ${RULE_NAMES.join(', ')})`);
				continue;
			}
			if (typeof value !== 'boolean') {
				problems.push(`rules: "${name}" must be true or false, got ${JSON.stringify(value)}`);
				continue;
			}
			if (value !== RULE_DEFAULTS[name as RuleName]) rules[name as RuleName] = value;
			else delete rules[name as RuleName];
		}
	}
	return { rules: Object.keys(rules).length ? rules : undefined, problems };
}

/** The value of one switch for this catalog (its default when the catalog has no rules). */
export function ruleValue(
	catalog: Pick<PlayCatalog, 'rules'> | null | undefined,
	name: RuleName
): boolean {
	const value = catalog?.rules?.[name];
	return typeof value === 'boolean' ? value : RULE_DEFAULTS[name];
}

/** Printed class text that a switch replaces: class → breakpoint count → text. */
const RULE_CLASS_TEXT: { rule: RuleName; when: boolean; className: string; count: number; text: string }[] = [
	{
		rule: 'feralMonsterStrikeFirst',
		when: false,
		className: 'Feral',
		count: 1,
		text: 'When an Evil player attacks you, your side strikes first and deals 3 more damage. When a monster attacks you, deal 3 more damage.'
	},
	{
		rule: 'firetailVsMonsters',
		when: true,
		className: 'Firetail',
		count: 1,
		text: 'In combat with a monster, or in a round when another player is at your location, gain 3 Initiative.'
	},
	{
		rule: 'cultivatorRelicOnce',
		when: true,
		className: 'Cultivator',
		count: 5,
		text: 'On Cultivate, gain 10 Max Barrier. The first time (once per game), also gain 1 relic of your choice.'
	},
	{
		rule: 'moonPerksNeedAttack',
		when: true,
		className: 'Queen',
		count: 1,
		text: 'In the Awakening Phase, if you attacked a player this round, gain 1 VP.'
	},
	{
		rule: 'moonPerksNeedAttack',
		when: true,
		className: 'Sorcerer',
		count: 1,
		text: 'In the Awakening Phase, if you are Evil and attacked a player this round, gain 1 Enchanted Attack Dice.'
	},
	{
		rule: 'corruptorCountsAsCorruption',
		when: true,
		className: 'Corruptor',
		count: 1,
		text: 'Drop your status to Fallen; this counts as one corruption (Barrier restored, sacrifice as usual). Replace all Spirit World spirits with a random Arcane Abyss Spirit. Gain 2 Initiative.'
	},
	{
		rule: 'sunRework',
		when: true,
		className: 'Mage',
		count: 1,
		text: "On this spirit's Awakening, gain 2 Exalted Attack Dice. In the Awakening Phase, you may discard a rune to gain 1 Exalted Attack Dice."
	},
	{
		rule: 'sunRework',
		when: true,
		className: 'Chorus',
		count: 1,
		text: 'When you awaken a spirit (this one included), restore all your Barrier and gain 2 Max Barrier.'
	},
	{
		rule: 'sunRework',
		when: true,
		className: 'Shieldbearer',
		count: 1,
		text: 'When you take damage, take 2 less. If your Barrier is full, take 4 less instead.'
	},
	{
		rule: 'sunRework',
		when: true,
		className: 'Nomad',
		count: 1,
		text: 'You may do ALL location interactions up to two times. In the Awakening Phase, gain 1 Any basic Rune.'
	},
	{
		rule: 'sunRework',
		when: true,
		className: 'Gardener',
		count: 1,
		text: 'In the Awakening Phase, if you are not Evil, restore 3 Barrier and gain 1 Max Barrier.'
	},
	{
		rule: 'sunRework',
		when: true,
		className: 'Cleric',
		count: 1,
		text: "On this spirit's Awakening, gain 1 relic of your choice. For every unique Relic you hold, reduce incoming damage by 2."
	},
	{
		rule: 'mysticCultivateDouble',
		when: true,
		className: 'Mystic',
		count: 2,
		text: 'When you Cultivate, you may gain twice as many runes.'
	},
	{
		rule: 'bastionVsMonsters',
		when: true,
		className: 'Bastion',
		count: 1,
		text: 'If the opponent has higher initiative, or is a monster, when you Take Damage, half it (rounding up).'
	}
];

/**
 * A class's printed breakpoints with the text of every switched-on rule applied. Returns the
 * schema itself (same object) when no switch changes it, so callers that print it are unchanged
 * for catalogs without rules.
 */
export function ruleAdjustedClassSchema(
	catalog: Pick<PlayCatalog, 'rules'> | null | undefined,
	className: string,
	schema: ClassBreakpoint[] | null
): ClassBreakpoint[] | null {
	const changes = RULE_CLASS_TEXT.filter(
		(c) => c.className === className && ruleValue(catalog, c.rule) === c.when
	);
	if (!changes.length || !Array.isArray(schema)) return schema;
	return schema.map((tier) => {
		const change = changes.find((c) => c.count === Number(tier.count));
		if (!change) return tier;
		return { ...tier, effects: [{ ...tier.effects?.[0], type: 'benefit', description: change.text }] };
	});
}

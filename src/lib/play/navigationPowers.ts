import { isWildRune, WILDCARD_MAT_IDS } from './awakenConditions';
import { ruleValue } from './rules';
import type { PlayCatalog } from './types';

/** Consumable powers committed alongside a navigation destination. */
export const NAVIGATION_POWERS = [
	{
		id: 'thorn-ward',
		name: 'Thorn Ward',
		text: 'If another player enters your location this round, you may deal 1 damage to all opponents there. Gain 1 VP for each opponent damaged.'
	},
	{
		id: 'ember-charge',
		name: 'Ember Charge',
		text: 'If another player enters your location this round, you may restore 4 Barrier.'
	},
	{
		id: 'stone-shelter',
		name: 'Stone Shelter',
		text: 'If another player enters your location this round, you may steal 1 Rune from them. They choose the Rune.'
	},
	{
		id: 'tidal-tempo',
		name: 'Tidal Tempo',
		text: 'If another player enters your location this round, you may resolve each Location action one additional time.'
	},
	{
		id: 'shared-current',
		name: 'Shared Current',
		text: 'If another player enters your location this round, you may trade Spirits or Runes with another player there.'
	},
	{
		id: 'watchful-eye',
		name: 'Watchful Eye',
		text: 'If another player enters your location this round, you may pay 1 Rune to gain 2 Runes of the same type.'
	},
	{
		id: 'augment-relay',
		name: 'Augment Relay',
		text: 'If another player enters your location this round, you may steal 1 Spirit Augment from an opponent there.'
	},
	{
		id: 'guardians-accord',
		name: 'Guardian’s Accord',
		text: 'If another player enters your location this round, you may deal double damage this turn.'
	},
	{
		id: 'abyssal-reckoning',
		name: 'Abyssal Reckoning',
		text: 'If an Evil player enters your location this round, you may immediately deal damage to all Evil players equal to the number of Arcane Spirits you control.'
	},
	{
		id: 'cinder-awakening',
		name: 'Cinder Awakening',
		text: 'If an Evil player enters the Fire region with you this round, you may awaken 1 of your Spirits.'
	},
	{
		id: 'abyssal-execution',
		name: 'Abyssal Execution',
		text: 'If an Evil player enters the Arcane Abyss with you this round, you may defeat the monster without battling it.'
	},
	{
		id: 'forest-bounty',
		name: 'Forest Bounty',
		text: 'If an Evil player enters the Forest region with you this round, you may gain 3 Spirit Augments of your choice.'
	},
	{
		id: 'mountain-bastion',
		name: 'Mountain Bastion',
		text: 'If an Evil player enters the Mountain region with you this round, you may gain 3 Max Barrier or restore 6 Barrier.'
	},
	{
		id: 'tidal-arsenal',
		name: 'Tidal Arsenal',
		text: 'If an Evil player enters the Water region with you this round, you may gain 3 random Powers.'
	},
	{
		id: 'battle-fury',
		name: 'Battle Fury',
		text: 'If you engage in battle this turn, you may gain 2 Arcane Attack Dice for that battle.'
	},
	{
		id: 'battle-guard',
		name: 'Battle Guard',
		text: 'If you engage in battle this turn, you may reduce incoming damage by 4 for that battle.'
	},
	{
		id: 'battle-reward',
		name: 'Battle Reward',
		text: 'If you engage in battle with another player this turn, you may gain 2 VP.'
	},
	{
		id: 'unbroken-assault',
		name: 'Unbroken Assault',
		text: 'If you fail to Corrupt or defeat an opponent this turn, you may gain 4 Max Barrier and restore 4 Barrier.'
	},
	{
		id: 'duelists-prize',
		name: 'Duelist’s Prize',
		text: 'If you fail to Corrupt or defeat an opponent this turn, you may gain 2 VP.'
	},
	{
		id: 'fires-rhythm',
		name: 'Fire’s Rhythm',
		text: 'If you travel to the Fire region this turn, you may Rest twice.'
	},
	{
		id: 'forests-rhythm',
		name: 'Forest’s Rhythm',
		text: 'If you travel to the Forest region this turn, you may Cultivate twice.'
	},
	{
		id: 'mountains-wealth',
		name: 'Mountain’s Wealth',
		text: 'If you travel to the Mountain region this turn, you may gain 2 Runes of your choice.'
	}
] as const;

/**
 * Rule `powerRework` (rules.ts): the 2026-11-13 Power set. Half are GENERAL (useful on almost any
 * board, with a trigger the player meets alone or with ordinary company) and half are NICHE
 * (a specific board or situation, but a bigger effect). No Power needs another player to be Evil.
 * A Power whose text changed has a NEW id: the old ids keep their old text and effect, so games
 * recorded before the rework still replay to the recorded state.
 * Source of the needs: experiments/power-rework/DESIGN.md.
 */
export const NAVIGATION_POWERS_V2 = [
	// ── General ────────────────────────────────────────────────────────────────────────
	{ id: 'battle-guard', group: 'general' },
	{ id: 'battle-fury', group: 'general' },
	{
		id: 'unbroken-assault-2',
		group: 'general',
		name: 'Unbroken Assault',
		text: 'If you battle this round and do not defeat the monster (or corrupt a player), after that battle you may gain 4 Max Barrier and restore 4 Barrier.'
	},
	{
		id: 'duelists-prize-2',
		group: 'general',
		name: 'Duelist’s Prize',
		text: 'If you battle this round and do not defeat the monster (or corrupt a player), gain 2 VP after that battle.'
	},
	{
		id: 'ember-charge-2',
		group: 'general',
		name: 'Ember Charge',
		text: 'When destinations are revealed (before any battle), restore 5 Barrier.'
	},
	{ id: 'mountains-wealth', group: 'general' },
	{
		id: 'watchful-eye-2',
		group: 'general',
		name: 'Watchful Eye',
		text: 'When destinations are revealed, gain 1 Rune of your choice. Then you may change 1 Rune you hold into a Rune of your choice.'
	},
	{ id: 'thorn-ward', group: 'general' },
	{ id: 'tidal-tempo', group: 'general' },
	{ id: 'stone-shelter', group: 'general' },
	{
		id: 'underdogs-oath',
		group: 'general',
		name: 'Underdog’s Oath',
		text: 'When destinations are revealed, gain 1 VP for each player who has more VP than you.'
	},
	// ── Niche ──────────────────────────────────────────────────────────────────────────
	{
		id: 'cinder-awakening-2',
		group: 'niche',
		name: 'Cinder Awakening',
		text: 'If you travel to the Fire Region this round, you may awaken 1 of your face-down Spirits whose awakening cost is Runes, without paying it.'
	},
	{
		id: 'forest-bounty-2',
		group: 'niche',
		name: 'Forest Bounty',
		text: 'If you travel to the Forest Region this round, gain 2 Spirit Augments of your choice, and this round each of your Spirits may hold a second augment.'
	},
	{
		id: 'mountain-bastion-2',
		group: 'niche',
		name: 'Mountain Bastion',
		text: 'If you travel to the Mountain Region this round, gain 3 Max Barrier and restore all your Barrier. Gain 1 VP for each Max Barrier you could not gain because of the cap of 10.'
	},
	{
		id: 'tidal-calling',
		group: 'niche',
		name: 'Tidal Calling',
		text: 'If you travel to the Water Region this round, your Spirit World Summons draw 8 instead of 4 (you still summon up to 2).'
	},
	{
		id: 'abyssal-execution-2',
		group: 'niche',
		name: 'Abyssal Execution',
		text: 'If you travel to the Arcane Abyss this round, you may defeat a monster card in your hand that is at half its Barrier or less, without battling it. This is your battle for the round.'
	},
	{
		id: 'sudden-strike',
		group: 'niche',
		name: 'Sudden Strike',
		text: 'In your battles this round, you strike first.'
	},
	{
		id: 'tempered-dice',
		group: 'niche',
		name: 'Tempered Dice',
		text: 'When destinations are revealed, upgrade your Attack Dice 5 times. Each upgrade moves your lowest basic or enchanted die up one tier (basic → enchanted → exalted).'
	},
	{
		id: 'dark-bargain',
		group: 'niche',
		name: 'Dark Bargain',
		text: 'The first time you are Corrupted this round, gain 3 VP.'
	},
	{
		id: 'soul-ward',
		group: 'niche',
		name: 'Soul Ward',
		text: 'The first time you are Corrupted this round, you sacrifice no Spirits for it.'
	},
	{
		id: 'abyssal-reckoning-2',
		group: 'niche',
		name: 'Abyssal Reckoning',
		text: 'When destinations are revealed, gain VP for your status: Tainted 1, Corrupt 2, Fallen 4.'
	},
	{
		id: 'twin-rhythm',
		group: 'niche',
		name: 'Twin Rhythm',
		text: 'When destinations are revealed, you may Rest once and Cultivate once, wherever you are.'
	}
] as const;

type V2Entry = (typeof NAVIGATION_POWERS_V2)[number];
type V2OnlyId = Extract<V2Entry, { name: string }>['id'];
export type NavigationPowerId = (typeof NAVIGATION_POWERS)[number]['id'] | V2OnlyId;
export type NavigationPowerGroup = 'general' | 'niche';
export interface NavigationPowerDef {
	id: NavigationPowerId;
	name: string;
	text: string;
	group?: NavigationPowerGroup;
}

const V2_DEFS: NavigationPowerDef[] = NAVIGATION_POWERS_V2.map((entry) => {
	if ('name' in entry) return { ...entry };
	const kept = NAVIGATION_POWERS.find((power) => power.id === entry.id)!;
	return { id: kept.id, name: kept.name, text: kept.text, group: entry.group };
});
const ALL_DEFS: NavigationPowerDef[] = [
	...NAVIGATION_POWERS,
	...V2_DEFS.filter((def) => !NAVIGATION_POWERS.some((power) => power.id === def.id))
];

/** The Powers in play for this catalog: the 2026-11-13 set under rule `powerRework`, else the old 22. */
export function navigationPowerPool(
	catalog?: Pick<PlayCatalog, 'rules'> | null
): readonly NavigationPowerDef[] {
	return ruleValue(catalog, 'powerRework') ? V2_DEFS : NAVIGATION_POWERS;
}

export function isNavigationPowerId(value: unknown): value is NavigationPowerId {
	return typeof value === 'string' && ALL_DEFS.some((power) => power.id === value);
}

export function navigationPowerById(id: string | null | undefined): NavigationPowerDef | null {
	return ALL_DEFS.find((power) => power.id === id) ?? null;
}

/** Real, held Origin currency, including older saves without the explicit kind. */
export function isNavigationPowerRune(rune: {
	hasRune: boolean;
	id?: string;
	type?: string;
	originId?: string;
	classId?: string;
}): boolean {
	if (!rune.hasRune || rune.classId || rune.type === 'relic' || rune.type === 'augment')
		return false;
	if (isWildRune(rune)) return true;
	if (rune.id === WILDCARD_MAT_IDS.anyRelic || rune.id === WILDCARD_MAT_IDS.anyRune) return false;
	return rune.type === 'rune' || (!rune.type && !!rune.originId);
}

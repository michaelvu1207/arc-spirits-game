import { isWildRune, WILDCARD_MAT_IDS } from './awakenConditions';

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
		text: 'If an Evil player enters the Mountain region with you this round, you may gain 3 Potential or restore 6 Barrier.'
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
		text: 'If you fail to Corrupt or defeat an opponent this turn, you may gain 4 Potential and restore 4 Barrier.'
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

export type NavigationPowerId = (typeof NAVIGATION_POWERS)[number]['id'];

export function isNavigationPowerId(value: unknown): value is NavigationPowerId {
	return typeof value === 'string' && NAVIGATION_POWERS.some((power) => power.id === value);
}

export function navigationPowerById(id: string | null | undefined) {
	return NAVIGATION_POWERS.find((power) => power.id === id) ?? null;
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

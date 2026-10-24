/** Consumable powers committed alongside a navigation destination. */
export const NAVIGATION_POWERS = [
	{ id: 'thorn-ward', name: 'Thorn Ward', text: 'If another player enters your location this round, deal 1 damage to each opponent who damages you in PvP.' },
	{ id: 'ember-charge', name: 'Ember Charge', text: 'If another player enters your location this round, gain +3 Initiative in your first combat.' },
	{ id: 'stone-shelter', name: 'Stone Shelter', text: 'If another player enters your location this round, reduce the first damage you receive by 2.' },
	{ id: 'tidal-tempo', name: 'Tidal Tempo', text: 'If another player enters your location this round, gain 1 additional Location action.' },
	{ id: 'shared-current', name: 'Shared Current', text: 'If another player enters your location this round, each player there gains 1 temporary Rune matching that location’s Origin.' },
	{ id: 'watchful-eye', name: 'Watchful Eye', text: 'If another player enters your location this round, inspect the top 3 spirits of the relevant summon bag. Return them in order.' },
	{ id: 'augment-relay', name: 'Augment Relay', text: 'If another player enters your location this round, the first Spirit Augment you gain can be attached to a face-down spirit.' },
	{ id: 'guardians-accord', name: 'Guardian’s Accord', text: 'If another player enters your location this round, players there cannot target one another in PvP this round.' },
	{ id: 'abyssal-reckoning', name: 'Abyssal Reckoning', text: 'If an Evil player enters your location this round, immediately deal damage to all Evil players equal to your Arcane Spirit count.' },
	{ id: 'cinder-awakening', name: 'Cinder Awakening', text: 'If an Evil player enters the Fire region with you this round, awaken 1 of your Spirits.' },
	{ id: 'abyssal-execution', name: 'Abyssal Execution', text: 'If an Evil player enters the Arcane Abyss with you this round, defeat the monster without battling it.' },
	{ id: 'forest-bounty', name: 'Forest Bounty', text: 'If an Evil player enters the Forest region with you this round, gain 3 Spirit Augments.' },
	{ id: 'mountain-bastion', name: 'Mountain Bastion', text: 'If an Evil player enters the Mountain region with you this round, gain 3 Potential or 6 Barrier.' },
	{ id: 'tidal-arsenal', name: 'Tidal Arsenal', text: 'If an Evil player enters the Water region with you this round, gain 3 random Powers.' },
	{ id: 'battle-fury', name: 'Battle Fury', text: 'If you engage in battle this turn, gain 2 Arcane Attack Dice.' },
	{ id: 'battle-guard', name: 'Battle Guard', text: 'If you engage in battle this turn, reduce incoming damage by 4.' },
	{ id: 'battle-reward', name: 'Battle Reward', text: 'If you engage in battle with another player this turn, gain 2 VP.' },
	{ id: 'unbroken-assault', name: 'Unbroken Assault', text: 'If you fail to Corrupt or defeat an opponent this turn, gain 4 Potential and restore 4 Barrier.' },
	{ id: 'duelists-prize', name: "Duelist’s Prize", text: 'If you fail to Corrupt or defeat an opponent this turn, gain 2 VP.' },
	{ id: 'fires-rhythm', name: "Fire’s Rhythm", text: 'If you travel to the Fire region this turn, you may Rest twice.' },
	{ id: 'forests-rhythm', name: "Forest’s Rhythm", text: 'If you travel to the Forest region this turn, you may Cultivate twice.' },
	{ id: 'mountains-wealth', name: "Mountain’s Wealth", text: 'If you travel to the Mountain region this turn, gain 2 Runes of any type.' }
] as const;

export type NavigationPowerId = (typeof NAVIGATION_POWERS)[number]['id'];

export function isNavigationPowerId(value: unknown): value is NavigationPowerId {
	return typeof value === 'string' && NAVIGATION_POWERS.some((power) => power.id === value);
}

export function navigationPowerById(id: string | null | undefined) {
	return NAVIGATION_POWERS.find((power) => power.id === id) ?? null;
}

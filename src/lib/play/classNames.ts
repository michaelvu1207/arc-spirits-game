/**
 * Read compatibility for class labels stored under an earlier name.
 *
 * Saved games and the live catalog keep class names (not ids) in `spirit.classes`, so a
 * rename in the database must be mapped here. Each entry maps a previous name to the name
 * that the SAME class row (same id) carries next; {@link currentClassName} follows the chain
 * (for example Aquamaiden → Tide Warden → Warden), so an old save resolves to today's name.
 */
export const LEGACY_CLASS_NAMES: Record<string, string> = {
	// October 2026 rename (pre-August labels → August labels).
	'Dark Assassin': 'Aegis Weaver',
	Purifier: 'Growth Warden',
	'Ancient Magus': 'Relic Warden',
	Infiltrator: 'Cursed Fighter',
	'Child Prodigy': 'Wayfarer',
	'Blood Hunter': 'Woundreaver',
	'Arc Mage': 'Arcane Alchemist',
	Undercover: 'Relic Envoy',
	'Adaptive Fighter': 'Battle Adept',
	'World Ender': 'Void Sovereign',
	'World Guardian': 'Relic Sentinel',
	'Tree of Growth': 'Growth Warden',
	Firekeeper: 'Emberguard',
	'Fairy Droid': 'Runebound Vessel',
	'Mod Injector': 'Runic Duplicator',
	'Dark Fighter': 'Fatestriker',
	'Deep Sea Hunter': 'Tide Stalker',
	Ironmane: 'Monster Hunter',
	Strategist: 'Runic Bulwark',
	Aquamaiden: 'Tide Warden',
	'Dragon Warrior': 'Arcane Vanguard',
	'Golem of Wishes': 'Living Bastion',
	'Arcane Advisor': 'Arcane Ascendant',
	'Origin Channeler': 'Fairy',
	Counterguard: 'Disruptor',
	'Abyss Harbinger': 'The Corruptor',
	Vanguard: 'Sharpshooter',
	Hexblade: 'Cursed Fighter',
	'Dawn Sovereign': 'Golden Ruler',
	Spellforger: 'Elementalist',

	// November 2026 catalog (same class ids, new names; ~/ArcSpiritsArt/game/classes.json).
	// Mapped BY CLASS ID, so a saved spirit keeps the class row that the catalog gives it now.
	'Abyss Summoner': 'Summoner',
	'Relic Warden': 'Cleric',
	'Tide Warden': 'Warden',
	'Arcane Ascendant': 'Sorcerer',
	Wayfarer: 'Nomad',
	'Aegis Weaver': 'Paladin',
	Fatestriker: 'Assassin',
	'Tide Stalker': 'Huntress',
	Disruptor: 'Monk',
	'Arcane Vanguard': 'Spellblade',
	'Runebound Vessel': 'Herder',
	Emberguard: 'Sentinel',
	'Golden Ruler': 'King',
	'Living Bastion': 'Titan',
	'Cursed Fighter': 'Ram',
	'Runic Duplicator': 'Smith',
	'Growth Warden': 'Druid',
	'Rune Mage': 'Mage',
	'Soul Weaver': 'Mystic',
	'Spirit Animal': 'Beast',
	'Runic Bulwark': 'Bastion',
	'The Corruptor': 'Corruptor',
	'Void Sovereign': 'Queen',
	// Interim labels that the database carried before the November rename.
	Knight: 'Monk',
	Golem: 'Herder',
	Berserker: 'Ram',
	// 2026-11-12: the Traveling Trader's class (Michael).
	Wayfinder: 'Trader'
};

export function currentClassName(name: string): string {
	let current = name;
	// Follow the chain; the guard stops a (never expected) cycle.
	for (let hops = 0; hops < 8 && LEGACY_CLASS_NAMES[current]; hops += 1) {
		current = LEGACY_CLASS_NAMES[current];
	}
	return current;
}

export function currentClassCounts(counts: Record<string, number>): Record<string, number> {
	const result: Record<string, number> = {};
	for (const [name, count] of Object.entries(counts)) {
		const current = currentClassName(name);
		result[current] = (result[current] ?? 0) + count;
	}
	return result;
}

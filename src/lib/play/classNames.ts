/** Read compatibility for class labels stored before the October 2026 rename. */
export const LEGACY_CLASS_NAMES: Record<string, string> = {
  "Dark Assassin": "Aegis Weaver",
  "Purifier": "Growth Warden",
  "Ancient Magus": "Relic Warden",
  "Infiltrator": "Cursed Fighter",
  "Child Prodigy": "Wayfarer",
  "Blood Hunter": "Woundreaver",
  "Arc Mage": "Arcane Alchemist",
  "Undercover": "Relic Envoy",
  "Adaptive Fighter": "Battle Adept",
  "World Ender": "Void Sovereign",
  "World Guardian": "Relic Sentinel",
  "Tree of Growth": "Growth Warden",
  "Firekeeper": "Emberguard",
  "Fairy Droid": "Runebound Vessel",
  "Mod Injector": "Runic Duplicator",
  "Dark Fighter": "Fatestriker",
  "Deep Sea Hunter": "Tide Stalker",
  "Ironmane": "Monster Hunter",
  "Strategist": "Runic Bulwark",
  "Aquamaiden": "Tide Warden",
  "Dragon Warrior": "Arcane Vanguard",
  "Golem of Wishes": "Living Bastion",
  "Arcane Advisor": "Arcane Ascendant",
  "Origin Channeler": "Fairy",
  "Counterguard": "Disruptor",
  "Abyss Harbinger": "The Corruptor",
  "Vanguard": "Sharpshooter",
  "Hexblade": "Cursed Fighter",
  "Dawn Sovereign": "Golden Ruler",
  "Spellforger": "Elementalist"
};

export function currentClassName(name: string): string {
 return LEGACY_CLASS_NAMES[name] ?? name;
}

export function currentClassCounts(counts: Record<string, number>): Record<string, number> {
 const result: Record<string, number> = {};
 for (const [name, count] of Object.entries(counts)) {
  const current = currentClassName(name);
  result[current] = (result[current] ?? 0) + count;
 }
 return result;
}

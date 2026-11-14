/**
 * The canonical class registry — ASSEMBLED from the per-class modules in
 * `./classes/`. Each class authors everything it owns in its own file: its
 * abilities (`ability: ClassAbility[]`, declarative ladders and/or bespoke
 * handlers) and any decision resolvers (`decisions: ClassDecisions`). This file
 * imports every module as a namespace and composes:
 *   - {@link CLASS_ABILITIES} — keyed by class name (registry.ts derives
 *     CLASS_EFFECTS, handlers.ts derives CLASS_HANDLERS).
 *   - {@link CLASS_DECISIONS} — merged resolver map (decisions.ts exposes it as
 *     DECISION_RESOLVERS).
 *
 * To change a class — including its "may"-choice resolver — edit ONLY its file
 * under `./classes/`. Adding a `decisions` export there is picked up automatically
 * (namespace import), so no edit to this file is needed.
 *
 * Classes with an empty `ability` array (Cursed Spirit, Dawn Sovereign, Relic Sentinel,
 * Infiltrator, Smith) are engine/claim-handled elsewhere; the derived views
 * filter them out, so listing them is behavior-neutral and just documents them.
 * (Queen is NOT empty — it has a flat +1 VP `awakeningPhase` run handler.)
 */

import type { ClassAbility, ClassDecisions, ClassModule } from './classes/types';

import * as fighter from './classes/fighter';
import * as cultivator from './classes/cultivator';
import * as elementalist from './classes/elementalist';
import * as healer from './classes/healer';
import * as fairy from './classes/fairy';
import * as soulWeaver from './classes/soulWeaver';
import * as abyssSummoner from './classes/abyssSummoner';
import * as modInjector from './classes/modInjector';
import * as deepSeaHunter from './classes/deepSeaHunter';
import * as undercover from './classes/undercover';
import * as cursedSpirit from './classes/cursedSpirit';
import * as theCorruptor from './classes/theCorruptor';
import * as arcaneAdvisor from './classes/arcaneAdvisor';
import * as treeOfGrowth from './classes/treeOfGrowth';
import * as strategist from './classes/strategist';
import * as arcMage from './classes/arcMage';
import * as captain from './classes/captain';
import * as sharpshooter from './classes/sharpshooter';
import * as spiritAnimal from './classes/spiritAnimal';
import * as golemOfWishes from './classes/golemOfWishes';
import * as bloodHunter from './classes/bloodHunter';
import * as dragonWarrior from './classes/dragonWarrior';
import * as darkAssassin from './classes/darkAssassin';
import * as darkFighter from './classes/darkFighter';
import * as aquamaiden from './classes/aquamaiden';
import * as firekeeper from './classes/firekeeper';
import * as disruptor from './classes/disruptor';
import * as ironmane from './classes/ironmane';
import * as childProdigy from './classes/childProdigy';
import * as runeMage from './classes/runeMage';
import * as fairyDroid from './classes/fairyDroid';
import * as adaptiveFighter from './classes/adaptiveFighter';
import * as ancientMagus from './classes/ancientMagus';
import * as infiltrator from './classes/infiltrator';
import * as goldenRuler from './classes/goldenRuler';
import * as worldEnder from './classes/worldEnder';
import * as worldGuardian from './classes/worldGuardian';
// November 2026 special classes.
import * as falconer from './classes/falconer';
import * as princess from './classes/princess';
import * as feral from './classes/feral';
import * as trader from './classes/trader';
import * as master from './classes/master';
import * as wildling from './classes/wildling';
import * as wanderer from './classes/wanderer';
import * as prince from './classes/prince';
import * as hunter from './classes/hunter';
import * as rider from './classes/rider';
import * as salamander from './classes/salamander';
import * as firetail from './classes/firetail';
import * as chorus from './classes/chorus';
// Moon rework (approved 2026-11-12).
import * as witch from './classes/witch';
import * as acolyte from './classes/acolyte';
// Sun (approved 2026-11-12).
import * as shieldbearer from './classes/shieldbearer';
import * as gardener from './classes/gardener';

/** Re-exported so existing importers (`registry.ts`, `handlers.ts`, tests) keep working. */
export type { ClassAbility } from './classes/types';

/** Every class module keyed by its exact DB class name. */
const MODULES: Record<string, ClassModule> = {
	Fighter: fighter,
	Cultivator: cultivator,
	'Elementalist': elementalist,
	Healer: healer,
	'Fairy': fairy,
	'Mystic': soulWeaver,
	'Summoner': abyssSummoner,
	'Smith': modInjector,
	'Spellblade': deepSeaHunter,
	'Relic Envoy': undercover,
	'Cursed Spirit': cursedSpirit,
	'Corruptor': theCorruptor,
	'Sorcerer': arcaneAdvisor,
	'Druid': treeOfGrowth,
	'Monk': strategist,
	'Arcane Alchemist': arcMage,
	Captain: captain,
	'Sharpshooter': sharpshooter,
	'Beast': spiritAnimal,
	'Titan': golemOfWishes,
	'Woundreaver': bloodHunter,
	'Huntress': dragonWarrior,
	'Paladin': darkAssassin,
	'Assassin': darkFighter,
	'Warden': aquamaiden,
	'Sentinel': firekeeper,
	'Bastion': disruptor,
	'Monster Hunter': ironmane,
	'Nomad': childProdigy,
	'Mage': runeMage,
	'Herder': fairyDroid,
	'Battle Adept': adaptiveFighter,
	'Cleric': ancientMagus,
	'Ram': infiltrator,
	'King': goldenRuler,
	'Queen': worldEnder,
	'Relic Sentinel': worldGuardian,
	Falconer: falconer,
	Princess: princess,
	Feral: feral,
	Trader: trader,
	Master: master,
	Wildling: wildling,
	Wanderer: wanderer,
	Prince: prince,
	Hunter: hunter,
	Rider: rider,
	Salamander: salamander,
	Firetail: firetail,
	Chorus: chorus,
	Witch: witch,
	Acolyte: acolyte,
	Shieldbearer: shieldbearer,
	Gardener: gardener
};

/**
 * The canonical per-class ability map. `applyTrigger` runs the declarative
 * breakpoints FIRST, then any `run` abilities (the order is fixed).
 */
export const CLASS_ABILITIES: Record<string, ClassAbility[]> = Object.fromEntries(
	Object.entries(MODULES).map(([name, mod]) => [name, mod.ability])
);

/** Merged per-class decision resolvers, exposed by decisions.ts as DECISION_RESOLVERS. */
export const CLASS_DECISIONS: ClassDecisions = Object.assign(
	{},
	...Object.values(MODULES).map((mod) => mod.decisions ?? {})
);

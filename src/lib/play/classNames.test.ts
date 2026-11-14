import { describe, expect, it } from 'vitest';
import { currentClassCounts, currentClassName, LEGACY_CLASS_NAMES } from './classNames';
import { CLASS_ABILITIES } from './effects/abilities';
import { ensureStateShape } from './runtime';
import { makePlayer, makeState, spirit } from './effects/classes/testHelpers';

describe('renamed class identities', () => {
 it('resolves every previous name to an implemented class', () => {
  for(const previous of Object.keys(LEGACY_CLASS_NAMES)) {
   // Names chain (Aquamaiden → Tide Warden → Warden); every chain ends at an implemented class.
   const current=currentClassName(previous);
   expect(LEGACY_CLASS_NAMES[current], `${previous} must resolve to a current name`).toBeUndefined();
   expect(CLASS_ABILITIES[current], current).toBeDefined();
  }
 });
 it('follows the November 2026 renames by class id (not by ability)', () => {
  expect(currentClassName('Aquamaiden')).toBe('Warden');
  expect(currentClassName('Knight')).toBe('Monk');
  expect(currentClassName('Disruptor')).toBe('Monk');
  expect(currentClassName('Runic Bulwark')).toBe('Bastion');
  expect(currentClassName('Tide Stalker')).toBe('Huntress');
  expect(currentClassName('Arcane Vanguard')).toBe('Spellblade');
  expect(currentClassName('Berserker')).toBe('Ram');
  expect(currentClassName('Wayfinder')).toBe('Trader');
  expect(currentClassName('Beast')).toBe('Beast');
 });
 it('merges old and current trait counts without losing duplicates', () => {
  expect(currentClassCounts({'Fairy Droid': 2,'Runebound Vessel':1,Golem:1,Fighter:2})).toEqual({Herder:4,Fighter:2});
 });
 it('migrates persisted spirits and augment restrictions when loading a game', () => {
  const player=makePlayer({spirits:[spirit(1,{'Dark Assassin':1,Infiltrator:2})],unplacedAugments:[{runeId:'test',hostClass:'Fairy Droid'} as never]});
  const state=makeState(player);
  ensureStateShape(state);
  expect(player.spirits[0].classes).toEqual({Paladin:1,Ram:2});
  expect(player.unplacedAugments?.[0].hostClass).toBe('Herder');
  ensureStateShape(state);
  expect(player.spirits[0].classes.Ram).toBe(2);
 });
});

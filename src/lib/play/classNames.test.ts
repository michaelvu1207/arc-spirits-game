import { describe, expect, it } from 'vitest';
import { currentClassCounts, currentClassName, LEGACY_CLASS_NAMES } from './classNames';
import { CLASS_ABILITIES } from './effects/abilities';
import { ensureStateShape } from './runtime';
import { makePlayer, makeState, spirit } from './effects/classes/testHelpers';

describe('renamed class identities', () => {
 it('resolves every previous name to an implemented class', () => {
  for(const [previous,current] of Object.entries(LEGACY_CLASS_NAMES)) {
   expect(currentClassName(previous)).toBe(current);
   expect(CLASS_ABILITIES[current], current).toBeDefined();
  }
 });
 it('merges old and current trait counts without losing duplicates', () => {
  expect(currentClassCounts({'Fairy Droid': 2,'Runebound Vessel':1,Fighter:2})).toEqual({'Runebound Vessel':3,Fighter:2});
 });
 it('migrates persisted spirits and augment restrictions when loading a game', () => {
  const player=makePlayer({spirits:[spirit(1,{'Dark Assassin':1,Infiltrator:2})],unplacedAugments:[{runeId:'test',hostClass:'Fairy Droid'} as never]});
  const state=makeState(player);
  ensureStateShape(state);
  expect(player.spirits[0].classes).toEqual({'Aegis Weaver':1,'Cursed Fighter':2});
  expect(player.unplacedAugments?.[0].hostClass).toBe('Runebound Vessel');
  ensureStateShape(state);
  expect(player.spirits[0].classes['Cursed Fighter']).toBe(2);
 });
});

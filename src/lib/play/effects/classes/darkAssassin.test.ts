import { describe, expect, it } from 'vitest';
import { applyTrigger } from '../apply';
import { resetCombatFlags } from '../../combat';
import { runAction } from '../actions';
import { ctxFor, makePlayer, spirit, makeState } from './testHelpers';

describe('Aegis Weaver', () => {
	it('restores matching barriers without changing initiative when max barrier grows', () => {
		const player = makePlayer({
			barrier: 2,
			maxBarrier: 4,
			spirits: [spirit(1, { 'Aegis Weaver': 1 })]
		});
		const ctx = ctxFor(player, { trigger: 'onCultivate' });
		runAction(ctx, { kind: 'gainMaxBarrier', amount: 2 });
		expect(player).toMatchObject({ maxBarrier: 6, barrier: 4, brokenBarrier: 2, initiative: 0 });
	});
});

it.each([[1,4,2,5,3,0],[2,9,3,10,4,0],[2,10,3,10,3,0],[4,4,1,8,5,0]])('restores actual gain %s at max %s', (amount,maxBarrier,barrier,maxAfter,barrierAfter,initiative) => {
 const player=makePlayer({maxBarrier,barrier,spirits:[spirit(1,{'Aegis Weaver':1})]});
 runAction(ctxFor(player,{trigger:'onCultivate'}),{kind:'gainMaxBarrier',amount});
 expect(player).toMatchObject({maxBarrier:maxAfter,barrier:barrierAfter,brokenBarrier:maxAfter-barrierAfter,initiative});
});
it('does not restore for a face-down class', () => {
 const unit=spirit(1,{'Aegis Weaver':1}); unit.isFaceDown=true;
 const player=makePlayer({maxBarrier:4,barrier:2,spirits:[unit]});
 runAction(ctxFor(player,{trigger:'onCultivate'}),{kind:'gainMaxBarrier',amount:2});
 expect(player).toMatchObject({maxBarrier:6,barrier:4,initiative:0});
});

it('grants a fixed four initiative each combat without requiring max-barrier gains', () => {
 const player=makePlayer({maxBarrier:10,barrier:3,spirits:[spirit(1,{'Aegis Weaver':2})]});
 const state=makeState(player);
 for(let fight=0;fight<2;fight++) {
  resetCombatFlags(player);
  applyTrigger(state,'Red','inCombat',[]);
  expect(player.initiative).toBe(4);
  runAction(ctxFor(player,{trigger:'onCultivate'}),{kind:'gainMaxBarrier',amount:2});
  expect(player.initiative).toBe(4);
 }
 player.spirits[0].isFaceDown=true;
 resetCombatFlags(player);
 applyTrigger(state,'Red','inCombat',[]);
 expect(player.initiative).toBe(0);
});

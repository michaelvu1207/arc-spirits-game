import { buildRoomViewV2 } from './viewV2';
import { readFileSync } from 'node:fs';
import { describe, test, expect } from 'vitest';
import {
	BASE_RUNES,
	ANY_BASE_RUNE,
	migrateAwakenCondition,
	upgradeRelicRuneSlots
} from './baseRunes';
import { normalizeAwaken } from './awakenConditions';
import { regionCatalog } from './regionRules';
import { applyGameCommand, createLobbyState } from './runtime';
import type { PlayCatalog, PublicGameState, GameCommand, GameActor } from './types';
import type { AwakenCondition, MatSlotSnapshot } from '../types';
const fixture = JSON.parse(
	readFileSync(new URL('./__fixtures__/relic-awakening-audit.json', import.meta.url), 'utf8')
);
const lookup = new Map<string, any>(
	fixture.mats.map((m: any) => [m.id, { name: m.name, kind: m.origin_id ? 'rune' : 'relic' }])
);
const catalog: PlayCatalog = {
	guardians: [{ id: 'g', name: 'Guardian', originId: null }],
	classes: [],
	mats: fixture.mats.map((m: any) => ({
		id: m.id,
		name: m.name,
		kind: m.origin_id ? 'rune' : 'relic',
		originId: m.origin_id
	})),
	dice: [],
	spirits: fixture.spirits.map((s: any) => ({
		id: s.id,
		name: s.name,
		cost: s.cost,
		classes: {},
		origins: {},
		awaken: normalizeAwaken(s.awaken_condition, lookup)
	}))
};
const actor: GameActor = { memberId: 'host', displayName: 'Host', role: 'host', seatColor: 'Red' };
function run(state: PublicGameState, command: GameCommand) {
	const r = applyGameCommand(state, actor, command, catalog);
	if (!r.ok) throw Error(r.error.message);
	return r.state;
}
function game(id: string, mats: MatSlotSnapshot[]) {
	let s = createLobbyState({ roomCode: 'RELIC', guardianNames: ['Guardian'] });
	s = run(s, { type: 'claimSeat', seatColor: 'Red' });
	s = run(s, { type: 'selectGuardian', guardianName: 'Guardian' });
	s = run(s, { type: 'startGame', seed: 4 });
	s.phase = 'awakening';
	const target = catalog.spirits.find((x) => x.id === id)!;
	s.players.Red!.spirits = [{ ...target, slotIndex: 1, isFaceDown: true }];
	s.players.Red!.mats = mats;
	s.players.Red!.pendingPowerDrafts = [];
	return s;
}
const ids = Object.keys(BASE_RUNES);
function rune(id: string, index: number): MatSlotSnapshot {
	return {
		id,
		slotIndex: index, guid: `unit-${index}`,
		hasRune: true,
		type: 'rune',
		name: BASE_RUNES[id].name,
		originId: BASE_RUNES[id].originId
	};
}
const material = fixture.spirits.filter((s: any) => s.awaken_condition?.type === 'rune_cost');

describe('live relic awakening migration', () => {
	test('changes exactly the 15 audited awakenings and leaves the other 33 alone', () => {
		const changed = fixture.spirits.filter(
			(s: any) =>
				JSON.stringify(migrateAwakenCondition(s.awaken_condition)) !==
				JSON.stringify(s.awaken_condition)
		);
		expect(changed).toHaveLength(15);
		expect(fixture.spirits).toHaveLength(48);
		for (const s of fixture.spirits) {
			const condition = migrateAwakenCondition(s.awaken_condition);
			expect(migrateAwakenCondition(condition)).toEqual(condition);
		}
	});
	test.each<[string, string]>(material.map((s: any) => [s.name, s.id]))(
		'%s awakens using the mapped Runes, preserving every required unit',
		(_name, id) => {
			const target = catalog.spirits.find((s) => s.id === id)!;
			if (target.awaken?.kind !== 'rune_cost') throw Error('missing cost');
			const mats: MatSlotSnapshot[] = [];
			for (const req of target.awaken.mats) {
				expect(req.kind).toBe('rune');
				const rid = req.runeId === ANY_BASE_RUNE ? ids[0] : req.runeId;
				for (let i = 0; i < req.count; i++) mats.push(rune(rid, mats.length + 1));
			}
			const old = fixture.spirits.find((s: any) => s.id === id);
			expect(mats).toHaveLength(old.awaken_condition.rune_ids.length);
			mats.push({
				id: 'e02af831-e599-4676-9e37-820d19bfc3e1',
				name: 'Fairy Rune',
				slotIndex: mats.length + 1,
				type: 'relic',
				hasRune: true
			});
			const result = run(game(id as string, mats), { type: 'awakenSpirit', slotIndex: 1 });
			expect(result.players.Red!.spirits[0].isFaceDown).toBe(false);
			expect(result.players.Red!.mats.filter((m) => m.hasRune).map((m) => m.name)).toEqual([
				'Fairy Rune'
			]);
			const short = game(
				id as string,
				mats.slice(1, -1).map((m) => ({ ...m, hasRune: true }))
			);
			expect(
				applyGameCommand(short, actor, { type: 'awakenSpirit', slotIndex: 1 }, catalog).ok
			).toBe(false);
		}
	);
	test('Any Rune rejects Fairy Rune, Crown, and non-elemental currencies', () => {
		const id = 'ed612933-fd19-4b68-993e-6e61b52eb4ce';
		const mats: MatSlotSnapshot[] = [
			{
				slotIndex: 1,
				hasRune: true,
				id: 'e02af831-e599-4676-9e37-820d19bfc3e1',
				name: 'Fairy Rune',
				type: 'relic'
			},
			{
				slotIndex: 2,
				hasRune: true,
				id: 'a36f2af9-3c8c-4265-939c-62bd2e12e878',
				name: 'Royal Family',
				originId: '36bd6a28-d5ae-4598-97ea-cec6a14b9c5e',
				type: 'rune'
			}
		];
		expect(
			applyGameCommand(game(id, mats), actor, { type: 'awakenSpirit', slotIndex: 1 }, catalog).ok
		).toBe(false);
	});
	test('The Solar Reliquarian requires two different base Rune types and respects explicit selections', () => {
		const id = '5dc44c85-8224-4c49-89ff-90a37aa10040';
		const state = game(id, [rune(ids[0], 1), rune(ids[0], 2), rune(ids[1], 3)]);
		expect(
			applyGameCommand(
				state,
				actor,
				{
					type: 'awakenSpirit',
					slotIndex: 1,
					discardRefs: [
						{ kind: 'rune', slotIndex: 1 },
						{ kind: 'rune', slotIndex: 2 }
					]
				},
				catalog
			).ok
		).toBe(false);
		const result = run(state, {
			type: 'awakenSpirit',
			slotIndex: 1,
			discardRefs: [
				{ kind: 'rune', slotIndex: 1 },
				{ kind: 'rune', slotIndex: 3 }
			]
		});
		expect(result.players.Red!.spirits[0].isFaceDown).toBe(false);
		expect(result.players.Red!.mats.filter((m) => m.hasRune).map((m) => m.guid)).toEqual(['unit-2']);
	});
	test('converts named relics in old saves once and leaves Fairy Rune and Crown alone', () => {
		const state = game(
			material[0].id,
			fixture.mats
				.filter((m: any) => !m.origin_id)
				.map((m: any, i: number) => ({
					id: m.id,
					name: m.name,
					type: 'relic',
					hasRune: true,
					slotIndex: i + 1
				}))
		);
		upgradeRelicRuneSlots(state);
		const first = JSON.stringify(state.players.Red!.mats);
		upgradeRelicRuneSlots(state);
		expect(JSON.stringify(state.players.Red!.mats)).toBe(first);
		expect(
			state.players
				.Red!.mats.filter((m) => m.type === 'relic')
				.map((m) => m.name)
				.sort()
		).toEqual(['Crown', 'Fairy Rune']);
		expect(state.players.Red!.mats.filter((m) => m.type === 'rune')).toHaveLength(4);
	});
 test('a resumed old room refreshes its awakening offer after inventory conversion', () => {
  const state=game('25848694-6c69-408c-9b78-94948c6df3a6',[1,2].map(slotIndex=>({slotIndex,hasRune:true,type:'relic' as const,id:'8a0d54ca-aeab-405c-9e5c-1c1425d1aa86',name:'Firecracker'})));
  const view=buildRoomViewV2(state,{role:'host',seatColor:'Red',displayName:'Host'},{id:'host',role:'host',seatColor:'Red',displayName:'Host'},catalog);
  expect(view.projection.players.Red!.awakenOffers[0].requirement).toContain('Fire Rune');
  expect(view.projection.players.Red!.awakenLocked).toHaveLength(0);
 });
	test('normalizes legacy frozen-catalog costs too', () => {
		const legacy = {
			locations: [],
			spirits: [
				{
					awaken: {
						kind: 'rune_cost' as const,
						mats: [
							{
								runeId: '8a0d54ca-aeab-405c-9e5c-1c1425d1aa86',
								name: 'Firecracker',
								kind: 'relic' as const,
								count: 2,
								wildcard: false
							}
						]
					}
				}
			]
		};
		expect(regionCatalog(legacy).spirits[0].awaken.mats[0]).toMatchObject({
			name: 'Fire Rune',
			kind: 'rune',
			count: 2,
			runeId: ids[0]
		});
	});
});

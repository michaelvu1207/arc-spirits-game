import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { applyGameCommand, buildSessionProjection, createLobbyState } from './runtime';
import { buildLocationInteractions } from './locationInteractions';
import { getPowerAutoCommand } from './navigationPowerProgress';
import { regionCatalog, upgradeRegionActionUses } from './regionRules';
import { normalizeRegionContent } from './regions';
import { computeLocationInteractions } from './viewV2';
import { canApply } from './legality';
import type { GameCommand, GameActor, PlayCatalog, PublicGameState } from './types';

const catalog = regionCatalog(
	JSON.parse(
		readFileSync(new URL('../../../ml/catalog.json', import.meta.url), 'utf8')
	) as PlayCatalog
);
const actor: GameActor = { memberId: 'host', role: 'host', displayName: 'Host', seatColor: 'Red' };
function run(state: PublicGameState, command: GameCommand) {
	const result = applyGameCommand(state, actor, command, catalog);
	if (!result.ok) throw new Error(`${command.type}: ${result.error.message}`);
	return result.state;
}
function setup(destination: string) {
	let state = createLobbyState({
		roomCode: 'REGION',
		guardianNames: catalog.guardians.map((g) => g.name)
	});
	state = run(state, { type: 'claimSeat', seatColor: 'Red' });
	state = run(state, { type: 'selectGuardian', guardianName: catalog.guardians[0].name });
	state = run(state, { type: 'startGame', seed: 21 });
	state.phase = 'location';
	const p = state.players.Red!;
	p.navigationDestination = destination;
	p.pendingPowerDrafts = [];
	p.powerInventory = ['thorn-ward'];
	p.actionsUsedThisRound = [];
	p.phaseReady = false;
	const rune = catalog.mats.find((m) => m.id === '356f3ad2-4cac-4b69-a3cc-7559f8891d8e')!;
	p.mats.push({
		slotIndex: 9,
		hasRune: true,
		type: 'rune',
		id: rune.id,
		originId: rune.originId!,
		name: rune.name
	});
	return state;
}
function rowAt(destination: string) {
	const loc = catalog.locations!.find((l) => l.name === destination)!;
	return buildLocationInteractions(loc.rewardRows, destination).find((i) =>
		i.gains.some((g) => g.type === 'navigationPower')
	)!.rowIndex;
}

describe('two-action region rules', () => {
	test('every region has exactly the agreed two actions', () => {
		for (const name of ['Forest Region', 'Water Region', 'Mountain Region', 'Fire Region']) {
			const loc = catalog.locations!.find((l) => l.name === name)!;
			const rows = buildLocationInteractions(loc.rewardRows, name);
			expect(rows).toHaveLength(2);
			expect(rows.map((r) => r.rowIndex)).toEqual([0, 1]);
			expect(rows.some((r) => r.cost.some((c) => c.match === 'anyRelic'))).toBe(false);
		}
		const rows = (name: string) =>
			buildLocationInteractions(catalog.locations!.find((l) => l.name === name)!.rewardRows, name);
		expect(rows('Forest Region').map((r) => r.gains)).toMatchObject([
			[{ type: 'action', action: 'rest' }],
			[{ type: 'navigationPower', replace: false }]
		]);
		expect(rows('Water Region')[0].gains).toMatchObject([
			{ type: 'action', action: 'spiritWorldSummon' }
		]);
		expect(rows('Water Region')[1].gains).toMatchObject([
			{
				type: 'chooseRune',
				options: [{ name: 'Fighter' }, { name: 'Cultivator' }, { name: 'Spirit Animal' }]
			}
		]);
		expect(rows('Mountain Region')[0].gains).toMatchObject([
			{ type: 'chooseRune', options: [{ name: 'Elementalist' }, { name: 'Soul Weaver' }] }
		]);
		expect(rows('Mountain Region')[1].gains).toEqual([{ type: 'navigationPower', replace: true }]);
		expect(rows('Fire Region').map((r) => r.gains)).toMatchObject([
			[{ type: 'action', action: 'cultivate' }],
			[{ type: 'rune', rune: { type: 'augment', name: 'Cursed Spirit' } }]
		]);
	});
	test.each(['resolveLocationInteraction', 'acquireNavigationPower'])(
		'Forest %s immediately grants one random Power for one Rune',
		(entry) => {
			let state = setup('Forest Region');
			const before = state.players.Red!.powerInventory!.length;
			const command: GameCommand =
				entry === 'acquireNavigationPower'
					? { type: 'acquireNavigationPower', runeSlot: 9 }
					: {
							type: 'resolveLocationInteraction',
							rowIndex: 1,
							costChoices: [state.players.Red!.mats.length - 1]
						};
			const replay = run(state, command);
			state = run(state, command);
			const p = state.players.Red!;
			expect(p.mats.at(-1)!.hasRune).toBe(false);
			expect(p.powerInventory).toHaveLength(before + 1);
			expect(p.powerInventory).toEqual(replay.players.Red!.powerInventory);
			expect(p.pendingPowerDrafts).toEqual([]);
			expect(p.lastAction?.log?.join(' ')).toContain('Gained 1 random Power');
			expect(canApply(state, actor, { type: 'endLocationActions' }, catalog)).toBe(true);
		}
	);
	test.each(['Water Region', 'Fire Region'])(
		'%s cannot buy or replace Powers through the shortcut',
		(name) => {
			const state = setup(name);
			expect(
				applyGameCommand(state, actor, { type: 'acquireNavigationPower', runeSlot: 9 }, catalog).ok
			).toBe(false);
			expect(state.players.Red!.mats.at(-1)!.hasRune).toBe(true);
		}
	);
	test.each(['Forest Region', 'Water Region', 'Mountain Region', 'Fire Region'])(
		'%s rejects removed row 2 without spending currency',
		(name) => {
			const state = setup(name);
			expect(
				applyGameCommand(state, actor, { type: 'resolveLocationInteraction', rowIndex: 2 }, catalog)
					.ok
			).toBe(false);
			expect(state.players.Red!.mats.at(-1)!.hasRune).toBe(true);
		}
	);
	test('Mountain requires an owned Power and atomically replaces it after a paid draft', () => {
		let state = run(setup('Mountain Region'), { type: 'acquireNavigationPower', runeSlot: 9 });
		const p = state.players.Red!;
		expect(p.pendingPowerReplacement).toBe(true);
		expect(p.powerInventory).toEqual(['thorn-ward']);
		expect(p.pendingPowerDrafts![0]).toHaveLength(3);
		expect(p.pendingPowerDrafts![0]).not.toContain('thorn-ward');
		const powerId = p.pendingPowerDrafts![0][0];
		expect(canApply(state, actor, { type: 'chooseNavigationPower', powerId }, catalog)).toBe(false);
		expect(
			buildSessionProjection(state, { role: 'host', seatColor: 'Red', displayName: 'Host' }).players
				.Red!.pendingPowerReplacement
		).toBe(true);
		state = run(state, { type: 'chooseNavigationPower', powerId, replacePowerId: 'thorn-ward' });
		expect(state.players.Red!.powerInventory).toEqual([powerId]);
		expect(state.players.Red!.pendingPowerReplacement).toBe(false);
	});
	test('Mountain cannot consume a Rune when there is no Power to replace', () => {
		const state = setup('Mountain Region');
		state.players.Red!.powerInventory = [];
		expect(
			applyGameCommand(state, actor, { type: 'resolveLocationInteraction', rowIndex: 1 }, catalog)
				.ok
		).toBe(false);
		expect(state.players.Red!.mats.at(-1)!.hasRune).toBe(true);
		expect(computeLocationInteractions(state, state.players.Red!, catalog)[1].affordable).toBe(
			false
		);
	});
	test('Mountain deadline resolution preserves the hand size', () => {
		let state = run(setup('Mountain Region'), { type: 'acquireNavigationPower', runeSlot: 9 });
		expect(getPowerAutoCommand(state, 'Red')).toMatchObject({
			type: 'chooseNavigationPower',
			replacePowerId: 'thorn-ward'
		});
		state = run(state, { type: 'forceAdvancePhase' });
		expect(state.players.Red!.powerInventory).toHaveLength(1);
		expect(state.players.Red!.powerInventory).not.toContain('thorn-ward');
	});
	test('Forest cannot gain a Power without paying', () => {
		const state = setup('Forest Region');
		state.players.Red!.mats = [];
		expect(
			applyGameCommand(state, actor, { type: 'resolveLocationInteraction', rowIndex: 1 }, catalog)
				.ok
		).toBe(false);
		expect(state.players.Red!.powerInventory).toEqual(['thorn-ward']);
	});
	test('saved action use follows the surviving action and migrates only once', () => {
		const cases: [string, string[], string[]][] = [
			['Forest Region', ['row:0', 'row:1', 'row:2'], ['row:1', 'row:0']],
			['Water Region', ['row:0', 'row:1', 'row:2'], ['row:0', 'row:1']],
			['Mountain Region', ['row:0', 'row:1', 'row:2'], ['row:0']],
			['Fire Region', ['row:0', 'row:1', 'row:2'], ['row:1', 'row:0']]
		];
		for (const [region, old, expected] of cases) {
			const state = setup(region);
			delete state.regionActionsVersion;
			state.players.Red!.actionsUsedThisRound = old;
			upgradeRegionActionUses(state);
			expect(state.players.Red!.actionsUsedThisRound).toEqual(expected);
			upgradeRegionActionUses(state);
			expect(state.players.Red!.actionsUsedThisRound).toEqual(expected);
		}
	});
	test('existing state and content convert names while preserving region occupancy', () => {
		const legacy = {
			locationOccupancy: { 'Cyber City': ['Red'] },
			players: {
				Red: {
					navigationDestination: 'Lantern Canyon',
					spirits: [{ origins: { 'Floral Patch': 1 } }]
				}
			}
		};
		expect(normalizeRegionContent(legacy)).toEqual({
			locationOccupancy: { 'Mountain Region': ['Red'] },
			players: {
				Red: {
					navigationDestination: 'Fire Region',
					spirits: [{ origins: { 'Forest Region': 1 } }]
				}
			}
		});
	});
});

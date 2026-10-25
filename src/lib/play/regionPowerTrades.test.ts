import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { applyGameCommand, buildSessionProjection, createLobbyState } from './runtime';
import { buildLocationInteractions } from './locationInteractions';
import { getPowerAutoCommand } from './navigationPowerProgress';
import { regionCatalog } from './regionRules';
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

describe('region Power trades', () => {
	test('all four maps replace relic currency and rewards', () => {
		for (const loc of catalog.locations!.filter((l) => l.name !== 'Arcane Abyss')) {
			const rows = buildLocationInteractions(loc.rewardRows, loc.name);
			expect(rows.some((row) => row.gains.some((g) => g.type === 'navigationPower'))).toBe(true);
			expect(rows.some((row) => row.cost.some((c) => c.match === 'anyRelic'))).toBe(false);
			expect(
				rows.some((row) => row.gains.some((g) => g.type === 'rune' && g.rune.type === 'relic'))
			).toBe(false);
		}
	});
	test.each(['Forest Region', 'Mountain Region', 'Water Region'])(
		'%s pays one Rune to choose one of three Powers',
		(destination) => {
			let state = setup(destination);
			const before = state.players.Red!.powerInventory!.length;
			state = run(state, {
				type: 'resolveLocationInteraction',
				rowIndex: rowAt(destination),
				costChoices: [state.players.Red!.mats.length - 1]
			});
			expect(state.players.Red!.mats.at(-1)!.hasRune).toBe(false);
			const offers = state.players.Red!.pendingPowerDrafts![0];
			expect(new Set(offers).size).toBe(3);
			expect(canApply(state, actor, { type: 'endLocationActions' }, catalog)).toBe(false);
			state = run(state, { type: 'chooseNavigationPower', powerId: offers[0] });
			expect(state.players.Red!.powerInventory).toHaveLength(before + 1);
			expect(state.players.Red!.pendingPowerDrafts).toEqual([]);
		}
	);
	test('Fire requires a held Power and atomically replaces it after the paid draft', () => {
		let state = setup('Fire Region');
		state = run(state, { type: 'acquireNavigationPower', runeSlot: 9 });
		const p = state.players.Red!;
		expect(p.pendingPowerReplacement).toBe(true);
		expect(p.powerInventory).toEqual(['thorn-ward']);
		expect(p.pendingPowerDrafts![0]).not.toContain('thorn-ward');
		const powerId = p.pendingPowerDrafts![0][0];
		expect(canApply(state, actor, { type: 'chooseNavigationPower', powerId }, catalog)).toBe(false);
		expect(
			applyGameCommand(state, actor, { type: 'chooseNavigationPower', powerId }, catalog).ok
		).toBe(false);
		expect(
			buildSessionProjection(state, { role: 'host', seatColor: 'Red', displayName: 'Host' }).players
				.Red?.pendingPowerReplacement
		).toBe(true);
		state = run(state, { type: 'chooseNavigationPower', powerId, replacePowerId: 'thorn-ward' });
		expect(state.players.Red!.powerInventory).toEqual([powerId]);
		expect(state.players.Red!.pendingPowerReplacement).toBe(false);
	});
	test('an unavailable replacement cannot consume a Rune', () => {
		const state = setup('Fire Region');
		state.players.Red!.powerInventory = [];
		const command: GameCommand = {
			type: 'resolveLocationInteraction',
			rowIndex: rowAt('Fire Region')
		};
		expect(applyGameCommand(state, actor, command, catalog).ok).toBe(false);
		expect(state.players.Red!.mats.at(-1)!.hasRune).toBe(true);
		expect(
			computeLocationInteractions(state, state.players.Red!, catalog).find(
				(r) => r.rowIndex === rowAt('Fire Region')
			)?.affordable
		).toBe(false);
	});
	test('deadline resolution completes a replacement without creating an extra Power', () => {
		let state = setup('Fire Region');
		state = run(state, { type: 'acquireNavigationPower', runeSlot: 9 });
		const command = getPowerAutoCommand(state, 'Red');
		expect(command).toMatchObject({ type: 'chooseNavigationPower', replacePowerId: 'thorn-ward' });
		state = run(state, { type: 'forceAdvancePhase' });
		expect(state.players.Red!.powerInventory).toHaveLength(1);
		expect(state.players.Red!.powerInventory).not.toContain('thorn-ward');
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

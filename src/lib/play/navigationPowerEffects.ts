/** Executable, single-use Navigation Powers. UI only sends an advertised option id. */
import type {
	PrivatePlayerState,
	PublicGameState,
	PlayCatalog,
	SeatColor,
	DiceTier
} from './types';
import { isEvilAlignment } from './types';
import {
	NAVIGATION_POWERS,
	isNavigationPowerRune,
	type NavigationPowerId,
	navigationPowerById
} from './navigationPowers';
import { originRuneOptions, type ResolvedRune } from './locationInteractions';
import { SPIRIT_AUGMENT_CLASSES } from './augments';
import { nextId, nextInt } from './rng';
import { runAction } from './effects/actions';
import { buildEffectContext } from './effects/context';

export interface NavigationPowerOffer {
	id: string;
	powerId: NavigationPowerId;
	kind: string;
	prompt: string;
	options: { id: string; label: string }[];
	data?: Record<string, string | number | boolean>;
	mandatory?: boolean;
}
export interface NavigationPowerChoice {
	offerId: string;
	optionId: string;
}
export interface NavigationPowerPlayer extends PrivatePlayerState {
	navigationPowerUsed?: boolean;
	navigationPowerOffers?: NavigationPowerOffer[];
	powerInventory?: NavigationPowerId[];
	pendingPowerDrafts?: NavigationPowerId[][];
	navigationPowerCombatEnabled?: boolean;
	navigationPowerBattleTriggered?: boolean;
	navigationPowerTemporaryDice?: string[];
	navigationPowerTradeEnabled?: boolean;
}
export interface NavigationPowerHooks {
	damage?: (state: PublicGameState, seat: SeatColor, amount: number, log: string[]) => number;
	awaken?: (state: PublicGameState, seat: SeatColor, slot: number, catalog: PlayCatalog) => void;
	defeatMonster?: (state: PublicGameState, seat: SeatColor, catalog: PlayCatalog) => void;
	rest?: (state: PublicGameState, seat: SeatColor, catalog: PlayCatalog) => void;
	cultivate?: (state: PublicGameState, seat: SeatColor, catalog: PlayCatalog) => void;
}
export const navigationPowerPlayer = (p: PrivatePlayerState) => p as NavigationPowerPlayer;
const DECLINE = { id: 'decline', label: 'Decline' };
const runeChoices = () => originRuneOptions();

function offer(
	state: PublicGameState,
	seat: SeatColor,
	powerId: NavigationPowerId,
	kind: string,
	options: NavigationPowerOffer['options'],
	data?: NavigationPowerOffer['data'],
	mandatory = false
) {
	const p = navigationPowerPlayer(state.players[seat]!);
	const offers = (p.navigationPowerOffers ??= []);
	const id = nextId(state.rng, 'power-offer');
	offers.push({
		id,
		powerId,
		kind,
		prompt: navigationPowerById(powerId)?.text ?? powerId,
		options: mandatory ? options : [...options, DECLINE],
		data,
		mandatory
	});
}
function acceptOffer(
	state: PublicGameState,
	seat: SeatColor,
	id: NavigationPowerId,
	kind: string = id,
	data?: NavigationPowerOffer['data']
) {
	offer(state, seat, id, kind, [{ id: 'accept', label: 'Use power' }], data);
}
function logEffect(p: PrivatePlayerState, id: NavigationPowerId, text: string) {
	const label = navigationPowerById(id)?.name ?? id;
	p.lastAction = { key: `power:${id}`, label, log: [`${label}: ${text}`] };
}
function effect(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	action: Parameters<typeof runAction>[1]
) {
	const p = state.players[seat]!;
	const ctx = buildEffectContext({
		state,
		seat,
		player: p,
		catalog,
		trigger: 'onNavigate',
		traitCount: 1,
		log: []
	});
	runAction(ctx, action);
}
function gainRune(p: PrivatePlayerState, rune: ResolvedRune) {
	const slotIndex = Math.max(0, ...p.mats.map((m) => m.slotIndex)) + 1;
	p.mats.push({
		slotIndex,
		hasRune: true,
		id: rune.runeId,
		name: rune.name,
		type: 'rune',
		originId: rune.originId ?? undefined
	});
}
function runeOffer(
	state: PublicGameState,
	seat: SeatColor,
	id: NavigationPowerId,
	remaining: number
) {
	offer(
		state,
		seat,
		id,
		'rune',
		runeChoices().map((r) => ({ id: r.runeId, label: `Gain 1 ${r.name}` })),
		{ remaining }
	);
}
function augmentOffer(
	state: PublicGameState,
	seat: SeatColor,
	id: NavigationPowerId,
	remaining: number
) {
	offer(
		state,
		seat,
		id,
		'augment',
		SPIRIT_AUGMENT_CLASSES.map((name) => ({ id: name, label: `Gain ${name} Augment` })),
		{ remaining }
	);
}
/** Fixed-seed random acquisition, separate from the reveal-3/keep-1 draft. */
export function grantRandomNavigationPowers(
	state: PublicGameState,
	seat: SeatColor,
	count: number
) {
	const p = navigationPowerPlayer(state.players[seat]!);
	for (let i = 0; i < count; i++)
		(p.powerInventory ??= []).push(
			NAVIGATION_POWERS[nextInt(state.rng, NAVIGATION_POWERS.length)].id
		);
}
function region(destination: string | null) {
	return (
		(
			{
				'Floral Patch': 'forest',
				Forest: 'forest',
				'Lantern Canyon': 'fire',
				'Lantern Lights': 'fire',
				Fire: 'fire',
				'Cyber City': 'mountain',
				Mountain: 'mountain',
				'Tidal Cove': 'water',
				'Moon Tide': 'water',
				Water: 'water'
			} as Record<string, string>
		)[destination ?? ''] ?? destination
	);
}

/** Run once after all destinations and onNavigate effects are visible. Capture occupancy now. */
export function resolveNavigationPowerReveal(
	state: PublicGameState,
	_catalog: PlayCatalog,
	_hooks: NavigationPowerHooks = {}
) {
	const seats = [...state.activeSeats];
	const info = seats.map((seat) => ({
		seat,
		p: navigationPowerPlayer(state.players[seat]!),
		evil: isEvilAlignment(state.players[seat]!.statusLevel),
		destination: state.players[seat]!.navigationDestination
	}));
	for (const { seat, p, destination } of info) {
		const id = p.navigationPower;
		if (!id || p.navigationPowerUsed) continue;
		p.navigationPowerUsed = true;
		const others = info.filter((x) => x.seat !== seat && x.destination === destination);
		const evilPresent = others.some((x) => x.evil);
		if (
			[
				'thorn-ward',
				'ember-charge',
				'stone-shelter',
				'tidal-tempo',
				'shared-current',
				'watchful-eye',
				'augment-relay',
				'guardians-accord'
			].includes(id) &&
			!others.length
		)
			continue;
		switch (id) {
			case 'thorn-ward':
				acceptOffer(state, seat, id, 'damage', {
					targets: others.map((x) => x.seat).join(','),
					amount: 1,
					vp: true
				});
				break;
			case 'ember-charge':
				acceptOffer(state, seat, id, 'restore', { amount: 4 });
				break;
			case 'stone-shelter':
				acceptOffer(state, seat, id, 'steal-rune', {
					targets: others.map((x) => x.seat).join(',')
				});
				break;
			case 'tidal-tempo':
				acceptOffer(state, seat, id, 'repeat-location');
				break;
			case 'shared-current':
				acceptOffer(state, seat, id, 'trade');
				break;
			case 'watchful-eye': {
				const options = p.mats.filter(isNavigationPowerRune).flatMap((m) =>
					runeChoices().map((r) => ({
						id: `${m.slotIndex}:${r.runeId}`,
						label: `Pay ${m.name ?? 'Rune'} → gain 2 ${r.name}`
					}))
				);
				if (options.length) offer(state, seat, id, 'exchange', options);
				break;
			}
			case 'augment-relay': {
				const options = others.flatMap((x) =>
					(x.p.spiritAugmentAttachments ?? []).map((a, i) => ({
						id: JSON.stringify([x.seat, a.runeId, a.spiritSlotIndex, a.classId ?? null]),
						label: `Steal ${x.seat}'s ${a.className ?? 'Spirit'} Augment`
					}))
				);
				if (options.length) offer(state, seat, id, 'steal-augment', options);
				break;
			}
			case 'guardians-accord':
				acceptOffer(state, seat, id, 'combat');
				break;
			case 'abyssal-reckoning': {
				const count = p.spirits.filter((s) =>
					Object.keys(s.origins ?? {}).some((o) =>
						['Arcane Spirits', 'Sun', 'Moon', 'Space', 'Astral Zone', 'Void'].includes(o)
					)
				).length;
				if (evilPresent && count)
					acceptOffer(state, seat, id, 'damage', {
						targets: info
							.filter((x) => x.evil)
							.map((x) => x.seat)
							.join(','),
						amount: count
					});
				break;
			}
			case 'cinder-awakening':
				if (evilPresent && region(destination) === 'fire') {
					const options = p.spirits
						.filter((s) => s.isFaceDown)
						.map((s) => ({ id: String(s.slotIndex), label: `Awaken ${s.name}` }));
					if (options.length) offer(state, seat, id, 'awaken', options);
				}
				break;
			case 'abyssal-execution':
				if (evilPresent && destination === 'Arcane Abyss' && state.monster)
					acceptOffer(state, seat, id, 'defeat-monster');
				break;
			case 'forest-bounty':
				if (evilPresent && region(destination) === 'forest') augmentOffer(state, seat, id, 3);
				break;
			case 'mountain-bastion':
				if (evilPresent && region(destination) === 'mountain')
					offer(state, seat, id, 'bastion', [
						{ id: 'potential', label: 'Gain 3 Potential' },
						{ id: 'barrier', label: 'Restore 6 Barrier' }
					]);
				break;
			case 'tidal-arsenal':
				if (evilPresent && region(destination) === 'water')
					acceptOffer(state, seat, id, 'random-powers');
				break;
			case 'battle-fury':
			case 'battle-guard':
			case 'battle-reward':
			case 'unbroken-assault':
			case 'duelists-prize':
				acceptOffer(state, seat, id, 'combat');
				break;
			case 'fires-rhythm':
				if (region(destination) === 'fire')
					offer(state, seat, id, 'rest', [
						{ id: '1', label: 'Rest once' },
						{ id: '2', label: 'Rest twice' }
					]);
				break;
			case 'forests-rhythm':
				if (region(destination) === 'forest')
					offer(state, seat, id, 'cultivate', [
						{ id: '1', label: 'Cultivate once' },
						{ id: '2', label: 'Cultivate twice' }
					]);
				break;
			case 'mountains-wealth':
				if (region(destination) === 'mountain') runeOffer(state, seat, id, 2);
				break;
		}
	}
}

/** Remove stale mandatory obligations when earlier simultaneous thefts spent the last rune. */
export function refreshNavigationPowerOffers(state: PublicGameState) {
	for (const seat of state.activeSeats) {
		const p = state.players[seat] && navigationPowerPlayer(state.players[seat]!);
		if (!p?.navigationPowerOffers) continue;
		p.navigationPowerOffers = p.navigationPowerOffers.filter((entry) => {
			if (entry.kind !== 'give-rune') return true;
			const recipient = state.players[String(entry.data?.recipient) as SeatColor];
			if (!recipient) return false;
			entry.options = p.mats.filter(isNavigationPowerRune).map((m) => ({
				id: String(m.slotIndex),
				label: `Give ${m.name ?? 'Rune'} to ${entry.data?.recipient}`
			}));
			return entry.options.length > 0;
		});
	}
}

/** Only advertised, still-valid choices mutate state. Rejected choices preserve their offer. */
export function resolveNavigationPowerChoice(
	state: PublicGameState,
	seat: SeatColor,
	choice: NavigationPowerChoice,
	catalog: PlayCatalog,
	hooks: NavigationPowerHooks = {}
): { ok: boolean; error?: string } {
	const p = state.players[seat] && navigationPowerPlayer(state.players[seat]!);
	const entry = p?.navigationPowerOffers?.find((x) => x.id === choice.offerId);
	if (!p || !entry || !entry.options.some((x) => x.id === choice.optionId))
		return { ok: false, error: 'This power choice is no longer available.' };
	const { optionId } = choice;
	const id = entry.powerId;
	if (optionId === 'decline' && !entry.mandatory) {
		p.navigationPowerOffers = p.navigationPowerOffers!.filter((x) => x.id !== entry.id);
		logEffect(p, id, 'declined.');
		return { ok: true };
	}
	const targets = String(entry.data?.targets ?? '')
		.split(',')
		.filter(Boolean) as SeatColor[];
	switch (entry.kind) {
		case 'damage': {
			if (!hooks.damage) return { ok: false, error: 'Damage resolver is unavailable.' };
			const log: string[] = [];
			let damaged = 0;
			for (const target of targets)
				if (state.players[target])
					if (hooks.damage(state, target, Number(entry.data?.amount ?? 0), log) > 0) damaged++;
			if (entry.data?.vp) p.victoryPoints += damaged;
			break;
		}
		case 'restore':
			effect(state, seat, catalog, {
				kind: 'restoreBarrier',
				amount: Number(entry.data?.amount ?? 0)
			});
			break;
		case 'repeat-location':
			p.extraActions.locationInteraction = (p.extraActions.locationInteraction ?? 0) + 1;
			break;
		case 'trade':
			p.navigationPowerTradeEnabled = true;
			break;
		case 'steal-rune':
			for (const target of targets) {
				const owner = state.players[target];
				if (!owner) continue;
				const options = owner.mats
					.filter(isNavigationPowerRune)
					.map((m) => ({ id: String(m.slotIndex), label: `Give ${m.name ?? 'Rune'} to ${seat}` }));
				if (options.length)
					offer(state, target, id, 'give-rune', options, { recipient: seat }, true);
			}
			break;
		case 'give-rune': {
			const mat = p.mats.find((m) => m.hasRune && m.slotIndex === Number(optionId));
			const recipient = state.players[String(entry.data?.recipient) as SeatColor];
			if (!mat || !recipient)
				return { ok: false, error: 'The rune or recipient is no longer available.' };
			mat.hasRune = false;
			recipient.mats.push({
				...mat,
				hasRune: true,
				slotIndex: Math.max(0, ...recipient.mats.map((m) => m.slotIndex)) + 1
			});
			break;
		}
		case 'exchange': {
			const split = optionId.indexOf(':');
			const slot = Number(optionId.slice(0, split));
			const rune = runeChoices().find((r) => r.runeId === optionId.slice(split + 1));
			const mat = p.mats.find((m) => m.slotIndex === slot && m.hasRune);
			if (!mat || !rune) return { ok: false, error: 'The payment rune is no longer available.' };
			mat.hasRune = false;
			gainRune(p, rune);
			gainRune(p, rune);
			break;
		}
		case 'steal-augment': {
			const [ownerSeat, runeId, slot, classId] = JSON.parse(optionId);
			const owner = state.players[ownerSeat as SeatColor];
			const index =
				owner?.spiritAugmentAttachments.findIndex(
					(a) =>
						a.runeId === runeId && a.spiritSlotIndex === slot && (a.classId ?? null) === classId
				) ?? -1;
			const attachment = owner?.spiritAugmentAttachments[index];
			if (!owner || !attachment) return { ok: false, error: 'The augment is no longer available.' };
			owner.spiritAugmentAttachments.splice(index, 1);
			(p.unplacedAugments ??= []).push({
				runeId: attachment.runeId,
				name: attachment.name ?? attachment.className ?? 'Spirit Augment',
				classId:
					attachment.classId ?? catalog.classes.find((c) => c.name === attachment.className)?.id
			});
			break;
		}
		case 'combat':
			p.navigationPowerCombatEnabled = true;
			break;
		case 'awaken': {
			const spirit = p.spirits.find((s) => s.slotIndex === Number(optionId) && s.isFaceDown);
			if (!spirit || !hooks.awaken) return { ok: false, error: 'The spirit can no longer awaken.' };
			hooks.awaken(state, seat, spirit.slotIndex, catalog);
			break;
		}
		case 'defeat-monster':
			if (!state.monster || !hooks.defeatMonster)
				return { ok: false, error: 'No monster is available.' };
			else hooks.defeatMonster(state, seat, catalog);
			break;
		case 'augment': {
			const classRow = catalog.classes.find((c) => c.name === optionId);
			if (!classRow) return { ok: false, error: 'This augment is not available in the catalog.' };
			(p.unplacedAugments ??= []).push({
				runeId: `power-augment:${classRow.id}`,
				name: `${optionId} Augment`,
				classId: classRow.id
			});
			if (Number(entry.data?.remaining) > 1)
				augmentOffer(state, seat, id, Number(entry.data?.remaining) - 1);
			break;
		}
		case 'bastion':
			effect(
				state,
				seat,
				catalog,
				optionId === 'potential'
					? { kind: 'gainMaxBarrier', amount: 3 }
					: { kind: 'restoreBarrier', amount: 6 }
			);
			break;
		case 'random-powers':
			grantRandomNavigationPowers(state, seat, 3);
			break;
		case 'rest':
		case 'cultivate': {
			const callback = entry.kind === 'rest' ? hooks.rest : hooks.cultivate;
			if (!callback) return { ok: false, error: 'Location action is unavailable.' };
			for (let i = 0; i < Number(optionId); i++) callback(state, seat, catalog);
			break;
		}
		case 'rune': {
			const rune = runeChoices().find((r) => r.runeId === optionId);
			if (!rune) return { ok: false, error: 'Unknown rune.' };
			gainRune(p, rune);
			if (Number(entry.data?.remaining) > 1)
				runeOffer(state, seat, id, Number(entry.data?.remaining) - 1);
			break;
		}
		case 'failed-potential':
			effect(state, seat, catalog, { kind: 'gainMaxBarrier', amount: 4 });
			effect(state, seat, catalog, { kind: 'restoreBarrier', amount: 4 });
			break;
		case 'failed-vp':
			p.victoryPoints += 2;
			break;
		default:
			return { ok: false, error: 'Unknown power effect.' };
	}
	p.navigationPowerOffers = p.navigationPowerOffers!.filter((x) => x.id !== entry.id);
	refreshNavigationPowerOffers(state);
	logEffect(p, id, `used ${entry.options.find((x) => x.id === optionId)?.label ?? optionId}.`);
	return { ok: true };
}

/** Called after class effects for every combat; temporary dice are removed by the matching after hook. */
export function beforeNavigationPowerCombat(state: PublicGameState, seat: SeatColor, pvp = false) {
	const p = state.players[seat] && navigationPowerPlayer(state.players[seat]!);
	if (!p?.navigationPowerCombatEnabled || !p.navigationPower) return;
	if (p.navigationPower === 'guardians-accord')
		p.combatDamageMultiplier = Math.max(1, p.combatDamageMultiplier ?? 1) * 2;
	if (p.navigationPower === 'battle-guard') p.damageReduction = (p.damageReduction ?? 0) + 4;
	if (p.navigationPower === 'battle-fury' && !p.navigationPowerTemporaryDice?.length) {
		const ids = [nextId(state.rng, 'power-die'), nextId(state.rng, 'power-die')];
		p.attackDice.push(...ids.map((instanceId) => ({ instanceId, tier: 'arcane' as DiceTier })));
		p.navigationPowerTemporaryDice = ids;
		p.navigationPowerBattleTriggered = true;
	}
	if (p.navigationPower === 'battle-reward' && pvp && !p.navigationPowerBattleTriggered) {
		p.victoryPoints += 2;
		p.navigationPowerBattleTriggered = true;
	}
}
/** successful means this combat killed a monster or corrupted at least one opposing player. */
export function afterNavigationPowerCombat(
	state: PublicGameState,
	seat: SeatColor,
	successful: boolean,
	_pvp = false
) {
	const p = state.players[seat] && navigationPowerPlayer(state.players[seat]!);
	if (!p) return;
	if (p.navigationPowerTemporaryDice?.length) {
		const ids = new Set(p.navigationPowerTemporaryDice);
		p.attackDice = p.attackDice.filter((d) => !ids.has(d.instanceId));
		p.navigationPowerTemporaryDice = [];
	}
	if (!successful && p.navigationPowerCombatEnabled && !p.navigationPowerBattleTriggered) {
		if (p.navigationPower === 'unbroken-assault')
			acceptOffer(state, seat, p.navigationPower, 'failed-potential');
		if (p.navigationPower === 'duelists-prize')
			acceptOffer(state, seat, p.navigationPower, 'failed-vp');
		p.navigationPowerBattleTriggered = true;
	}
}

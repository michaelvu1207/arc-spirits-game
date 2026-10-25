/** Consensual exchanges. Proposals snapshot assets so a stale acceptance cannot move replacements. */
import type {
	GameCommand,
	NavigationPowerTrade,
	PrivatePlayerState,
	PublicGameState,
	SeatColor
} from './types';
import { spiritLimitFor } from './types';
import { nextId } from './rng';
import { isNavigationPowerRune } from './navigationPowers';
import { hashGameState } from './stateHash';

type Proposal = Extract<GameCommand, { type: 'tradeNavigationPower' }>;
type SnapshotTrade = NavigationPowerTrade & { fingerprint: string };
function assets(p: PrivatePlayerState, spirits: number[], runes: number[]) {
	return {
		spirits: spirits.map((slot) => p.spirits.find((s) => s.slotIndex === slot)),
		runes: runes.map((slot) =>
			p.mats.find((m) => m.slotIndex === slot && isNavigationPowerRune(m))
		),
		attachments: p.spiritAugmentAttachments.filter((a) => spirits.includes(a.spiritSlotIndex))
	};
}
function inspect(state: PublicGameState, t: NavigationPowerTrade) {
	const from = state.players[t.fromSeat],
		to = state.players[t.toSeat];
	if (
		!from ||
		!to ||
		from === to ||
		!from.navigationDestination ||
		from.navigationDestination !== to.navigationDestination ||
		state.phase !== 'location'
	)
		return null;
	const give = assets(from, t.giveSpiritSlots, t.giveRuneSlots),
		receive = assets(to, t.receiveSpiritSlots, t.receiveRuneSlots);
	if ([...give.spirits, ...give.runes, ...receive.spirits, ...receive.runes].some((a) => !a))
		return null;
	if (
		from.spirits.length - give.spirits.length + receive.spirits.length >
			spiritLimitFor(from.statusLevel) ||
		to.spirits.length - receive.spirits.length + give.spirits.length >
			spiritLimitFor(to.statusLevel)
	)
		return null;
	return { from, to, give, receive, fingerprint: hashGameState([give, receive]) };
}
export function proposePowerTrade(
	state: PublicGameState,
	seat: SeatColor,
	command: Proposal
): { ok: boolean; error?: string } {
	const p = state.players[seat],
		target = state.players[command.targetSeat];
	if (!p?.navigationPowerTradeEnabled || p.phaseReady || !target || target.phaseReady)
		return { ok: false, error: 'This trade power is not available.' };
	if (p.pendingNavigationTrade || target.pendingNavigationTrade)
		return { ok: false, error: 'Resolve the existing trade first.' };
	const fields = [
		command.giveSpiritSlots ?? [],
		command.receiveSpiritSlots ?? [],
		command.giveRuneSlots ?? [],
		command.receiveRuneSlots ?? []
	];
	if (
		fields.some(
			(a) =>
				!Array.isArray(a) || a.some((n) => !Number.isInteger(n)) || new Set(a).size !== a.length
		) ||
		fields.every((a) => !a.length)
	)
		return { ok: false, error: 'Choose valid assets to exchange.' };
	const t: NavigationPowerTrade = {
		id: nextId(state.rng, 'power-trade'),
		fromSeat: seat,
		toSeat: command.targetSeat,
		giveSpiritSlots: fields[0],
		receiveSpiritSlots: fields[1],
		giveRuneSlots: fields[2],
		receiveRuneSlots: fields[3]
	};
	const result = inspect(state, t);
	if (!result)
		return {
			ok: false,
			error: 'Both players must share this location and own the offered assets.'
		};
	const proposal: SnapshotTrade = { ...t, fingerprint: result.fingerprint };
	p.pendingNavigationTrade = proposal;
	target.pendingNavigationTrade = proposal;
	return { ok: true };
}
export function respondPowerTrade(
	state: PublicGameState,
	seat: SeatColor,
	tradeId: string,
	accept: boolean
): { ok: boolean; error?: string } {
	const t = state.players[seat]?.pendingNavigationTrade as SnapshotTrade | undefined;
	if (!t || t.toSeat !== seat || t.id !== tradeId)
		return { ok: false, error: 'Only the recipient may answer this trade.' };
	const result = inspect(state, t);
	if (!accept || !result || result.fingerprint !== t.fingerprint) {
		if (state.players[t.fromSeat]) state.players[t.fromSeat]!.pendingNavigationTrade = null;
		if (state.players[t.toSeat]) state.players[t.toSeat]!.pendingNavigationTrade = null;
		return { ok: true }; // Stale proposals safely expire; no item is moved.
	}
	const { from, to, give, receive } = result;
	// Remove all outgoing spirits first so exchanges work on full tableaux.
	const detach = (p: PrivatePlayerState, bundle: typeof give) => {
		p.spirits = p.spirits.filter((s) => !bundle.spirits.includes(s));
		p.spiritAugmentAttachments = p.spiritAugmentAttachments.filter(
			(a) => !bundle.attachments.includes(a)
		);
	};
	detach(from, give);
	detach(to, receive);
	// Move detached bundles using their saved attachment snapshots.
	for (const [dest, bundle] of [
		[to, give],
		[from, receive]
	] as const) {
		for (const s of bundle.spirits) {
			if (!s) continue;
			let slot = 1;
			while (dest.spirits.some((x) => x.slotIndex === slot)) slot++;
			dest.spirits.push({ ...s, slotIndex: slot });
			dest.spiritAugmentAttachments.push(
				...bundle.attachments
					.filter((a) => a.spiritSlotIndex === s.slotIndex)
					.map((a) => ({ ...a, spiritSlotIndex: slot }))
			);
		}
		for (const rune of bundle.runes)
			if (rune) {
				rune.hasRune = false;
				dest.mats.push({
					...rune,
					hasRune: true,
					slotIndex: Math.max(0, ...dest.mats.map((m) => m.slotIndex)) + 1
				});
			}
	}
	from.navigationPowerTradeEnabled = false;
	from.pendingNavigationTrade = null;
	to.pendingNavigationTrade = null;
	from.lastAction = {
		key: 'power-trade',
		label: 'Shared Current',
		log: [`Traded with ${t.toSeat}.`]
	};
	to.lastAction = {
		key: 'power-trade',
		label: 'Shared Current',
		log: [`Traded with ${t.fromSeat}.`]
	};
	return { ok: true };
}

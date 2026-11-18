import { nextId } from '../../rng';
import { REGION_ORIGIN_NAMES } from '../../regions';
import {
	buildLocationInteractions,
	eligibleCostSlots,
	isWildcardCost,
	locationCostRequiresSelection,
	matchRewardCost,
	type LocationInteraction,
	type ResolvedRune
} from '../../locationInteractions';
import { gainSpiritAugments, runAction } from '../actions';
import { FALCONER_TRADE_ACTION } from '../awakenHandlers';
import { runesAreWild } from '../matMatch';
import { ruleValue } from '../../rules';
import type { PlayCatalog, PrivatePlayerState, PublicGameState } from '../../types';
import type { ClassAbility, ClassDecisions } from './types';

// Falconer — "On awaken, gain 2 Spirit Augments of your choice. In the Location Phase, you may
// do one Spirit Augment trade from any location."
//
// On awaken: when the Falconer spirit itself awakens, the owner gains 2 generic Spirit
// Augments (the pouch; the type is chosen at placement, normal capacity rules). With Smith that
// is 2 + 2. It happens only on that spirit's own awakening.
//
// The trade: a Spirit Augment trade is a location TRADE row whose gains are only Spirit
// Augments (today: the Water Region and Fire Region trades, "pay any basic rune → one of three
// augments"). The rows come from the same builder the Location phase uses
// (`buildLocationInteractions`), so the cost and the augment list follow the map data. Once per
// round, when the Location Phase starts (before the own-location interactions — the card takes
// over the stage), a player with an awakened Falconer gets a card that lists every such trade
// they can pay for, wherever they are (the Arcane Abyss too). The cost is paid like at the
// location: when held runes of different types could pay a wildcard cost, a second card asks
// which rune to discard. Smith adds 1 augment of the owner's choice (the common gain path), as at
// a location. An unanswered card ends when the Benefits step starts.

type Ctx = Parameters<ClassDecisions[string]>[0];
type Player = Ctx['player'];

interface AugmentTrade {
	location: string;
	interaction: LocationInteraction;
	augment: ResolvedRune;
}

/** The augment choices of a row whose gains are ONLY augments, else null. */
function augmentGains(interaction: LocationInteraction): ResolvedRune[] | null {
	if (interaction.kind !== 'trade' || interaction.gains.length === 0) return null;
	const out: ResolvedRune[] = [];
	for (const gain of interaction.gains) {
		if (gain.type === 'rune' && gain.rune.type === 'augment') out.push(gain.rune);
		else if (gain.type === 'chooseRune' && gain.options.every((o) => o.type === 'augment'))
			out.push(...gain.options);
		else return null;
	}
	return out;
}

/** Location names to scan: the catalog's locations plus the four regions (whose actions are
 *  built in code, so they exist even without catalog rows). */
function locationNames(ctx: Ctx): string[] {
	const names = new Set<string>(Object.values(REGION_ORIGIN_NAMES));
	for (const loc of ctx.catalog?.locations ?? []) names.add(loc.name);
	return [...names];
}

/** Every Spirit Augment trade on the map, one entry per augment choice. */
export function falconerTrades(ctx: Ctx): AugmentTrade[] {
	const out: AugmentTrade[] = [];
	for (const location of locationNames(ctx)) {
		const rows = ctx.catalog?.locations?.find((l) => l.name === location)?.rewardRows;
		for (const interaction of buildLocationInteractions(rows, location)) {
			for (const augment of augmentGains(interaction) ?? []) {
				out.push({ location, interaction, augment });
			}
		}
	}
	return out;
}

const tradeId = (t: AugmentTrade) => `${t.location}|${t.interaction.rowIndex}|${t.augment.runeId}`;

function findTrade(ctx: Ctx, id: string): AugmentTrade | undefined {
	return falconerTrades(ctx).find((t) => tradeId(t) === id);
}

/** Trader: every held basic rune also pays a rune-of-an-origin cost. */
const costOpts = (player: Player) => ({ runesWild: runesAreWild(player) });

const affordable = (player: Player, t: AugmentTrade) =>
	matchRewardCost(t.interaction.cost, player.mats, [], costOpts(player)).ok;

function costLabel(t: AugmentTrade): string {
	return t.interaction.cost.map((c) => c.label).join(' + ') || 'nothing';
}

/** Pay the trade (with an optional chosen mats array index) and gain the augment(s). */
function completeTrade(ctx: Ctx, t: AugmentTrade, preferred: number[] = []): void {
	const { player, log } = ctx;
	const matched = matchRewardCost(t.interaction.cost, player.mats, preferred, costOpts(player));
	if (!matched.ok) {
		log.push('Falconer: you can no longer pay for that trade.');
		return;
	}
	const paid: string[] = [];
	for (const arrayIndex of matched.consumedArrayIndexes) {
		const slot = player.mats[arrayIndex];
		if (!slot) continue;
		slot.hasRune = false;
		paid.push(slot.name ?? 'rune');
	}
	// The remote trade is a location interaction (Traveling Trader's awaken reads this).
	player.actionsUsedThisRound.push(FALCONER_TRADE_ACTION);
	log.push(
		`Falconer (${t.location} trade): paid ${paid.join(', ') || 'nothing'} for a ${t.augment.name} augment.`
	);
	// Smith's extra (1 generic augment) is added by the common gain path.
	gainSpiritAugments(
		player,
		[{ runeId: t.augment.runeId, name: t.augment.name, classId: t.augment.classId ?? '' }],
		log
	);
}

export const FALCONER_AWAKEN_AUGMENTS = 2;

// Rule `falconerDoubleKill` (Michael, 2026-11-14): "On your next monster kill you may gain double
// the rewards. Then discard this spirit." After a kill that opens a reward claim, a player with an
// awakened Falconer SPIRIT (a Falconer augment has no spirit to discard) gets a yes/no card.
// Yes: every reward of that kill is given twice and the Falconer spirit is discarded (the
// reducer's `resolveDecision` does both, because discarding a spirit lives there). No, or no
// answer before the claim or the Benefits step: nothing, and the next kill asks again.
export const FALCONER_DOUBLE_KIND = 'falconerDouble';

/** The awakened spirit whose own card has the Falconer class, if any. */
export function awakeFalconerSpirit(player: PrivatePlayerState) {
	return (player.spirits ?? []).find((s) => !s.isFaceDown && (s.classes?.['Falconer'] ?? 0) > 0);
}

/** Offer the doubling for the reward claim that is open now. */
export function offerFalconerDouble(
	state: PublicGameState,
	player: PrivatePlayerState,
	catalog: Pick<PlayCatalog, 'rules'> | null | undefined
): void {
	if (!ruleValue(catalog, 'falconerDoubleKill')) return;
	const reward = player.pendingReward;
	const falconer = awakeFalconerSpirit(player);
	if (!reward || reward.doubled || !falconer) return;
	const noVp = ruleValue(catalog, 'falconerNoDoubleVp');
	player.pendingDecisions = (player.pendingDecisions ?? []).filter((d) => d.kind !== FALCONER_DOUBLE_KIND);
	player.pendingDecisions.push({
		id: nextId(state.rng, 'dec'),
		source: 'class',
		kind: FALCONER_DOUBLE_KIND,
		prompt: `Falconer: gain double the rewards of ${reward.monsterName}${noVp ? ' (not its Victory Points)' : ''}? ${falconer.name} is then discarded.`,
		options: [
			{ id: 'yes', label: `Double the rewards${noVp ? ' except Victory Points' : ''} and discard ${falconer.name}` },
			{ id: 'no', label: 'No, keep the spirit' }
		],
		expiresAt: 'benefits'
	});
}

export const ability: ClassAbility[] = [
	{
		on: 'awakening',
		run(ctx) {
			if (ruleValue(ctx.catalog, 'falconerDoubleKill')) return; // the new Falconer gives no augments
			const slot = (ctx.command as { slotIndex?: number } | undefined)?.slotIndex;
			const awakened = ctx.player.spirits.find((s) => s.slotIndex === slot);
			if (!awakened || (awakened.classes?.['Falconer'] ?? 0) <= 0) return;
			runAction(ctx, { kind: 'gainAugment', amount: FALCONER_AWAKEN_AUGMENTS });
		}
	},
	{
		on: 'locationPhase',
		run(ctx) {
			if (ruleValue(ctx.catalog, 'falconerDoubleKill')) return; // the new Falconer has no trade
			const { player, log, state } = ctx;
			player.pendingDecisions = (player.pendingDecisions ?? []).filter(
				(d) => d.kind !== 'falconerTrade' && d.kind !== 'falconerPayment'
			);
			const trades = falconerTrades(ctx).filter((t) => affordable(player, t));
			if (trades.length === 0) {
				log.push('Falconer: you cannot pay for any Spirit Augment trade.');
				return;
			}
			player.pendingDecisions.push({
				id: nextId(state.rng, 'dec'),
				source: 'class',
				kind: 'falconerTrade',
				prompt: 'Falconer: you may do one Spirit Augment trade from any location.',
				expiresAt: 'benefits',
				options: [
					{ id: 'no', label: 'No trade this round' },
					...trades.map((t) => ({
						id: tradeId(t),
						label: `${t.location}: pay ${costLabel(t)} → ${t.augment.name} augment`
					}))
				]
			});
			log.push('Decision: Falconer — one Spirit Augment trade from any location?');
		}
	}
];

export const decisions: ClassDecisions = {
	// The doubling itself is applied by the reducer (it discards a spirit); see FALCONER_DOUBLE_KIND.
	falconerDouble() {},
	falconerTrade(ctx, optionId) {
		if (optionId === 'no') return;
		const trade = findTrade(ctx, optionId);
		if (!trade || !affordable(ctx.player, trade)) return; // stale card
		const cost = trade.interaction.cost;
		if (!locationCostRequiresSelection(cost, ctx.player.mats)) {
			completeTrade(ctx, trade);
			return;
		}
		// Held runes of different types can pay the wildcard cost: the owner picks one.
		const wildcard = cost.find(isWildcardCost)!;
		const seen = new Set<string>();
		const options: { id: string; label: string }[] = [];
		for (const arrayIndex of eligibleCostSlots(wildcard, ctx.player.mats)) {
			const slot = ctx.player.mats[arrayIndex];
			const identity = slot.id ?? `${slot.name ?? ''}|${slot.originId ?? ''}`;
			if (seen.has(identity)) continue;
			seen.add(identity);
			options.push({
				id: `${optionId}|slot:${slot.slotIndex}`,
				label: `Discard ${slot.name ?? 'this rune'}`
			});
		}
		ctx.player.pendingDecisions.push({
			id: nextId(ctx.state.rng, 'dec'),
			source: 'class',
			kind: 'falconerPayment',
			prompt: `Falconer: which rune do you discard for the ${trade.augment.name} augment?`,
			expiresAt: 'benefits',
			options
		});
		ctx.log.push('Decision: Falconer — choose the rune to discard.');
	},

	falconerPayment(ctx, optionId) {
		const cut = optionId.lastIndexOf('|slot:');
		if (cut < 0) return;
		const trade = findTrade(ctx, optionId.slice(0, cut));
		const slotIndex = Number(optionId.slice(cut + '|slot:'.length));
		const arrayIndex = ctx.player.mats.findIndex((m) => m.slotIndex === slotIndex && m.hasRune);
		if (!trade || arrayIndex < 0) return; // stale card
		completeTrade(ctx, trade, [arrayIndex]);
	}
};

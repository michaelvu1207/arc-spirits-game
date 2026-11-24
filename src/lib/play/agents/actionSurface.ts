/**
 * The agent's legal action surface: every choice a human seat has at this moment.
 *
 * It REUSES the ML enumerator (`ml/actions.ts` `enumerateCandidates`) and the reducer as the
 * legality oracle (`canApply`, then a dry-run `applyGameCommand`), and adds the choices the
 * bots leave to autopilots or skip:
 *
 *   - Navigation Powers: the starting / bought power draft, every option of a power offer, a
 *     trade answer, a power committed with the destination lock, one-for-one trade proposals
 *     (the bots take the first draft card and decline everything — `getPowerAutoCommand`);
 *   - Abyss monster cards: which deck to draw from and which revealed card to keep (the bots use
 *     `bots/monsterCardAutopilot.ts`);
 *   - decision cards in EVERY phase (Rider and Falconer cards appear in the Location phase; the
 *     ML surface only offers `resolveDecision` in the Awakening phase), with the dice picker
 *     expanded (Sentinel, Arcane Alchemist);
 *   - augment placement in every phase (the reducer allows it; the ML surface only offers it in
 *     Awakening);
 *   - every "or" option of a location row (the ML surface stops at 3) and only the variants that
 *     change the outcome (out-of-range `choices` silently mean option 0 in the reducer);
 *   - monster rewards as one claim per distinct rune choice (a kill grants every reward, so the
 *     ML `picks` subsets are all the same move);
 *   - Cursed Spirit "Corrupt" rune picks (the ML surface always takes the first rune).
 *
 * Nothing here changes rules: every command still goes through the reducer.
 */

import { augmentClassChoices } from '../augments';
import { actionIdForCommand } from '../bots/contract';
import { decisionPickerSpec } from '../decisionPicker';
import { awakenedClassCounts } from '../effects/apply';
import { canApply } from '../legality';
import {
	buildLocationInteractions,
	eligibleCostSlots,
	isWildcardCost,
	originRuneOptions
} from '../locationInteractions';
import { enumerateCandidates } from '../ml/actions';
import { buildMonsterRewards } from '../monsterRewards';
import { isNavigationPowerRune } from '../navigationPowers';
import { getPowerAutoCommand } from '../navigationPowerProgress';
import { applyGameCommand } from '../runtime';
import { botActorFor } from '../server/botPolicy';
import { ruleValue } from '../rules';
import {
	ALL_DESTINATIONS,
	DICE_TIER_ORDER,
	MAX_SPIRITS,
	type GameCommand,
	type PendingDecision,
	type PlayCatalog,
	type PrivatePlayerState,
	type PublicGameState,
	type SeatColor
} from '../types';

/** Upper bound of offered actions for one decision (a dice picker can be large). */
export const MAX_OFFERED_ACTIONS = 96;
const MAX_TRADE_PROPOSALS = 40;
const MAX_CHOICE_VECTORS = 24;

/** Types the agent surface regenerates itself; the ML candidates of these types are dropped. */
const REGENERATED = new Set<GameCommand['type']>([
	'resolveLocationInteraction',
	'resolveMonsterReward',
	'resolveAwakenReward',
	'resolveDecision',
	'placeAugmentOnSpirit',
	'discardUnplacedAugments',
	'unlockNavigation'
]);

export interface SurfaceResult {
	commands: GameCommand[];
	/** True when the list was cut at {@link MAX_OFFERED_ACTIONS}. */
	truncated: boolean;
	/** True while a Navigation Power prompt blocks every other action of this seat. */
	powerPrompt: boolean;
}

function product<T>(lists: T[][], limit: number): T[][] {
	let out: T[][] = [[]];
	for (const list of lists) {
		const next: T[][] = [];
		for (const prefix of out) {
			for (const item of list) {
				next.push([...prefix, item]);
				if (next.length >= limit) break;
			}
			if (next.length >= limit) break;
		}
		out = next;
	}
	return out;
}

function combinations<T>(items: readonly T[], count: number, limit = 512): T[][] {
	if (count <= 0) return [[]];
	if (count > items.length) return [];
	const out: T[][] = [];
	const chosen: T[] = [];
	const visit = (start: number): void => {
		if (out.length >= limit) return;
		if (chosen.length === count) {
			out.push([...chosen]);
			return;
		}
		for (let i = start; i <= items.length - (count - chosen.length); i += 1) {
			chosen.push(items[i]);
			visit(i + 1);
			chosen.pop();
			if (out.length >= limit) return;
		}
	};
	visit(0);
	return out;
}

/** Multisets of size `count` over `n` choices (non-decreasing index vectors). */
function multisets(n: number, count: number, limit = MAX_CHOICE_VECTORS): number[][] {
	const out: number[][] = [];
	const walk = (start: number, acc: number[]): void => {
		if (out.length >= limit) return;
		if (acc.length === count) {
			out.push([...acc]);
			return;
		}
		for (let i = start; i < n; i++) walk(i, [...acc, i]);
	};
	walk(0, []);
	return out;
}

// ── Navigation Powers ─────────────────────────────────────────────────────────

function powerPromptCommands(state: PublicGameState, seat: SeatColor): GameCommand[] {
	const me = state.players[seat];
	if (!me) return [];
	const out: GameCommand[] = [];
	const mandatory = (me.navigationPowerOffers ?? []).filter((offer) => offer.mandatory);
	const offers = mandatory.length ? mandatory : (me.navigationPowerOffers ?? []);
	for (const offer of offers) {
		for (const option of offer.options) {
			out.push({ type: 'resolveNavigationPower', offerId: offer.id, optionId: option.id });
		}
	}
	if (out.length) return out;
	const trade = me.pendingNavigationTrade;
	if (trade?.toSeat === seat) {
		out.push({ type: 'respondNavigationPowerTrade', tradeId: trade.id, accept: true });
		out.push({ type: 'respondNavigationPowerTrade', tradeId: trade.id, accept: false });
		return out;
	}
	const draft = me.pendingPowerDrafts?.[0] ?? [];
	for (const powerId of draft) {
		if (me.pendingPowerReplacement) {
			for (const replacePowerId of me.powerInventory ?? []) {
				if (replacePowerId !== powerId)
					out.push({ type: 'chooseNavigationPower', powerId, replacePowerId });
			}
		} else {
			out.push({ type: 'chooseNavigationPower', powerId });
		}
	}
	return out;
}

/** One-for-one Shared Current proposals to each co-located player (spirit or rune each side). */
function tradeProposals(state: PublicGameState, seat: SeatColor): GameCommand[] {
	const me = state.players[seat];
	if (!me?.navigationPowerTradeEnabled || state.phase !== 'location' || me.pendingNavigationTrade)
		return [];
	const out: GameCommand[] = [];
	const mySpirits = me.spirits.map((s) => s.slotIndex);
	const myRunes = me.mats.filter((m) => isNavigationPowerRune(m)).map((m) => m.slotIndex);
	for (const target of state.activeSeats) {
		if (target === seat) continue;
		const them = state.players[target];
		if (
			!them ||
			them.navigationDestination !== me.navigationDestination ||
			them.pendingNavigationTrade
		)
			continue;
		const theirSpirits = them.spirits.map((s) => s.slotIndex);
		const theirRunes = them.mats.filter((m) => isNavigationPowerRune(m)).map((m) => m.slotIndex);
		const gives = [
			...mySpirits.map((slot) => ({ giveSpiritSlots: [slot], giveRuneSlots: [] as number[] })),
			...myRunes.map((slot) => ({ giveSpiritSlots: [] as number[], giveRuneSlots: [slot] }))
		];
		const receives = [
			...theirSpirits.map((slot) => ({
				receiveSpiritSlots: [slot],
				receiveRuneSlots: [] as number[]
			})),
			...theirRunes.map((slot) => ({
				receiveSpiritSlots: [] as number[],
				receiveRuneSlots: [slot]
			}))
		];
		for (const give of gives) {
			for (const receive of receives) {
				out.push({ type: 'tradeNavigationPower', targetSeat: target, ...give, ...receive });
				if (out.length >= MAX_TRADE_PROPOSALS) return out;
			}
		}
	}
	return out;
}

// ── Location rows, monster cards and rewards ─────────────────────────────────

/** Every variant (or-choices × wildcard payments) of every row at the seat's location. */
export function locationRowCommands(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog
): GameCommand[] {
	const me = state.players[seat];
	const dest = me?.navigationDestination;
	if (!me || !dest || state.phase !== 'location') return [];
	const rows = catalog.locations?.find((l) => l.name === dest)?.rewardRows;
	const out: GameCommand[] = [];
	for (const interaction of buildLocationInteractions(rows, dest)) {
		const orGains = interaction.gains.filter((g) => g.type === 'chooseRune');
		const choiceVectors = product(
			orGains.map((g) => (g.type === 'chooseRune' ? g.options.map((_, i) => i) : [0])),
			MAX_CHOICE_VECTORS
		);
		const wildcards = interaction.cost.filter(isWildcardCost);
		let costVectors: (number[] | undefined)[] = [undefined];
		if (wildcards.length > 0) {
			const eligible = [...new Set(wildcards.flatMap((req) => eligibleCostSlots(req, me.mats)))];
			// Two slots holding the same rune are the same payment: keep one per identity set.
			const seen = new Set<string>();
			const picks: number[][] = [];
			for (const combo of combinations(eligible, wildcards.length)) {
				const key = combo
					.map((i) => me.mats[i]?.id ?? me.mats[i]?.name ?? String(i))
					.sort()
					.join('|');
				if (seen.has(key)) continue;
				seen.add(key);
				picks.push(combo);
			}
			if (picks.length > 0) costVectors = picks;
		}
		for (const choices of choiceVectors) {
			for (const costChoices of costVectors) {
				out.push({
					type: 'resolveLocationInteraction',
					rowIndex: interaction.rowIndex,
					...(choices.length ? { choices } : {}),
					...(costChoices ? { costChoices } : {})
				});
			}
		}
	}
	return out;
}

function monsterCardCommands(state: PublicGameState, seat: SeatColor): GameCommand[] {
	const me = state.players[seat];
	if (!me || state.phase !== 'location' || me.navigationDestination !== 'Arcane Abyss') return [];
	const reveal = me.pendingMonsterDraw?.cards ?? [];
	// Rule `monsterDrawOne` (one card is revealed): keep it, keep it and put a held card back on top
	// of its deck, or put it back on top. A full hand can only swap or put back.
	if (reveal.length > 0 && me.pendingMonsterDraw?.maxCards === 1) {
		const hand = me.monsterHand ?? [];
		return [
			...(hand.length < 3 ? [{ type: 'keepMonsterCard', index: 0 } as GameCommand] : []),
			...hand.map((_, replaceHandIndex): GameCommand => ({ type: 'keepMonsterCard', index: 0, replaceHandIndex })),
			{ type: 'keepMonsterCard', index: 0, returnToDeck: true }
		];
	}
	if (reveal.length > 0) return reveal.map((_, index) => ({ type: 'keepMonsterCard', index }));
	const draws: GameCommand[] = ([1, 2, 3] as const).map((difficulty) => ({ type: 'drawMonsterCards', difficulty }));
	// The permanent monster (when the game has one): take a copy instead of drawing from a deck.
	if (state.permanentMonster) draws.push({ type: 'drawMonsterCards', difficulty: 1, permanent: true });
	return draws;
}

function monsterRewardCommands(me: PrivatePlayerState): GameCommand[] {
	const pending = me.pendingReward;
	if (!pending) return [];
	const options = buildMonsterRewards(pending.rewardTrack);
	const picks = options.map((o) => o.index);
	const runeChoices = options
		.filter((o) => o.effect.type === 'chooseRune')
		.map((o) => (o.effect.type === 'chooseRune' ? o.effect.options.map((_, i) => i) : [0]));
	// Rule `permanentRewardChoice`: one command for each reward the player may take.
	const claims: GameCommand[] = pending.chooseOne
		? options.flatMap((o): GameCommand[] =>
				o.effect.type === 'chooseRune'
					? o.effect.options.map((_, i) => ({ type: 'resolveMonsterReward', picks: [o.index], choices: [i] }))
					: [{ type: 'resolveMonsterReward', picks: [o.index] }]
			)
		: product(runeChoices, MAX_CHOICE_VECTORS).map((choices) => ({
				type: 'resolveMonsterReward',
				picks,
				...(choices.length ? { choices } : {})
			}));
	// Rule `arcaneBlood`: the Arcane Blood in place of every reward. Offered when it does something
	// for this player (today: Elementalist 2 or more, which upgrades a die per Arcane Blood).
	if (pending.arcaneBlood && (awakenedClassCounts(me)['Elementalist'] ?? 0) >= 2)
		claims.push({ type: 'resolveMonsterReward', picks: [], arcaneBlood: true });
	return claims;
}

function awakenRewardCommands(me: PrivatePlayerState, state: PublicGameState): GameCommand[] {
	if (state.phase !== 'benefits' || !me.pendingAwakenReward) return [];
	const grants = me.pendingAwakenReward.grants ?? [];
	const amountOf = (kind: string) =>
		(grants.find((g) => g.kind === kind) as { amount: number } | undefined)?.amount;
	const tainted = amountOf('taintedChoice');
	const corrupt = amountOf('corruptChoice');
	const fallen = amountOf('fallenChoice');
	const range = (n: number | undefined) =>
		n === undefined ? [undefined] : Array.from({ length: n + 1 }, (_, i) => i);
	const runeCount = originRuneOptions().length;
	const splits: GameCommand[] = [];
	const variants: GameCommand[] = [];
	for (const taintedMaxBarrier of range(tainted)) {
		for (const corruptMaxBarrier of range(corrupt)) {
			for (const fallenMaxBarrier of range(fallen)) {
				const runes = corrupt === undefined ? 0 : corrupt - (corruptMaxBarrier ?? 0);
				const pickSets = runes > 0 ? multisets(runeCount, runes) : [[]];
				// Every split first (with the first rune pick), then the other rune picks, so a
				// cut list still has every Max-Barrier split.
				pickSets.forEach((corruptRunePicks, variant) => {
					(variant === 0 ? splits : variants).push({
						type: 'resolveAwakenReward',
						...(taintedMaxBarrier === undefined ? {} : { taintedMaxBarrier }),
						...(corruptMaxBarrier === undefined ? {} : { corruptMaxBarrier }),
						...(corruptRunePicks.length ? { corruptRunePicks } : {}),
						...(fallenMaxBarrier === undefined ? {} : { fallenMaxBarrier })
					});
				});
			}
		}
	}
	return [...splits, ...variants];
}

/**
 * Replace-on-summon (rule `summonReplaceWhenFull`): with every spirit slot full, each drawn spirit
 * can be summoned in place of each of the seat's spirits. Board spirits that are the same card in
 * the same state (face-down or awake, same augment) are one choice.
 */
function replaceSummonCommands(me: PrivatePlayerState, catalog: PlayCatalog): GameCommand[] {
	if (!ruleValue(catalog, 'summonReplaceWhenFull')) return [];
	if (!me.pendingDraw || !me.handDraws?.length || me.spirits.length < MAX_SPIRITS) return [];
	const seen = new Set<string>();
	const slots: number[] = [];
	for (const spirit of [...me.spirits].sort((a, b) => a.slotIndex - b.slotIndex)) {
		const augments = (me.spiritAugmentAttachments ?? [])
			.filter((a) => a.spiritSlotIndex === spirit.slotIndex)
			.map((a) => a.className ?? '?')
			.sort()
			.join(',');
		const key = `${spirit.id}|${spirit.isFaceDown}|${augments}`;
		if (seen.has(key)) continue;
		seen.add(key);
		slots.push(spirit.slotIndex);
	}
	const out: GameCommand[] = [];
	for (const draw of me.handDraws) {
		if (!draw.id || draw.rewardId) continue;
		for (const replaceSlotIndex of slots)
			out.push({ type: 'spawnHandSpirit', guid: draw.guid, replaceSlotIndex });
	}
	return out;
}

// ── Decision cards and augments (every phase) ────────────────────────────────

function decisionCommands(me: PrivatePlayerState, decision: PendingDecision): GameCommand[] {
	const picker = decisionPickerSpec(decision, me);
	const out: GameCommand[] = [];
	for (const option of decision.options) {
		if (!picker || option.id !== 'yes') {
			out.push({ type: 'resolveDecision', decisionId: decision.id, optionId: option.id });
			continue;
		}
		// Dice picker: one action per distinct tier multiset (same-tier dice are interchangeable).
		const tierById = new Map(me.attackDice.map((die) => [die.instanceId, die.tier] as const));
		const eligible = [...picker.eligibleInstanceIds].sort(
			(a, b) =>
				DICE_TIER_ORDER.indexOf(tierById.get(a) ?? 'basic') -
				DICE_TIER_ORDER.indexOf(tierById.get(b) ?? 'basic')
		);
		const sizes =
			picker.minCount != null
				? Array.from({ length: picker.count - picker.minCount + 1 }, (_, i) => picker.minCount! + i)
				: [picker.count];
		const seen = new Set<string>();
		for (const size of sizes) {
			for (const ids of combinations(eligible, size, 4096)) {
				const key = ids.map((id) => tierById.get(id) ?? '?').join('|');
				if (seen.has(key)) continue;
				seen.add(key);
				out.push({
					type: 'resolveDecision',
					decisionId: decision.id,
					optionId: option.id,
					selectedInstanceIds: ids
				});
			}
		}
	}
	return out;
}

function augmentCommands(me: PrivatePlayerState, catalog: PlayCatalog): GameCommand[] {
	const out: GameCommand[] = [];
	const augments = me.unplacedAugments ?? [];
	// Identical augments (same item and class) are the same choice: offer the first one only.
	const seenAugments = new Set<string>();
	augments.forEach((augment, augmentIndex) => {
		// runeId is an instance id for generic augments (only a staleness check on placement).
		const identity = `${augment.classId ?? ''}|${augment.name}|${augment.boundSlotIndex ?? ''}|${augment.hostClass ?? ''}`;
		if (seenAugments.has(identity)) return;
		seenAugments.add(identity);
		for (const spirit of me.spirits) {
			for (const className of augmentClassChoices(augment, catalog)) {
				out.push({
					type: 'placeAugmentOnSpirit',
					augmentIndex,
					augmentRuneId: augment.runeId,
					spiritSlotIndex: spirit.slotIndex,
					className
				});
			}
		}
	});
	if (augments.length > 0) out.push({ type: 'discardUnplacedAugments' });
	return out;
}

// ── Assembly ─────────────────────────────────────────────────────────────────

/** Candidate commands (not yet legality-filtered), in a fixed deterministic order. */
export function agentCandidates(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog
): { candidates: GameCommand[]; powerPrompt: boolean } {
	const me = state.players[seat];
	if (!me || state.status !== 'active') return { candidates: [], powerPrompt: false };
	if (getPowerAutoCommand(state, seat)) {
		const prompt = powerPromptCommands(state, seat);
		if (prompt.length > 0) return { candidates: prompt, powerPrompt: true };
	}
	const out: GameCommand[] = [];
	// Decision cards first: they are the "answer this card" prompts. Augment placements (which
	// can be many) come after the other actions.
	for (const decision of me.pendingDecisions ?? []) out.push(...decisionCommands(me, decision));
	if (state.phase === 'location') {
		out.push(...monsterCardCommands(state, seat));
		out.push(...monsterRewardCommands(me));
		out.push(...locationRowCommands(state, seat, catalog));
	}
	out.push(...awakenRewardCommands(me, state));
	enumerateCandidates(state, seat, catalog, (cmd) => {
		if (!REGENERATED.has(cmd.type)) out.push(cmd);
	});
	out.push(...replaceSummonCommands(me, catalog));
	if (state.phase === 'navigation') {
		for (const powerId of me.powerInventory ?? []) {
			for (const destination of ALL_DESTINATIONS) {
				out.push({ type: 'lockNavigation', destination, navigationPowerId: powerId });
			}
		}
	}
	out.push(...tradeProposals(state, seat));
	out.push(...augmentCommands(me, catalog));
	return { candidates: out, powerPrompt: false };
}

/** The legal, de-duplicated commands this seat may send now. */
export function agentLegalCommands(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog
): SurfaceResult {
	const { candidates, powerPrompt } = agentCandidates(state, seat, catalog);
	const actor = botActorFor(state, seat);
	const seen = new Set<string>();
	const legal: GameCommand[] = [];
	for (const cmd of candidates) {
		const key = actionIdForCommand(cmd);
		if (seen.has(key)) continue;
		seen.add(key);
		const verdict = canApply(state, actor, cmd, catalog);
		if (verdict === false) continue;
		if (verdict === undefined && !applyGameCommand(state, actor, cmd, catalog).ok) continue;
		legal.push(cmd);
	}
	if (legal.length <= MAX_OFFERED_ACTIONS)
		return { commands: legal, truncated: false, powerPrompt };
	return { commands: fairCut(legal, MAX_OFFERED_ACTIONS), truncated: true, powerPrompt };
}

/**
 * Cut a long list without losing a KIND of move: every yield is kept, then command types (each
 * decision-card option separately) take turns, in order of first appearance, until the limit.
 * The original order is kept.
 */
export function fairCut(commands: GameCommand[], limit: number): GameCommand[] {
	const keep = new Set<number>();
	commands.forEach((cmd, i) => {
		if (isYieldCommand(cmd)) keep.add(i);
	});
	const byType = new Map<string, number[]>();
	commands.forEach((cmd, i) => {
		if (keep.has(i)) return;
		// Each decision-card option is its own group, so "Discard nothing" survives a long picker.
		const key =
			cmd.type === 'resolveDecision' ? `${cmd.type}:${cmd.decisionId}:${cmd.optionId}` : cmd.type;
		const list = byType.get(key) ?? [];
		list.push(i);
		byType.set(key, list);
	});
	const queues = [...byType.values()];
	for (let round = 0; keep.size < limit && queues.some((q) => q.length > round); round++) {
		for (const queue of queues) {
			if (keep.size >= limit) break;
			if (round < queue.length) keep.add(queue[round]);
		}
	}
	return commands.filter((_, i) => keep.has(i));
}

export const YIELD_TYPES = new Set<GameCommand['type']>([
	'endLocationActions',
	'commitBenefits',
	'commitAwakening',
	'commitCleanup',
	'passEncounter'
]);

export function isYieldCommand(cmd: GameCommand): boolean {
	return YIELD_TYPES.has(cmd.type);
}

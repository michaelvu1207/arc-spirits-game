/**
 * Plain-language labels for agent actions, written from the acting seat's point of view.
 * Labels only read what the acting seat may know (its own private state and public state).
 */

import { buildLocationInteractions, originRuneOptions, type GainEffect, type LocationInteraction, isAbyssSummonRow, monsterFightsLeft, ABYSS_SUMMON_USED } from '../locationInteractions';
import { buildMonsterRewards } from '../monsterRewards';
import { ARCANE_ABYSS_BAG } from '../bags';
import { navigationPowerById } from '../navigationPowers';
import { MONSTER_DECK_NAMES } from '../runtime';
import { RUNE_CARRY_LIMIT, SPIRIT_WORLD_ONLY, type GameCommand, type MonsterDeckSummary, type MonsterState, type PlayCatalog, type PlayerProjection, type PlaySpirit, type PrivatePlayerState, type SeatColor } from '../types';
import { awakenedClassCounts, cultivateRuneMultiplier } from '../effects/apply';
import { ORIGIN_REWARDS, spiritsByOrigin } from '../effects/relicTools';
import { pvpVpPerCorrupted } from '../combat';
import { CURSED_SPIRIT_DICE_TIER } from '../rules';

/** Anything with per-seat player records: the full state or a seat's projection. Labels are
 *  always built from the ACTING seat's projection, so they cannot read hidden fields. */
export type SeatPlayer = PrivatePlayerState | PlayerProjection;
export interface ViewLike {
	players: Partial<Record<SeatColor, SeatPlayer>>;
	/** Public deck summaries (the projection carries them). */
	monsterDecks?: MonsterDeckSummary[];
	/** The permanent monster, when the game has one. */
	permanentMonster?: MonsterState;
}

/** A rune / augment / relic as a player names it. */
export function itemName(item: { name: string; type?: string }): string {
	if (item.type === 'augment')
		return /augment/i.test(item.name) ? item.name : `${item.name} Spirit Augment`;
	if (item.type === 'relic') return /relic/i.test(item.name) ? item.name : `${item.name} relic`;
	return item.name;
}

export function gainLabel(gain: GainEffect, choice?: number): string {
	switch (gain.type) {
		case 'navigationPower':
			return gain.replace ? 'replace one of your Powers (draw 3, keep 1)' : 'gain 1 random Power';
		case 'action':
			return (
				{
					rest: 'Rest',
					cultivate: 'Cultivate',
					spiritWorldSummon: 'Spirit World Summon',
					abyssSummon: 'Arcane Abyss Summon'
				} as const
			)[gain.action];
		case 'gainMaxBarrier':
			return `gain ${gain.amount} Max Barrier`;
		case 'restoreBarrier':
			return `restore ${gain.amount} Barrier`;
		case 'rune':
			return `gain ${itemName(gain.rune)}`;
		case 'vp':
			return `${gain.amount} VP`;
		case 'attackDice':
			return `${gain.amount} ${cap(gain.tier)} Attack Dice`;
		case 'chooseRune': {
			const chosen = gain.options[choice ?? 0] ?? gain.options[0];
			return `gain ${chosen ? itemName(chosen) : 'a rune'}`;
		}
	}
}

export function cap(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export function interactionsAt(catalog: PlayCatalog, destination: string): LocationInteraction[] {
	const rows = catalog.locations?.find((l) => l.name === destination)?.rewardRows;
	return buildLocationInteractions(rows, destination);
}

/** "Rest" / "pay any basic rune: gain Fighter augment or …" — one location action, all options. */
export function interactionSummary(interaction: LocationInteraction): string {
	const gains = interaction.gains
		.map((g) =>
			g.type === 'chooseRune' ? `one of: ${g.options.map(itemName).join(' / ')}` : gainLabel(g)
		)
		.join(' + ');
	const cost = interaction.cost.map((c) => c.label).join(' + ');
	return cost ? `pay ${cost} → ${gains}` : gains;
}

export function spiritLine(spirit: {
	name: string;
	cost?: number;
	classes?: Record<string, number>;
	origins?: Record<string, number>;
}): string {
	const origins = Object.keys(spirit.origins ?? {}).join('/') || 'no origin';
	const classes = Object.entries(spirit.classes ?? {})
		.map(([name, n]) => (n > 1 ? `${name}×${n}` : name))
		.join(', ');
	return `${spirit.name} (cost ${spirit.cost ?? '?'}, ${origins}${classes ? `; ${classes}` : ''})`;
}

/**
 * In Michael's wording (2026-11-27: "worded as using a battle action"): a fight and the
 * Arcane Abyss Summon action each use a battle action. `summon`: the note of the summon action, else of a fight.
 */
function battleActionNote(me: { actionsUsedThisRound?: string[]; extraActions?: Record<string, number> } | null | undefined, catalog: PlayCatalog, summon: boolean): string {
	if (!me || !interactionsAt(catalog, 'Arcane Abyss').some(isAbyssSummonRow)) return '';
	const taken = (me.actionsUsedThisRound ?? []).includes(ABYSS_SUMMON_USED);
	// A second run of the summon action in one round (a doubled location action) uses no further battle action.
	if (summon && taken) return '';
	const after = monsterFightsLeft(me, true) - 1;
	if (after > 0) return `uses 1 battle action: ${after} left after it`;
	return summon
		? 'uses your battle action: you cannot fight this round after it'
		: taken
			? 'uses your last battle action'
			: 'uses your battle action: no Arcane Abyss Summon action this round after it';
}

export function monsterLine(card: MonsterState): string {
	const rewards = buildMonsterRewards(card.rewardTrack)
		.map((r) => r.label)
		.join(', ');
	return `${card.name} [Difficulty ${card.difficulty ?? '?'}; Barrier ${card.hp}/${card.maxHp}; deals ${card.damage}${typeof card.initiative === 'number' ? `; initiative ${card.initiative}` : ''}${card.restoreAfterCombat ? `; ability: restores ${card.restoreAfterCombat} Barrier after a fight it survives` : ''}; rewards: ${rewards || 'none'}]`;
}

function spiritBySlot(me: SeatPlayer | undefined, slot: number): PlaySpirit | undefined {
	return me?.spirits.find((s) => s.slotIndex === slot);
}

function runeName(me: SeatPlayer | undefined, slotIndex: number): string {
	return me?.mats.find((m) => m.slotIndex === slotIndex)?.name ?? `rune slot ${slotIndex}`;
}

function diceTiers(me: SeatPlayer | undefined, ids: string[] | undefined): string {
	const counts: Record<string, number> = {};
	for (const id of ids ?? []) {
		const tier = me?.attackDice.find((d) => d.instanceId === id)?.tier ?? '?';
		counts[tier] = (counts[tier] ?? 0) + 1;
	}
	return Object.entries(counts)
		.map(([tier, n]) => `${n} ${tier}`)
		.join(' + ');
}

/** Runes/relics a gain puts on the mat (augments with a class go to the to-place pouch). */
function matItemsGained(
	me: SeatPlayer | undefined,
	gain: GainEffect,
	choice?: number,
	catalog?: PlayCatalog
): number {
	const onMat = (r?: { type?: string; classId?: string | null }) =>
		r && !(r.type === 'augment' && r.classId) ? 1 : 0;
	if (gain.type === 'rune') return onMat(gain.rune);
	if (gain.type === 'chooseRune') return onMat(gain.options[choice ?? 0] ?? gain.options[0]);
	if (gain.type === 'action' && gain.action === 'cultivate' && me) {
		// applyCultivate: per origin, runeAt+ spirits → 1 rune (×2 with doubleRunes); relicAt+ → relic once.
		const counts = spiritsByOrigin(me.spirits);
		const mult = cultivateRuneMultiplier(me as PrivatePlayerState, catalog);
		let n = 0;
		for (const [origin, r] of Object.entries(ORIGIN_REWARDS)) {
			const c = counts[origin] ?? 0;
			if (c >= r.runeAt) n += mult;
		}
		return n;
	}
	return 0;
}

/** "Cultivate (now: 1 Fire Region rune; adds no spirits)" — what applyCultivate gives this seat now. */
function cultivateLabel(me: SeatPlayer | undefined, catalog?: PlayCatalog): string {
	if (!me) return 'Cultivate';
	const counts = spiritsByOrigin(me.spirits);
	const mult = cultivateRuneMultiplier(me as PrivatePlayerState, catalog);
	const parts: string[] = [];
	for (const [origin, r] of Object.entries(ORIGIN_REWARDS)) {
		const c = counts[origin] ?? 0;
		const runes = mult === 2 ? `2 ${origin} runes` : `${origin} rune`;
		const relicOpen = c >= r.relicAt && !(me.originRelicsGained ?? []).includes(origin);
		if (c >= r.runeAt) parts.push(relicOpen ? `${runes} or the ${origin} relic (you choose one)` : runes);
	}
	return `Cultivate (now: ${parts.join(' + ') || 'no origin reward'}, plus On Cultivate class effects; adds no spirits)`;
}

/** " — over the carry limit …" when the gain would leave more than RUNE_CARRY_LIMIT items held. */
export function carryWarning(me: SeatPlayer | undefined, gained: number, paid = 0): string {
	if (!me || gained <= 0) return '';
	const after = (me.mats ?? []).filter((m) => m.hasRune).length - paid + gained;
	if (after <= RUNE_CARRY_LIMIT) return '';
	return ` — OVER THE CARRY LIMIT: you would hold ${after} runes/relics; ${after - RUNE_CARRY_LIMIT} must be discarded at Cleanup unless you spend them first`;
}

/** The label the ACTING seat sees for one of its own legal commands. */
export function labelFor(
	cmd: GameCommand,
	state: ViewLike,
	seat: SeatColor,
	catalog: PlayCatalog
): string {
	const me = state.players[seat];
	switch (cmd.type) {
		case 'lockNavigation': {
			const where =
				cmd.destination === 'Arcane Abyss'
					? 'Arcane Abyss (monsters; Evil players hunt here too)'
					: cmd.destination;
			const power = cmd.navigationPowerId ? navigationPowerById(cmd.navigationPowerId) : null;
			return `Go to ${where}${power ? ` and commit your Power "${power.name}"` : ''}`;
		}
		case 'chooseNavigationPower': {
			const power = navigationPowerById(cmd.powerId, catalog);
			const replaced = cmd.replacePowerId ? navigationPowerById(cmd.replacePowerId) : null;
			return `Keep Power "${power?.name ?? cmd.powerId}": ${power?.text ?? ''}${replaced ? ` (replaces your "${replaced.name}")` : ''}`;
		}
		case 'resolveNavigationPower': {
			const offer = me?.navigationPowerOffers?.find((o) => o.id === cmd.offerId);
			const option = offer?.options.find((o) => o.id === cmd.optionId);
			const power = offer ? navigationPowerById(offer.powerId)?.name : null;
			return `${power ? `Power "${power}": ` : ''}${offer?.prompt ?? 'Power'} → ${option?.label ?? cmd.optionId}`;
		}
		case 'respondNavigationPowerTrade': {
			const t = me?.pendingNavigationTrade;
			const from = t ? state.players[t.fromSeat] : undefined;
			const theirs = [
				...(t?.giveSpiritSlots ?? []).map((s) => spiritBySlot(from, s)?.name ?? `spirit ${s}`),
				...(t?.giveRuneSlots ?? []).map((s) => runeName(from, s))
			].join(', ');
			const mine = [
				...(t?.receiveSpiritSlots ?? []).map((s) => spiritBySlot(me, s)?.name ?? `spirit ${s}`),
				...(t?.receiveRuneSlots ?? []).map((s) => runeName(me, s))
			].join(', ');
			return `${cmd.accept ? 'Accept' : 'Decline'} the trade from ${t?.fromSeat ?? '?'}: you get ${theirs || 'nothing'}, you give ${mine || 'nothing'}`;
		}
		case 'tradeNavigationPower': {
			const them = state.players[cmd.targetSeat];
			const give = [
				...(cmd.giveSpiritSlots ?? []).map((s) => spiritBySlot(me, s)?.name ?? `spirit ${s}`),
				...(cmd.giveRuneSlots ?? []).map((s) => runeName(me, s))
			].join(', ');
			const get = [
				...(cmd.receiveSpiritSlots ?? []).map((s) => spiritBySlot(them, s)?.name ?? `spirit ${s}`),
				...(cmd.receiveRuneSlots ?? []).map((s) => runeName(them, s))
			].join(', ');
			return `Shared Current: offer ${cmd.targetSeat} your ${give} for their ${get} (they must accept)`;
		}
		case 'initiatePvp': {
			const pay = `: you get ${pvpVpPerCorrupted(catalog)} VP per Good player corrupted, nothing otherwise`;
			return `Attack the Good players at your location (PvP group attack${pay})`;
		}
		case 'passEncounter':
			return 'Do not attack this round (pass the encounter)';
		case 'resolveLocationInteraction': {
			const dest = me?.navigationDestination ?? '';
			const interaction = interactionsAt(catalog, dest).find((i) => i.rowIndex === cmd.rowIndex);
			if (!interaction) return `${dest} action ${cmd.rowIndex + 1}`;
			let cursor = 0;
			let items = 0;
			const gains = interaction.gains
				.map((g) => {
					const choice = g.type === 'chooseRune' ? cmd.choices?.[cursor++] : undefined;
					items += matItemsGained(me, g, choice, catalog);
					if (g.type === 'action' && g.action === 'cultivate') return cultivateLabel(me, catalog);
					return gainLabel(g, choice);
				})
				.join(' + ');
			const paid = (cmd.costChoices ?? []).map((i) => me?.mats[i]?.name ?? `slot ${i}`);
			const cost = interaction.cost.length
				? ` (pay ${paid.length ? paid.join(' + ') : interaction.cost.map((c) => c.label).join(' + ')})`
				: '';
			// The Arcane Abyss Summon action uses a battle action.
			const summonNote = dest === 'Arcane Abyss' && isAbyssSummonRow(interaction) ? battleActionNote(me, catalog, true) : '';
			const noFight = summonNote ? ` (${summonNote})` : '';
			return `${dest} action ${cmd.rowIndex + 1}: ${gains}${cost}${noFight}${carryWarning(me, items, interaction.cost.length)}`;
		}
		case 'spawnHandSpirit': {
			const draw = me?.handDraws.find((d) => d.guid === cmd.guid);
			if (draw?.rewardId)
				return `Take the reward hex: ${draw.rewardLabel ?? draw.name ?? 'reward'} (counts as one summon; no spirit enters)${carryWarning(me, draw.rewardId.endsWith('-rune') ? 1 : 0)}`;
			const spirit = catalog.spirits.find((s) => s.id === draw?.id);
			const summoned = spirit ? spiritLine(spirit) : (draw?.name ?? 'the drawn spirit');
			const entersFaceDown = me?.pendingDraw?.sourceBag === ARCANE_ABYSS_BAG;
			if (cmd.replaceSlotIndex === undefined)
				return `Summon ${summoned} (it enters ${entersFaceDown ? 'face-down' : 'awake'})`;
			// Replace-on-summon (offered only when every spirit slot is full).
			const old = spiritBySlot(me, cmd.replaceSlotIndex);
			const augment = (me?.spiritAugmentAttachments ?? []).some(
				(a) => a.spiritSlotIndex === cmd.replaceSlotIndex
			);
			const oldName = old?.name ?? `the spirit in slot ${cmd.replaceSlotIndex}`;
			return `Summon ${summoned}, replacing ${oldName} (slot ${cmd.replaceSlotIndex}${old ? `, ${old.isFaceDown ? 'face-down' : 'awake'}` : ''}; ${oldName} is discarded back to its bag${augment ? ' and its augment is lost' : ''}) (the new spirit enters ${entersFaceDown ? 'face-down' : 'awake'})`;
		}
		case 'redrawHandDraws':
			return 'Mystic: put the drawn spirits back and draw again';
		case 'discardHandDraws':
			return 'Summon none of the drawn spirits (return them)';
		case 'drawMonsterCards': {
			if (cmd.permanent) {
				const card = state.permanentMonster;
				return `Take the permanent monster ${card ? monsterLine(card) : ''} into your hand (always available; this is your draw of this visit)`;
			}
			const deck = state.monsterDecks?.find((d) => d.difficulty === cmd.difficulty);
			const band = deck
				? `, Barrier ${deck.barrierMin}-${deck.barrierMax}, ${deck.count ?? '?'} cards left`
				: '';
			return `Draw the top card of the Difficulty ${cmd.difficulty} deck (${MONSTER_DECK_NAMES[cmd.difficulty]}${band}): you then keep it or put it back on top (this is your draw of this visit)`;
		}
		case 'keepMonsterCard': {
			const card = me?.pendingMonsterDraw?.cards[cmd.index];
			if (me?.pendingMonsterDraw?.maxCards === 1) {
				// One card is revealed.
				const shown = card ? monsterLine(card) : 'the revealed card';
				if (cmd.returnToDeck) return `Put ${shown} back on top of its deck (you keep nothing new; the next draw from that deck reveals it again)`;
				const old = cmd.replaceHandIndex === undefined ? undefined : me.monsterHand?.[cmd.replaceHandIndex];
				if (old)
					return `Keep ${shown} and give up ${monsterLine(old)}: ${old.permanent ? 'that copy of the permanent monster leaves your hand' : `it goes back on top of its deck at full Barrier${old.hp < old.maxHp ? ` (the ${old.maxHp - old.hp} damage you did to it is lost)` : ''}`}`;
				return `Keep ${shown}`;
			}
			return `Keep ${card ? monsterLine(card) : `card ${cmd.index + 1}`} (the other card goes to the bottom of its deck)`;
		}
		case 'startCombat': {
			const card = me?.monsterHand?.[cmd.handIndex];
			return `Fight ${card ? monsterLine(card) : `hand card ${cmd.handIndex + 1}`} (the monster has the initiative; you roll your initiative die: a hit means you attack at the same time, a miss means it attacks first${battleActionNote(me, catalog, false) ? `; ${battleActionNote(me, catalog, false)}` : ''})`;
		}
		case 'resolveMonsterReward': {
			const options = me?.pendingReward ? buildMonsterRewards(me.pendingReward.rewardTrack) : [];
			if (me?.pendingReward?.chooseOne) {
				const o = options.find((x) => x.index === cmd.picks?.[0]) ?? options[0];
				const choice = cmd.choices?.[0] ?? 0;
				const what = !o
					? 'none'
					: o.effect.type === 'chooseRune'
						? `${o.label}: ${itemName(o.effect.options[choice] ?? { name: '?' })}`
						: o.label;
				const others = options.filter((x) => x !== o).map((x) => x.label);
				return `Claim ONE reward of ${me.pendingReward.monsterName}: ${what} (this card gives one reward of your choice${others.length ? `; you do not get ${others.join(', ')}` : ''})${carryWarning(me, o ? matItemsGained(me, o.effect, choice, catalog) : 0)}`;
			}
			let cursor = 0;
			let items = 0;
			const parts = options.map((o) => {
				if (o.effect.type !== 'chooseRune') {
					items += matItemsGained(me, o.effect, undefined, catalog);
					return o.label;
				}
				const choice = cmd.choices?.[cursor++] ?? 0;
				items += matItemsGained(me, o.effect, choice, catalog);
				return `${o.label}: ${itemName(o.effect.options[choice] ?? { name: '?' })}`;
			});
			return `Claim every reward of ${me?.pendingReward?.monsterName ?? 'the monster'}: ${parts.join(', ') || 'none'}${carryWarning(me, items)}`;
		}
		case 'discardSpirit': {
			const spirit = spiritBySlot(me, cmd.slotIndex);
			const name = spirit
				? `${spirit.name} (slot ${spirit.slotIndex}${spirit.isFaceDown ? ', face-down' : ''})`
				: `slot ${cmd.slotIndex}`;
			if (me?.pendingCorruptionDiscard) {
				return `Sacrifice ${name} (corruption payment, ${me.pendingCorruptionDiscard.count} owed)`;
			}
			return `Discard spirit ${name}`;
		}
		case 'discardRune':
			return `Discard ${runeName(me, cmd.slotIndex)} (you may carry at most ${RUNE_CARRY_LIMIT} runes/relics)`;
		case 'infiltratorSwap':
			return `Ram swap: ${cmd.swaps
				.map((s) => {
					const mine = me?.attackDice.find((d) => d.instanceId === s.myInstanceId)?.tier ?? '?';
					const theirs =
						state.players[s.targetSeat]?.attackDice.find((d) => d.instanceId === s.theirInstanceId)
							?.tier ?? '?';
					return `your ${mine} die for ${s.targetSeat}'s ${theirs} die`;
				})
				.join('; ')}`;
		case 'endLocationActions':
			return 'End your Location turn';
		case 'commitBenefits':
			return 'Finish the Benefits step';
		case 'commitAwakening':
			return 'Finish the Awakening step';
		case 'commitCleanup':
			return 'Finish Cleanup (end of round)';
		case 'resolveAwakenReward': {
			const grants = me?.pendingAwakenReward?.grants ?? [];
			const parts: string[] = [];
			for (const g of grants) {
				if (g.kind === 'taintedChoice')
					parts.push(
						`Tainted ${g.amount}: ${cmd.taintedMaxBarrier ?? 0} Max Barrier + ${g.amount - (cmd.taintedMaxBarrier ?? 0)} ${CURSED_SPIRIT_DICE_TIER === 'basic' ? 'Basic' : 'Enchanted'} dice`
					);
				else if (g.kind === 'corruptChoice') {
					const runes = (cmd.corruptRunePicks ?? []).map((i) => runeOptionName(i));
					parts.push(
						`Corrupt ${g.amount}: ${cmd.corruptMaxBarrier ?? 0} Max Barrier + runes [${runes.join(', ') || 'none'}]`
					);
				} else if (g.kind === 'fallenChoice')
					parts.push(
						`Fallen ${g.amount}: ${cmd.fallenMaxBarrier ?? 0} Max Barrier + ${g.amount - (cmd.fallenMaxBarrier ?? 0)} Spirit Augments`
					);
				else if (g.kind === 'vp') parts.push(`${g.amount} VP (${g.source})`);
				else if (g.kind === 'attackDice') parts.push(`${g.amount} ${g.tier} dice (${g.source})`);
				else if (g.kind === 'augment') parts.push(`${g.amount} Spirit Augment (${g.source})`);
			}
			return `Claim Awakening-phase rewards: ${parts.join('; ') || 'none'}`;
		}
		case 'awakenSpirit': {
			const offer = me?.awakenOffers.find((o) => o.slotIndex === cmd.slotIndex);
			const spirit = spiritBySlot(me, cmd.slotIndex);
			const refs = (cmd.discardRefs ?? []).map((ref) => {
				if (ref.kind === 'rune') return runeName(me, ref.slotIndex);
				if (ref.kind === 'spirit')
					return spiritBySlot(me, ref.slotIndex)?.name ?? `spirit ${ref.slotIndex}`;
				if (ref.kind === 'attackDie')
					return `${me?.attackDice.find((d) => d.instanceId === ref.instanceId)?.tier ?? '?'} die`;
				return 'an augment';
			});
			const name = `${offer?.spiritName ?? spirit?.name ?? 'spirit'} (slot ${cmd.slotIndex})`;
			return refs.length
				? `Awaken ${name}: pay ${refs.join(' + ')}`
				: `Awaken ${name} — ${offer?.requirement ?? 'its cost is met'}`;
		}
		case 'manualAwaken': {
			const spirit = spiritBySlot(me, cmd.slotIndex);
			return `Awaken ${spirit?.name ?? `slot ${cmd.slotIndex}`} (its written condition is met)`;
		}
		case 'resolveDecision': {
			const decision = me?.pendingDecisions.find((d) => d.id === cmd.decisionId);
			const option = decision?.options.find((o) => o.id === cmd.optionId);
			const picked = cmd.selectedInstanceIds?.length
				? ` [dice: ${diceTiers(me, cmd.selectedInstanceIds)}]`
				: '';
			return `${decision?.prompt ?? 'Decision'} → ${option?.label ?? cmd.optionId}${picked}`;
		}
		case 'placeAugmentOnSpirit': {
			const augment = me?.unplacedAugments?.[cmd.augmentIndex];
			const spirit = spiritBySlot(me, cmd.spiritSlotIndex);
			return `Place a Spirit Augment (${cmd.className ?? augment?.name ?? 'augment'}) on ${spirit ? `${spirit.name} (slot ${spirit.slotIndex})` : `slot ${cmd.spiritSlotIndex}`}${spirit?.isFaceDown ? ' (face-down: counts once it is awake)' : ''}`;
		}
		case 'discardUnplacedAugments':
			return 'Throw away all Spirit Augments you have not placed';
		case 'dismissManualPrompt': {
			const prompt = me?.manualPrompts.find((p) => p.id === cmd.id);
			return `Dismiss the note: ${prompt?.text ?? cmd.id}`;
		}
		default:
			return cmd.type;
	}
}

function runeOptionName(index: number): string {
	return originRuneOptions()[index]?.name ?? `rune ${index}`;
}

/** Coarse group for metrics and prompt grouping. */
export function groupFor(cmd: GameCommand): string {
	switch (cmd.type) {
		case 'lockNavigation':
			return 'move';
		case 'chooseNavigationPower':
		case 'resolveNavigationPower':
		case 'respondNavigationPowerTrade':
		case 'tradeNavigationPower':
			return 'power';
		case 'initiatePvp':
			return 'attack';
		case 'resolveLocationInteraction':
			return 'location';
		case 'spawnHandSpirit':
		case 'redrawHandDraws':
		case 'discardHandDraws':
			return 'summon';
		case 'drawMonsterCards':
		case 'keepMonsterCard':
			return 'monster-card';
		case 'startCombat':
			return 'fight';
		case 'resolveMonsterReward':
		case 'resolveAwakenReward':
			return 'reward';
		case 'awakenSpirit':
		case 'manualAwaken':
			return 'awaken';
		case 'resolveDecision':
			return 'decision';
		case 'placeAugmentOnSpirit':
		case 'discardUnplacedAugments':
			return 'augment';
		case 'discardSpirit':
		case 'discardRune':
			return 'discard';
		case 'endLocationActions':
		case 'commitBenefits':
		case 'commitAwakening':
		case 'commitCleanup':
		case 'passEncounter':
			return 'yield';
		default:
			return 'other';
	}
}

/**
 * What OTHER seats learn when `seat` sends `cmd` (the command itself, redacted). Hidden
 * parameters (destination before the reveal, which monster card was kept, which drawn spirit
 * is summoned before it is placed) are left out.
 */
export function publicLabelFor(cmd: GameCommand, seat: SeatColor, before: ViewLike): string | null {
	const actor = before.players[seat];
	switch (cmd.type) {
		case 'lockNavigation':
			return `${seat} locked a destination.`;
		// Power cards, offers and trade proposals are private in the projection.
		case 'chooseNavigationPower':
		case 'resolveNavigationPower':
		case 'respondNavigationPowerTrade':
		case 'tradeNavigationPower':
			return null;
		case 'initiatePvp':
			return `${seat} declared a PvP attack.`;
		case 'passEncounter':
			return null;
		case 'resolveLocationInteraction':
			return `${seat} took a location action at ${actor?.navigationDestination ?? '?'}.`;
		case 'spawnHandSpirit': {
			if (cmd.replaceSlotIndex === undefined) return `${seat} summoned a spirit.`;
			const old = actor?.spirits.find((s) => s.slotIndex === cmd.replaceSlotIndex);
			return `${seat} summoned a spirit, replacing ${old?.name ?? 'one of theirs'}.`;
		}
		// Monster hands and reveals are private in the projection (deck counts stay public).
		case 'drawMonsterCards':
		case 'keepMonsterCard':
			return null;
		case 'startCombat':
			return `${seat} fought a monster.`;
		case 'resolveMonsterReward':
			return `${seat} claimed monster rewards.`;
		case 'awakenSpirit':
		case 'manualAwaken': {
			const spirit = actor?.spirits.find((s) => s.slotIndex === cmd.slotIndex);
			return `${seat} awakened ${spirit?.name ?? 'a spirit'}.`;
		}
		case 'discardSpirit': {
			const spirit = actor?.spirits.find((s) => s.slotIndex === cmd.slotIndex);
			return `${seat} discarded ${spirit?.name ?? 'a spirit'}.`;
		}
		case 'discardRune':
			return `${seat} discarded a rune.`;
		case 'placeAugmentOnSpirit': {
			const spirit = actor?.spirits.find((s) => s.slotIndex === cmd.spiritSlotIndex);
			return `${seat} placed a ${cmd.className ?? ''} augment on ${spirit?.name ?? 'a spirit'}.`;
		}
		case 'infiltratorSwap':
			return `${seat} swapped attack dice (Ram).`;
		case 'endLocationActions':
		case 'commitBenefits':
		case 'commitAwakening':
		case 'commitCleanup':
			return null;
		default:
			return null;
	}
}

/** Short description of each Spirit World / Abyss destination's actions (for the brief and view). */
export function destinationSummaries(catalog: PlayCatalog): string[] {
	return [...SPIRIT_WORLD_ONLY, 'Arcane Abyss'].map((dest) => {
		const actions = interactionsAt(catalog, dest).map(
			(i, n) => `(${n + 1}) ${interactionSummary(i)}`
		);
		const extra =
			dest === 'Arcane Abyss'
				? `; draw/keep/fight monster cards from your own hand${actions.length ? '. You have 1 battle action each round: a FIGHT uses a battle action, and so does the Arcane Abyss Summon action' : ''}`
				: '';
		return `${dest}: ${actions.join('; ') || 'no location actions'}${extra}`;
	});
}

export function classCountsLine(player: SeatPlayer): string {
	const counts = awakenedClassCounts(player as PrivatePlayerState);
	return (
		Object.entries(counts)
			.filter(([, n]) => n > 0)
			.map(([name, n]) => `${name} ${n}`)
			.join(', ') || 'none'
	);
}

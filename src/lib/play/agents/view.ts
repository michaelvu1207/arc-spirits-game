/**
 * A seat's view of the table, as text. Built ONLY from `buildSessionProjection(state, viewer)` —
 * the same per-viewer redaction the live server sends a human client — so a prompt cannot show
 * another seat's secret destination, monster hand, reveal, hand draws, power cards, decision
 * cards, rewards or unplaced augments, nor any bag order.
 */

import { classCountsLine, monsterLine, moonPerksWaiting, spiritLine, type SeatPlayer } from './labels';
import { buildSessionProjection, GOOD_KILL_BONUS_VP } from '../runtime';
import { navigationPowerById } from '../navigationPowers';
import { spiritsByOrigin } from '../effects/relicTools';
import { INITIATIVE_DIE_SIDES, initiativeHits, ruleValue, vpToWin } from '../rules';
import { expectedAttack } from '../combat';
import { awakenedClassCounts } from '../effects/apply';
import {
	MAX_ATTACK_DICE,
	MAX_ROUNDS,
	RUNE_CARRY_LIMIT,
	MAX_SPIRITS,
	STATUS_LADDER,
	isEvilAlignment,
	type PlayCatalog,
	type PublicGameState,
	type SeatColor,
	type SpectatorProjection
} from '../types';

export function seatProjection(state: PublicGameState, seat: SeatColor): SpectatorProjection {
	return buildSessionProjection(state, { role: 'player', seatColor: seat, displayName: seat });
}

export function spectatorProjection(state: PublicGameState): SpectatorProjection {
	return buildSessionProjection(state, { role: 'spectator', seatColor: null, displayName: null });
}

function diceLine(player: SeatPlayer): string {
	const counts: Record<string, number> = {};
	for (const die of player.attackDice ?? []) counts[die.tier] = (counts[die.tier] ?? 0) + 1;
	const parts = ['basic', 'enchanted', 'exalted', 'arcane']
		.filter((tier) => counts[tier])
		.map((tier) => `${counts[tier]} ${tier}`);
	return `${player.attackDice?.length ?? 0}/${MAX_ATTACK_DICE}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

/** Average damage of one attack (engine `expectedAttack`): dice average plus flat Beast damage. */
export function attackLine(me: SeatPlayer, catalog?: Parameters<typeof expectedAttack>[1]): string {
	const player = me as Parameters<typeof expectedAttack>[0];
	if (!Array.isArray(player.attackDice)) return 'Attack: unknown';
	const total = expectedAttack(player, catalog);
	const flat = awakenedClassCounts(player)['Beast'] ?? 0;
	const dice = total - flat;
	const parts = [`dice ${dice.toFixed(1)}`];
	if (flat) parts.push(`flat ${flat} from awake Beast, which needs no dice`);
	return `Attack: average ${total.toFixed(1)} damage per fight (${parts.join(' + ')}). Situational combat bonuses are not in this number; the trial fights include them.`;
}

/** The status with its alignment and, under rule `goodKillBonus`, what the alignment pays for a monster kill. */
function statusLine(level: number, catalog: PlayCatalog): string {
	const name = STATUS_LADDER[level] ?? `level ${level}`;
	const kill = '';
	return `${name} (${level}/3${isEvilAlignment(level) ? ', EVIL' : ', Good'}${kill})`;
}

function awakenRequirement(spiritId: string, catalog: PlayCatalog): string {
	const awaken = catalog.spirits.find((s) => s.id === spiritId)?.awaken;
	if (!awaken) return 'no awaken cost listed';
	if (awaken.kind === 'text') return `condition: "${awaken.text}"`;
	return `pay ${awaken.mats.map((m) => `${m.count}× ${m.name}`).join(' + ') || 'nothing'}`;
}

function heldItems(player: SeatPlayer): string[] {
	return (player.mats ?? [])
		.filter((m) => m.hasRune)
		.map((m) => `${m.name ?? 'rune'}${m.type === 'relic' ? ' (relic)' : ''}`);
}

function ownSection(
	me: SeatPlayer,
	seat: SeatColor,
	view: SpectatorProjection,
	catalog: PlayCatalog
): string[] {
	const lines: string[] = [];
	lines.push(`YOU: ${seat} (guardian ${me.selectedGuardian})`);
	lines.push(
		`  Victory Points: ${me.victoryPoints} (${vpToWin(catalog)} wins)`
	);
	lines.push(
		`  Barrier: ${me.barrier} of ${me.maxBarrier} Max Barrier (${me.brokenBarrier} broken)`
	);
	lines.push(
		`  Status: ${statusLine(me.statusLevel, catalog)}; corruptions so far: ${me.corruptionCount ?? 0}`
	);
	lines.push(`  Attack dice: ${diceLine(me)}`);
	lines.push(`  ${attackLine(me, catalog)}`);
	const moon = moonPerksWaiting(me, catalog);
	if (moon.length)
		lines.push(
			`  Attacked a player this round: ${me.attackedPlayerThisRound ? 'yes' : 'no'} (${moon.join(' and ')} gain only in a round you attacked a player)`
		);
	const hits = initiativeHits(catalog, me.statusLevel ?? 0);
	lines.push(
		`  Initiative die: ${hits} of ${INITIATIVE_DIE_SIDES} sides give you 1 initiative at your status (${Math.round((100 * hits) / INITIATIVE_DIE_SIDES)} %).`
	);
	if ((me.strikeFirstCharges ?? 0) > 0)
		lines.push(
			'  Firecracker armed: in your next combat you gain the initiative if your side does not have it.'
		);
	if ((me.sentinelDiscardIds?.length ?? 0) > 0)
		lines.push(
			`  Sentinel: ${me.sentinelDiscardIds!.length} dice marked to discard before your next combat roll.`
		);
	lines.push(`  Spirits (${me.spirits.length}/${MAX_SPIRITS} slots):`);
	for (const spirit of [...me.spirits].sort((a, b) => a.slotIndex - b.slotIndex)) {
		const augments = (me.spiritAugmentAttachments ?? [])
			.filter((a) => a.spiritSlotIndex === spirit.slotIndex && a.className)
			.map((a) => a.className);
		lines.push(
			`    [slot ${spirit.slotIndex}] ${spiritLine(spirit)} — ${spirit.isFaceDown ? `FACE-DOWN (not active); to awaken: ${awakenRequirement(spirit.id, catalog)}` : 'awake'}${augments.length ? `; augments: ${augments.join(', ')}` : ''}`
		);
	}
	lines.push(`  Active class counts (awake spirits + placed augments): ${classCountsLine(me)}`);
	const origins = spiritsByOrigin(me.spirits);
	lines.push(
		`  Spirits per origin (face-down count too): ${
			Object.entries(origins)
				.map(([o, n]) => `${o} ${n}`)
				.join(', ') || 'none'
		}; origin relics already gained: ${(me.originRelicsGained ?? []).join(', ') || 'none'}${me.cultivatorRelicGained ? '; Cultivator (5) relic already gained (once per game)' : ''}`
	);
	const items = heldItems(me);
	lines.push(
		`  Runes and relics held (${items.length}, carry limit ${RUNE_CARRY_LIMIT} at Cleanup): ${items.join(', ') || 'none'}`
	);
	const powers = (me.powerInventory ?? []).map((id) => navigationPowerById(id)?.name ?? id);
	lines.push(
		`  Navigation Powers held: ${powers.join(', ') || 'none'}${me.pendingNavigationPower ? `; committed this round: ${navigationPowerById(me.pendingNavigationPower)?.name}` : ''}${me.navigationPower ? `; active this round: ${navigationPowerById(me.navigationPower)?.name}` : ''}`
	);
	const hand = me.monsterHand ?? [];
	lines.push(`  Monster hand (${hand.length}/3): ${hand.length ? '' : 'empty'}`);
	hand.forEach((card, i) => lines.push(`    [hand ${i + 1}] ${monsterLine(card)}`));
	if (me.pendingMonsterDraw?.cards.length) {
		lines.push('  Revealed monster cards (keep one):');
		me.pendingMonsterDraw.cards.forEach((card, i) =>
			lines.push(`    [reveal ${i + 1}] ${monsterLine(card)}`)
		);
	}
	if (me.handDraws?.length) {
		const limitText = me.pendingDraw
			? `summon up to ${me.pendingDraw.summonLimit - me.pendingDraw.summonedCount} more`
			: '';
		lines.push(`  Drawn spirits (${me.pendingDraw?.sourceBag ?? 'draw'}; ${limitText}):`);
		if (me.spirits.length >= MAX_SPIRITS)
			lines.push(
				`    (all ${MAX_SPIRITS} slots are full: a summon may replace one of your spirits, which is discarded back to its bag)`
			);
		for (const draw of me.handDraws) {
			const spirit = catalog.spirits.find((s) => s.id === draw.id);
			lines.push(
				`    ${spirit ? spiritLine(spirit) : (draw.rewardLabel ?? draw.name ?? 'reward')}${spirit ? ` — to awaken: ${awakenRequirement(spirit.id, catalog)}` : ''}`
			);
		}
	}
	if (me.pendingReward) lines.push(`  Unclaimed monster reward: ${me.pendingReward.monsterName}`);
	if (me.pendingCorruptionDiscard)
		lines.push(
			`  You owe a corruption payment: sacrifice ${me.pendingCorruptionDiscard.count} spirit(s).`
		);
	if (me.unplacedAugments?.length)
		lines.push(
			`  Spirit Augments to place: ${me.unplacedAugments.length} (${me.unplacedAugments.map((a) => a.name).join(', ')}; choose a class when you place one)`
		);
	for (const decision of me.pendingDecisions ?? [])
		lines.push(`  Decision card: ${decision.prompt}`);
	for (const offer of me.awakenOffers ?? [])
		lines.push(`  Can awaken now: ${offer.spiritName} — ${offer.requirement}`);
	for (const prompt of me.manualPrompts ?? []) lines.push(`  Note: ${prompt.text}`);
	if (me.pendingAwakenReward?.grants.length)
		lines.push(
			`  Awakening-phase rewards to claim: ${me.pendingAwakenReward.grants.map((g) => `${g.kind} ${g.amount} (${g.source})`).join(', ')}`
		);
	const destination =
		view.phase === 'navigation' && !view.revealedDestinations
			? me.pendingDestination
				? `you locked ${me.pendingDestination} (secret until the reveal)`
				: 'not chosen yet'
			: (me.navigationDestination ?? 'none');
	lines.push(
		`  Destination this round: ${destination}; previous: ${me.previousDestination ?? 'none'}`
	);
	const used = (me.actionsUsedThisRound ?? []).filter(
		(k) => k.startsWith('row:') || k === 'combat' || k === 'gain-power'
	);
	if (view.phase === 'location' && used.length) lines.push(`  Used this round: ${used.join(', ')}`);
	return lines;
}

function otherSection(seat: SeatColor, player: SeatPlayer, view: SpectatorProjection, catalog: PlayCatalog): string[] {
	const where =
		view.phase === 'navigation' && !view.revealedDestinations
			? view.navigation?.[seat]?.locked
				? 'has locked a secret destination'
				: 'still choosing a destination'
			: `at ${player.navigationDestination ?? 'none'}`;
	const spirits = [...player.spirits]
		.sort((a, b) => a.slotIndex - b.slotIndex)
		.map((s) => `${s.name}${s.isFaceDown ? ' (face-down)' : ''}`);
	const lines = [
		`${seat} (guardian ${player.selectedGuardian}): VP ${player.victoryPoints}; Barrier ${player.barrier}/${player.maxBarrier}; Status ${statusLine(player.statusLevel, catalog)}; dice ${diceLine(player)}; ${where}`,
		`    spirits: ${spirits.join(', ') || 'none'}; active classes: ${classCountsLine(player)}; runes/relics: ${heldItems(player).length}`
	];
	return lines;
}

function tableSection(view: SpectatorProjection): string[] {
	const lines: string[] = [];
	lines.push(`TABLE: round ${view.round} of ${MAX_ROUNDS}; phase ${view.phase}`);
	const decks = (view.monsterDecks ?? [])
		.map(
			(d) =>
				`Difficulty ${d.difficulty}: ${d.count ?? '?'} of ${d.total} cards left (Barrier ${d.barrierMin}-${d.barrierMax}; VP per kill ${d.vpValues.join('/') || '?'})`
		)
		.join('; ');
	if (decks) lines.push(`  Abyss monster decks: ${decks}`);
	lines.push(
		`  Bags: Spirit World ${view.bagCounts.hexSpirits} spirits; Arcane Abyss ${view.bagCounts.abyssFallen} spirits`
	);
	if (view.revealedDestinations || view.phase !== 'navigation') {
		const occupancy = Object.entries(view.locationOccupancy ?? {})
			.filter(([, seats]) => (seats?.length ?? 0) > 0)
			.map(([loc, seats]) => `${loc}: ${seats!.join(', ')}`)
			.join('; ');
		if (occupancy) lines.push(`  Who is where: ${occupancy}`);
	}
	return lines;
}

/** The seat's full view as prompt text. */
export function renderSeatView(
	view: SpectatorProjection,
	seat: SeatColor,
	catalog: PlayCatalog
): string {
	const me = view.players[seat];
	if (!me) return `You (${seat}) are not seated.`;
	const lines = [...ownSection(me, seat, view, catalog), '', 'OTHER PLAYERS (public information):'];
	for (const other of view.activeSeats) {
		if (other === seat) continue;
		const player = view.players[other];
		if (player) lines.push(...otherSection(other, player, view, catalog).map((l) => `  ${l}`));
	}
	lines.push('', ...tableSection(view));
	return lines.join('\n');
}

/**
 * Engine-computed facts for a seat's prompt (no advice, nothing hand-written about the rules):
 *
 *  - DESTINATION PREVIEW (navigation): for each destination, the seat is put there in a COPY of
 *    the state (Location phase, its own committed Power only) and every location action is
 *    tried through the real reducer. Legal → the action's effect on the seat's own Barrier,
 *    Max Barrier, VP, dice, items and Powers (from a dry run). Illegal → the reducer's own error
 *    message. At the Arcane Abyss: monster draw and the fight facts below.
 *  - MONSTER FACTS: each card in the seat's hand is fought in copies of the state with
 *    `fightMonster` (the engine's combat): does its hit corrupt the seat before it can strike,
 *    and how often does the seat kill it, with and without each held Power committed.
 *  - PACE: round, VP and the VP per round still needed.
 *
 * Hidden information: dry runs read only the seat's own state and public bag/deck sizes.
 * Random results are never taken from the real RNG: every dry run uses fixed trial seeds made
 * from public data (round, seat, trial number). Results that come from a bag, a deck or the
 * RNG are shown only as counts or as "random".
 */

import { applyTrigger } from '../effects/apply';
import { resolveNavigationPowerReveal } from '../navigationPowerEffects';
import { fightMonster } from '../combat';
import {
	buildLocationInteractions,
	eligibleCostSlots,
	type LocationInteraction
} from '../locationInteractions';
import { navigationPowerById } from '../navigationPowers';
import { hashString } from '../rng';
import { applyGameCommand, monsterCardFromCatalog, monsterDifficulty } from '../runtime';
import { botActorFor } from '../server/botPolicy';
import {
	ALL_DESTINATIONS,
	MAX_ROUNDS,
	type GameCommand,
	type PlayCatalog,
	type PrivatePlayerState,
	type PublicGameState,
	type SeatColor
} from '../types';
import { locationRowCommands } from './actionSurface';
import type { DecisionKind } from './contract';
import { interactionSummary, itemName } from './labels';
import { VP_TO_WIN } from '../rules';

const TRIALS = 12;

/** A fixed trial seed from public data only (never from the real RNG). */
function trialSeed(state: PublicGameState, seat: SeatColor, salt: string, trial: number): number {
	return hashString(`${state.round}:${seat}:${salt}:${trial}`);
}

/**
 * A copy of the state with `seat` at `destination` in the Location phase. Only this seat is
 * placed (no other seat's secret choice is used); `power` is its committed Navigation Power.
 */
export function hypotheticalAt(
	state: PublicGameState,
	seat: SeatColor,
	destination: string,
	catalog: PlayCatalog,
	power: string | null = null
): PublicGameState {
	const s = structuredClone(state);
	const p = s.players[seat]!;
	s.phase = 'location';
	s.revealedDestinations = true;
	s.locationOccupancy = { [destination]: [seat] } as PublicGameState['locationOccupancy'];
	p.navigationDestination = destination as PrivatePlayerState['navigationDestination'];
	p.pendingDestination = null;
	p.pendingNavigationPower = null;
	p.phaseReady = false;
	const held = p.powerInventory ?? [];
	p.navigationPower = null;
	p.navigationPowerCombatEnabled = false;
	if (power && held.includes(power as never)) {
		held.splice(held.indexOf(power as never), 1);
		p.navigationPower = power as PrivatePlayerState['navigationPower'];
		p.navigationPowerUsed = false;
		// The real reveal decides what the Power does when the seat is alone there (e.g. Guardian's
		// Accord needs company); a "combat" offer is accepted, other offers are dropped.
		resolveNavigationPowerReveal(s, catalog);
		// Reworked Powers switch their battle effect on at the reveal, without an offer.
		const switchedOn = (p as { navigationPowerCombatEnabled?: boolean }).navigationPowerCombatEnabled;
		p.navigationPowerCombatEnabled =
			switchedOn === true || (p.navigationPowerOffers ?? []).some((o) => o.kind === 'combat');
		p.navigationPowerOffers = [];
	}
	try {
		applyTrigger(s, seat, 'onNavigate', [], { catalog });
	} catch {
		// A navigation trigger that needs more context than a preview has: ignore it.
	}
	return s;
}

// ── Own-state snapshot and diff ─────────────────────────────────────────────

interface OwnSnapshot {
	barrier: number;
	maxBarrier: number;
	vp: number;
	status: number;
	dice: Record<string, number>;
	items: string[];
	powers: number;
	powerChoices: number;
	draws: number;
	spirits: number;
	augments: string[];
}

function snapshot(p: PrivatePlayerState): OwnSnapshot {
	const dice: Record<string, number> = {};
	for (const d of p.attackDice ?? []) dice[d.tier] = (dice[d.tier] ?? 0) + 1;
	return {
		barrier: p.barrier,
		maxBarrier: p.maxBarrier,
		vp: p.victoryPoints,
		status: p.statusLevel,
		dice,
		items: (p.mats ?? [])
			.filter((m) => m.hasRune)
			.map((m) => itemName({ name: m.name ?? 'rune', type: m.type }))
			.sort(),
		powers: p.powerInventory?.length ?? 0,
		powerChoices: p.pendingPowerDrafts?.[0]?.length ?? 0,
		draws: (p.handDraws?.length ?? 0) + (p.pendingDraw ? 1 : 0),
		spirits: p.spirits?.length ?? 0,
		augments: (p.unplacedAugments ?? [])
			.map((a) => itemName({ name: a.name ?? 'Spirit', type: 'augment' }))
			.sort()
	};
}

function multisetDiff(before: string[], after: string[]): { plus: string[]; minus: string[] } {
	const left = [...before];
	const plus: string[] = [];
	for (const x of after) {
		const i = left.indexOf(x);
		if (i >= 0) left.splice(i, 1);
		else plus.push(x);
	}
	return { plus, minus: left };
}

function diceText(d: Record<string, number>): string {
	const parts = Object.entries(d)
		.filter(([, n]) => n > 0)
		.map(([tier, n]) => `${n} ${tier}`);
	return parts.join(' + ') || 'none';
}

/** Facts that changed between two snapshots (each a short phrase). */
function changes(a: OwnSnapshot, b: OwnSnapshot): string[] {
	const out: string[] = [];
	if (a.barrier !== b.barrier) out.push(`Barrier ${a.barrier}→${b.barrier}`);
	if (a.maxBarrier !== b.maxBarrier) out.push(`Max Barrier ${a.maxBarrier}→${b.maxBarrier}`);
	if (a.vp !== b.vp) out.push(`VP ${a.vp}→${b.vp}`);
	if (a.status !== b.status) out.push(`status step ${a.status}→${b.status}`);
	if (diceText(a.dice) !== diceText(b.dice))
		out.push(`dice ${diceText(a.dice)} → ${diceText(b.dice)}`);
	const items = multisetDiff(a.items, b.items);
	if (items.minus.length) out.push(`pay ${items.minus.join(', ')}`);
	if (items.plus.length) out.push(`gain ${items.plus.join(', ')}`);
	const aug = multisetDiff(a.augments, b.augments);
	if (aug.plus.length) out.push(`gain ${aug.plus.join(', ')} (unplaced augment)`);
	if (b.powers !== a.powers) out.push(`Powers held ${a.powers}→${b.powers}`);
	if (b.powerChoices > a.powerChoices) out.push(`then choose 1 of ${b.powerChoices} Power cards`);
	if (b.draws > a.draws) out.push('then a spirit draw (you choose what to summon)');
	if (b.spirits !== a.spirits) out.push(`spirits ${a.spirits}→${b.spirits}`);
	return out;
}

/**
 * The effect of one command for `seat`, from dry runs with two public trial seeds. A phrase that
 * differs between the runs depends on luck and is reported as "(random)".
 */
function effectOf(s: PublicGameState, seat: SeatColor, cmd: GameCommand, catalog: PlayCatalog) {
	const before = snapshot(s.players[seat]!);
	const runs = [0, 1].map((k) => {
		const copy = structuredClone(s);
		copy.rng = { seed: trialSeed(s, seat, 'effect', k), cursor: 0 };
		const res = applyGameCommand(copy, botActorFor(copy, seat), cmd, catalog);
		return res.ok ? changes(before, snapshot(res.state.players[seat]!)) : null;
	});
	if (!runs[0] || !runs[1]) return null;
	const same = runs[0].filter((c) => runs[1]!.includes(c));
	const random = runs[0].length !== same.length || runs[1].length !== same.length;
	const parts = random ? [...same, 'plus a random result'] : same;
	return parts.length
		? parts.join('; ')
		: 'no change to your Barrier, Max Barrier, VP, dice, items or Powers';
}

function failureOf(s: PublicGameState, seat: SeatColor, cmd: GameCommand, catalog: PlayCatalog) {
	const res = applyGameCommand(s, botActorFor(s, seat), cmd, catalog);
	return res.ok ? null : { code: res.error.code, message: res.error.message.replace(/\.$/, '') };
}

function errorOf(s: PublicGameState, seat: SeatColor, cmd: GameCommand, catalog: PlayCatalog) {
	return failureOf(s, seat, cmd, catalog)?.message ?? null;
}

function rowLine(
	s: PublicGameState,
	seat: SeatColor,
	row: LocationInteraction,
	n: number,
	catalog: PlayCatalog
): string {
	const me = s.players[seat]!;
	const variants = locationRowCommands(s, seat, catalog).filter(
		(c) => c.type === 'resolveLocationInteraction' && c.rowIndex === row.rowIndex
	);
	const legal = variants.filter((c) => errorOf(s, seat, c, catalog) === null);
	const head = `(${n}) ${interactionSummary(row)}`;
	const repeat = row.kind === 'trade' ? '; repeatable while you can pay' : '';
	if (legal.length === 0) {
		const failure = failureOf(
			s,
			seat,
			variants[0] ?? { type: 'resolveLocationInteraction', rowIndex: row.rowIndex },
			catalog
		);
		const why = failure?.message ?? 'not possible now';
		const payers =
			failure?.code === 'cannot_afford'
				? `; you hold ${
						[
							...new Set(
								row.cost.flatMap((req) =>
									eligibleCostSlots(req, me.mats).map((i) =>
										itemName({ name: me.mats[i].name ?? 'rune', type: me.mats[i].type })
									)
								)
							)
						].join(', ') || 'nothing'
					} that pays it`
				: '';
		return `${head}: NOT POSSIBLE now — ${why}${payers}`;
	}
	const effect = effectOf(s, seat, legal[0], catalog) ?? 'not possible now';
	const variantsNote = legal.length > 1 ? ` (${legal.length} ways to pay/choose; first shown)` : '';
	return `${head}: possible; effect now: ${effect}${variantsNote}${repeat}`;
}

// ── Monster facts ───────────────────────────────────────────────────────────

/** Fight hand card `index` in `trials` copies of `s` (engine `fightMonster`, trial seeds). */
function fightStats(
	s: PublicGameState,
	seat: SeatColor,
	index: number,
	catalog: PlayCatalog,
	trials: number,
	seedOf: (trial: number) => number
): { text: string } | null {
	let corrupted = 0;
	let silenced = 0;
	let kills = 0;
	let lost = 0;
	let dealt = 0;
	for (let k = 0; k < trials; k++) {
		const copy = structuredClone(s);
		copy.rng = { seed: seedOf(k), cursor: 0 };
		const res = fightMonster(copy, seat, catalog, index);
		if (!res) return null;
		if (res.corrupted) corrupted += 1;
		// The engine's own line for a corrupted seat that cannot strike back.
		if (res.log.includes('Corrupted players cannot strike back this combat.')) silenced += 1;
		if (res.killed) kills += 1;
		lost += res.barrierLost;
		dealt += res.playerDamage;
	}
	const barrier = s.players[seat]!.barrier;
	if (silenced === trials)
		return {
			text: `its hit vs your Barrier ${barrier}: you are corrupted before you strike (you cannot strike back) in all ${trials} trials; you defeat it in ${kills}/${trials}`
		};
	const avg = (n: number) => (n / trials).toFixed(1);
	if (corrupted === 0)
		return {
			text: `its hit vs your Barrier ${barrier}: you survive (lose ${avg(lost)} Barrier on average) and strike back; you defeat it in ${kills}/${trials} trials (average damage ${avg(dealt)})`
		};
	return {
		text: `its hit vs your Barrier ${barrier}: you are corrupted in ${corrupted}/${trials} trials (striking back in ${corrupted - silenced} of them); you defeat it in ${kills}/${trials} trials (average damage ${avg(dealt)})`
	};
}

/** Short fact lines for each monster card in the seat's hand, in state `s`. */
export function monsterFactLines(
	s: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	opts: { destination?: string; heldPowers?: boolean } = {}
): string[] {
	const me = s.players[seat];
	const hand = me?.monsterHand ?? [];
	if (!me || hand.length === 0) return [];
	const destination = opts.destination ?? 'Arcane Abyss';
	const base =
		s.phase === 'location' && me.navigationDestination === destination
			? s
			: hypotheticalAt(s, seat, destination, catalog);
	const lines: string[] = [];
	hand.forEach((card, index) => {
		const without = fightStats(base, seat, index, catalog, TRIALS, (k) =>
			trialSeed(s, seat, `fight${index}`, k)
		);
		if (!without) return;
		lines.push(
			`${card.name} (Barrier ${card.hp}/${card.maxHp}, hit ${card.damage}): ${without.text}`
		);
		if (opts.heldPowers) {
			for (const power of new Set(me.powerInventory ?? [])) {
				const committed = hypotheticalAt(s, seat, destination, catalog, power);
				const withPower = fightStats(committed, seat, index, catalog, TRIALS, (k) =>
					trialSeed(s, seat, `fight${index}`, k)
				);
				if (withPower && withPower.text !== without.text)
					lines.push(
						`  with your Power "${navigationPowerById(power)?.name ?? power}" committed: ${withPower.text}`
					);
			}
		}
	});
	return lines;
}

/** Trial fights per card type in the deck odds (kept small: it runs at every Navigation). */
const DECK_TRIALS = 4;

/**
 * Odds against a card drawn from each Abyss deck, with what the seat holds now: every catalog
 * card of that difficulty (public card list, not the hidden deck order) is fought
 * `DECK_TRIALS` times through the engine's `fightMonster` from state `s` (the seat placed at
 * the Abyss). Card types weigh equally.
 */
export function deckOddsLines(s: PublicGameState, seat: SeatColor, catalog: PlayCatalog): string[] {
	const me = s.players[seat];
	if (!me) return [];
	const lines: string[] = [];
	for (const difficulty of [1, 2, 3] as const) {
		const cards = (catalog.monsters ?? []).filter((m) => monsterDifficulty(m, catalog) === difficulty);
		if (!cards.length) continue;
		let fights = 0;
		let kills = 0;
		let corrupted = 0;
		let lost = 0;
		cards.forEach((monster, c) => {
			for (let k = 0; k < DECK_TRIALS; k++) {
				const copy = structuredClone(s);
				const p = copy.players[seat]!;
				p.monsterHand = [...(p.monsterHand ?? []), monsterCardFromCatalog(monster, catalog)];
				copy.rng = { seed: trialSeed(s, seat, `deck${difficulty}:${c}`, k), cursor: 0 };
				const res = fightMonster(copy, seat, catalog, p.monsterHand.length - 1);
				if (!res) continue;
				fights += 1;
				if (res.killed) kills += 1;
				if (res.corrupted) corrupted += 1;
				lost += res.barrierLost;
			}
		});
		if (!fights) continue;
		const pct = (n: number) => `${Math.round((100 * n) / fights)}%`;
		lines.push(
			`Difficulty ${difficulty} (${cards.length} cards): you defeat it in one fight ${pct(kills)}; its hit corrupts you ${pct(corrupted)}; average Barrier lost ${(lost / fights).toFixed(1)}`
		);
	}
	return lines;
}

// ── Destination preview and pace ───────────────────────────────────────────

/** One block of lines per destination (navigation decisions). */
export function destinationPreviewLines(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog
): string[] {
	const me = state.players[seat];
	if (!me) return [];
	const out: string[] = [];
	for (const destination of ALL_DESTINATIONS) {
		const s = hypotheticalAt(state, seat, destination, catalog);
		const rows = buildLocationInteractions(
			catalog.locations?.find((l) => l.name === destination)?.rewardRows,
			destination
		);
		out.push(`  ${destination}:`);
		rows.forEach((row, i) => out.push(`    ${rowLine(s, seat, row, i + 1, catalog)}`));
		if (destination === 'Arcane Abyss') {
			const draws = ([1, 2, 3] as const).map((difficulty) => ({
				difficulty,
				error: errorOf(s, seat, { type: 'drawMonsterCards', difficulty }, catalog)
			}));
			const open = draws.filter((d) => !d.error).map((d) => d.difficulty);
			out.push(
				open.length
					? `    monster draw: possible from Difficulty ${open.join('/')} (your hand ${me.monsterHand?.length ?? 0}/3)`
					: `    monster draw: NOT POSSIBLE now — ${[...new Set(draws.map((d) => d.error))].join('; ')}`
			);
			const facts = monsterFactLines(state, seat, catalog, { destination, heldPowers: true });
			out.push(
				facts.length
					? `    monster fights (engine trial fights, ${TRIALS} rolls each):`
					: '    monster fights: no card in your hand'
			);
			for (const line of facts) out.push(`      ${line}`);
			const odds = deckOddsLines(s, seat, catalog);
			if (odds.length) {
				out.push(
					`    a NEW card from each deck (every card of that difficulty, ${DECK_TRIALS} trial fights each, with what you hold now):`
				);
				for (const line of odds) out.push(`      ${line}`);
			}
		} else if (rows.length === 0) out.push('    no location actions');
	}
	return out;
}

export function paceLine(
	state: PublicGameState,
	seat: SeatColor,
	catalog?: unknown
): string {
	const target = VP_TO_WIN;
	const vp = state.players[seat]?.victoryPoints ?? 0;
	const roundsLeft = Math.max(1, MAX_ROUNDS - state.round + 1);
	const need = Math.max(0, target - vp);
	return `PACE: round ${state.round} of ${MAX_ROUNDS}; you have ${vp} VP; ${target} VP wins; ${need} VP to go in ${roundsLeft} round${roundsLeft === 1 ? '' : 's'} (this one included) = ${(need / roundsLeft).toFixed(1)} VP per round.`;
}

/** Fight facts for revealed monster cards (as if each were kept). */
function revealFactLines(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog): string[] {
	const me = state.players[seat];
	const cards = me?.pendingMonsterDraw?.cards ?? [];
	return cards.flatMap((card, i) => {
		const s = structuredClone(state);
		const p = s.players[seat]!;
		p.pendingMonsterDraw = null as never;
		p.monsterHand = [...(p.monsterHand ?? []), structuredClone(card)];
		const stats = fightStats(s, seat, p.monsterHand.length - 1, catalog, TRIALS, (k) =>
			trialSeed(state, seat, `reveal${i}`, k)
		);
		return stats
			? [
					`  revealed card ${i + 1}: ${card.name} (Barrier ${card.hp}/${card.maxHp}, hit ${card.damage}): ${stats.text}`
				]
			: [];
	});
}

/** The ENGINE FACTS block for one decision (empty when there is nothing to check). */
export function decisionFacts(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	kind: DecisionKind
): string[] {
	try {
		if (kind === 'navigation')
			return [
				`DESTINATION PREVIEW (you alone placed at each destination in a copy of the game, with what you hold now; ${TRIALS} trial fights use practice rolls, not the real ones):`,
				...destinationPreviewLines(state, seat, catalog)
			];
		const me = state.players[seat];
		if (state.phase !== 'location' || me?.navigationDestination !== 'Arcane Abyss') return [];
		if (kind === 'monster-reveal') {
			const lines = revealFactLines(state, seat, catalog);
			// Rule `monsterDrawOne`: the card may replace a held one, so the held cards' fights are shown too.
			const held = me.pendingMonsterDraw?.maxCards === 1 && (me.monsterHand?.length ?? 0) > 0 ? monsterFactLines(state, seat, catalog) : [];
			return lines.length
				? [
						`MONSTER CARDS REVEALED (${TRIALS} trial fights each, practice rolls):`,
						...lines,
						...(held.length ? [`MONSTER HAND, the cards you hold now (${TRIALS} trial fights each, practice rolls):`, ...held.map((l) => `  ${l}`)] : [])
					]
				: [];
		}
		const facts = monsterFactLines(state, seat, catalog);
		return facts.length
			? [
					`MONSTER HAND (${TRIALS} trial fights each, practice rolls):`,
					...facts.map((l) => `  ${l}`)
				]
			: [];
	} catch (err) {
		// A preview must never stop a game: say it failed instead.
		return [`(engine facts unavailable: ${(err as Error).message.slice(0, 120)})`];
	}
}

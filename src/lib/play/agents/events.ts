/**
 * Per-seat event log. Every line has an audience: everyone, or only the acting seat. Public
 * lines are derived from SPECTATOR projections (before/after diffs), so they can only contain
 * what any viewer of the table sees. The acting seat additionally gets its own engine log
 * (`lastAction.log`, which the server shows only to its owner) and its own action label.
 */

import { navigationPowerById } from '../navigationPowers';
import {
	STATUS_LADDER,
	type GameCommand,
	type SeatColor,
	type SpectatorProjection
} from '../types';
import { publicLabelFor } from './labels';

interface EventEntry {
	seq: number;
	text: string;
	/** null = everyone. */
	audience: SeatColor | null;
}

export class EventLog {
	#entries: EventEntry[] = [];
	#cursor = new Map<SeatColor, number>();
	#seq = 0;

	add(text: string, audience: SeatColor | null = null): void {
		this.#entries.push({ seq: ++this.#seq, text, audience });
	}

	/** Lines `seat` can see since its previous call (at most `limit`, newest kept). */
	takeFor(seat: SeatColor, limit = 30): string[] {
		const from = this.#cursor.get(seat) ?? 0;
		const visible = this.#entries.filter(
			(e) => e.seq > from && (e.audience === null || e.audience === seat)
		);
		this.#cursor.set(seat, this.#seq);
		const lines = visible.map((e) => e.text);
		return lines.length > limit
			? [`(${lines.length - limit} older events omitted)`, ...lines.slice(-limit)]
			: lines;
	}

	/** Where `seat` has read up to (for {@link rewind}). */
	cursor(seat: SeatColor): number {
		return this.#cursor.get(seat) ?? 0;
	}

	/** Hand lines back: an answer that was not applied (stale) did not count as a decision, so
	 *  the seat sees those lines again in its next decision. */
	rewind(seat: SeatColor, cursor: number): void {
		this.#cursor.set(seat, Math.min(cursor, this.cursor(seat)));
	}

	/** Every line with its audience (for tests). */
	all(): { text: string; audience: SeatColor | null }[] {
		return this.#entries.map(({ text, audience }) => ({ text, audience }));
	}
}

/** Public changes between two spectator projections. */
export function publicDiff(before: SpectatorProjection, after: SpectatorProjection): string[] {
	const lines: string[] = [];
	if (after.round !== before.round) lines.push(`— Round ${after.round} begins —`);
	if (after.phase !== before.phase || after.round !== before.round)
		lines.push(`— ${cap(after.phase)} phase —`);
	if (!before.revealedDestinations && after.revealedDestinations) {
		const where = after.activeSeats
			.map((seat) => {
				const p = after.players[seat];
				const power = p?.navigationPower
					? ` with Power "${navigationPowerById(p.navigationPower)?.name}"`
					: '';
				return `${seat} → ${p?.navigationDestination ?? '?'}${power}`;
			})
			.join('; ');
		lines.push(`Destinations revealed: ${where}`);
	}
	for (const seat of after.activeSeats) {
		const a = after.players[seat];
		const b = before.players[seat];
		if (!a || !b) continue;
		const changes: string[] = [];
		if (a.victoryPoints !== b.victoryPoints)
			changes.push(`VP ${b.victoryPoints}→${a.victoryPoints}`);
		if (a.statusLevel !== b.statusLevel)
			changes.push(`status ${STATUS_LADDER[b.statusLevel]}→${STATUS_LADDER[a.statusLevel]}`);
		if (a.barrier !== b.barrier || a.maxBarrier !== b.maxBarrier)
			changes.push(`Barrier ${b.barrier}/${b.maxBarrier}→${a.barrier}/${a.maxBarrier}`);
		if ((a.attackDice?.length ?? 0) !== (b.attackDice?.length ?? 0))
			changes.push(`dice ${b.attackDice?.length ?? 0}→${a.attackDice?.length ?? 0}`);
		const spiritsBefore = b.spirits
			.map((s) => `${s.name}${s.isFaceDown ? '*' : ''}`)
			.sort()
			.join(',');
		const spiritsAfter = a.spirits
			.map((s) => `${s.name}${s.isFaceDown ? '*' : ''}`)
			.sort()
			.join(',');
		if (spiritsBefore !== spiritsAfter) {
			const added = a.spirits.filter(
				(s) => !b.spirits.some((x) => x.id === s.id && x.slotIndex === s.slotIndex)
			);
			const removed = b.spirits.filter(
				(s) => !a.spirits.some((x) => x.id === s.id && x.slotIndex === s.slotIndex)
			);
			const woke = a.spirits.filter(
				(s) =>
					!s.isFaceDown &&
					b.spirits.some((x) => x.slotIndex === s.slotIndex && x.id === s.id && x.isFaceDown)
			);
			if (added.length) changes.push(`+spirit ${added.map((s) => s.name).join(', ')}`);
			if (removed.length) changes.push(`-spirit ${removed.map((s) => s.name).join(', ')}`);
			if (woke.length) changes.push(`awakened ${woke.map((s) => s.name).join(', ')}`);
		}
		if (changes.length) lines.push(`${seat}: ${changes.join('; ')}`);
	}
	// Combats are public in the projection: report new ones (and new lines of open ones).
	const seen = new Map(before.combats.map((c) => [c.id, c.log.length]));
	for (const combat of after.combats) {
		const known = seen.get(combat.id);
		const fresh = known === undefined ? combat.log : combat.log.slice(known);
		if (!fresh.length) continue;
		const who = combat.sides.map((s) => s.seat).join(' vs ');
		if (combat.kind === 'monster') {
			// The engine writes a monster fight log from the fighter's point of view ("You roll …").
			const fighter = combat.sides[0]?.seat ?? 'the fighter';
			const outcome =
				combat.step === 'resolved'
					? combat.killed
						? ', monster defeated'
						: ', monster survives'
					: '';
			lines.push(
				`Monster combat: ${who} vs ${combat.monster?.name ?? 'monster'}${outcome}. ${fighter}'s combat log: «${fresh.join(' ')}»`
			);
		} else {
			lines.push(`PvP combat (${who}): ${fresh.join(' ')}`);
		}
	}
	if (before.status === 'active' && after.status === 'finished')
		lines.push(`Game over. Winner: ${after.winnerSeat ?? 'none'}.`);
	return lines;
}

function cap(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Record one applied command. `actorBefore`/`actorAfter` are the ACTOR's own projections (for
 * its private engine log); `specBefore`/`specAfter` are spectator projections (public diff).
 */
export function recordCommandEvents(
	log: EventLog,
	seat: SeatColor,
	cmd: GameCommand,
	label: string,
	actorBefore: SpectatorProjection,
	actorAfter: SpectatorProjection,
	specBefore: SpectatorProjection,
	specAfter: SpectatorProjection
): void {
	log.add(`You (${seat}): ${label}`, seat);
	const lastBefore = actorBefore.players[seat]?.lastAction;
	const lastAfter = actorAfter.players[seat]?.lastAction;
	if (
		lastAfter &&
		JSON.stringify(lastAfter) !== JSON.stringify(lastBefore) &&
		lastAfter.log?.length
	) {
		log.add(`  result: ${lastAfter.log.join(' ')}`, seat);
	}
	const publicLabel = publicLabelFor(cmd, seat, specBefore);
	for (const other of specAfter.activeSeats) {
		if (other !== seat && publicLabel) log.add(publicLabel, other);
	}
	for (const line of publicDiff(specBefore, specAfter)) log.add(line);
}

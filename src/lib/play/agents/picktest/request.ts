/**
 * Pick test, step 2: rebuild one recorded summon decision as a NEW question on changed data.
 *
 * The state is the recorded one (replayed with the ORIGINAL catalog, see extract.ts). The question
 * is built with the CHANGED catalog: the same `buildDecision` the harness uses, so the offer
 * labels, the view, the engine facts and the legal actions come from the changed data (the rules
 * brief is built by the caller from the same catalog).
 *
 * Spirits already on the table were copied into the state when they were summoned (name, cost,
 * classes, origins). Where the changed data differs from the original data for such a spirit, the
 * copy is updated to the changed data, so the board reads like the changed game. Values the game
 * itself changed (they no longer match the original data) are left alone and flagged.
 *
 * Validity: the test is SKIPPED (status `skip`) when the changed data makes the recorded moment
 * impossible or different:
 *   - spirit-removed         a spirit in the hand is not in the changed data
 *   - board-spirit-removed   a spirit on the table is not in the changed data
 *   - bag-changed            a drawn spirit's new cost puts it in another bag (it could not have
 *                            been drawn here)
 *   - summon-options-changed the changed data changes WHICH spirits can be summoned, or whether
 *                            "none" / "redraw" are offered
 *   - not-a-summon           the rebuilt question is no longer a summon decision
 * and it runs with a flag (status `ok`) for smaller differences:
 *   - board-refreshed:<n>    n table spirits were updated to the changed data
 *   - board-kept:<n>         n table spirit fields changed in the game AND in the data (old kept)
 *   - other-options-changed  non-summon actions in the list differ (e.g. a combat became legal)
 *   - harness-drift          the current code offers different actions than the recorded game
 *                            did, on the ORIGINAL data (engine/harness changed since the game)
 */

import { actionIdForCommand } from '../../bots/contract';
import { bagForSpiritCost } from '../../bags';
import type {
	GameCommand,
	PlayCatalog,
	PlayCatalogSpirit,
	PublicGameState,
	SeatColor
} from '../../types';
import { agentLegalCommands } from '../actionSurface';
import type { DecisionRequest } from '../contract';
import { buildDecision } from '../decision';
import { renderDecisionMessage } from '../prompt';
import type { DecisionRecord } from '../transcript';
import { handOf, pickOf, type PickKind, type SummonPoint } from './extract';

export interface OptionInfo {
	/** Short action id (a1, a2, ...). */
	id: string;
	pick: PickKind;
	spiritId: string | null;
}

export type PreparedTest =
	| {
			status: 'ok';
			flags: string[];
			request: DecisionRequest;
			options: OptionInfo[];
			/** Spirit ids offered (changed data). */
			offered: string[];
			/** The rebuilt decision message is word for word inside the recorded one (expected on the
			 *  original data; null: no recorded message). */
			sameAsRecorded: boolean | null;
	  }
	| { status: 'skip'; flags: string[]; detail: string };

/** The "RECENT EVENTS" lines of a recorded decision message. */
export function recordedEvents(prompt: string | null): string[] {
	if (!prompt) return [];
	const head = 'RECENT EVENTS (since your last decision):\n';
	const at = prompt.indexOf(head);
	if (at < 0) return [];
	const lines: string[] = [];
	for (const line of prompt.slice(at + head.length).split('\n')) {
		if (!line.startsWith('  ')) break;
		lines.push(line.slice(2));
	}
	return lines.length === 1 && lines[0] === '(nothing new)' ? [] : lines;
}

/** The seat's decision number in this phase (0-based) from a recorded decision message. */
export function recordedPhaseIndex(prompt: string | null): number {
	const m = prompt ? /This is your decision #(\d+) in this phase/.exec(prompt) : null;
	return m ? Number(m[1]) - 1 : 0;
}

const SPIRIT_FIELDS = ['name', 'cost', 'classes', 'origins'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Update the table's spirit copies to the changed data (in place) where the changed data
 * differs from the original data. Returns the updated and kept counts, or the removed ids.
 */
export function refreshTableSpirits(
	state: PublicGameState,
	original: PlayCatalog,
	changed: PlayCatalog
): { refreshed: number; kept: number; removed: string[] } {
	const before = new Map(original.spirits.map((s) => [s.id, s]));
	const after = new Map(changed.spirits.map((s) => [s.id, s]));
	let refreshed = 0;
	let kept = 0;
	const removed = new Set<string>();
	for (const player of Object.values(state.players)) {
		for (const spirit of player?.spirits ?? []) {
			const now = after.get(spirit.id);
			if (!now) {
				removed.add(spirit.id);
				continue;
			}
			const was = before.get(spirit.id);
			let touched = false;
			for (const field of SPIRIT_FIELDS) {
				if (!was || same(was[field], now[field])) continue;
				if (same(spirit[field], was[field])) {
					(spirit as unknown as Record<string, unknown>)[field] = structuredClone(now[field]);
					touched = true;
				} else kept += 1;
			}
			if (touched) refreshed += 1;
		}
		for (const draw of player?.handDraws ?? []) {
			const now = draw.id && !draw.rewardId ? after.get(draw.id) : undefined;
			if (now) {
				draw.name = now.name;
				draw.cost = now.cost;
			}
		}
	}
	return { refreshed, kept, removed: [...removed] };
}

function summonSignature(
	commands: GameCommand[],
	state: PublicGameState,
	seat: SeatColor
): { spirits: string; extras: string; others: string } {
	const hand = handOf(state, seat);
	const spirits: string[] = [];
	const extras: string[] = [];
	const others: string[] = [];
	for (const cmd of commands) {
		const { pick, spiritId } = pickOf(cmd, hand);
		if (pick === 'spirit') spirits.push(spiritId!);
		else if (pick === 'other') others.push(actionIdForCommand(cmd));
		else extras.push(pick);
	}
	return {
		spirits: [...spirits].sort().join(','),
		extras: [...new Set(extras)].sort().join(','),
		others: [...others].sort().join('|')
	};
}

/**
 * Build the test question for one summon point. `state` is the replayed state just before the
 * decision (it is changed: pass a copy), `record` the recorded decision.
 */
export function prepareTest(input: {
	point: SummonPoint;
	state: PublicGameState;
	record: DecisionRecord;
	original: PlayCatalog;
	changed: PlayCatalog;
	testId: string;
}): PreparedTest {
	const { point, record, original, changed } = input;
	const seat = point.seat;
	const state = input.state;
	const after = new Map<string, PlayCatalogSpirit>(changed.spirits.map((s) => [s.id, s]));
	const flags: string[] = [];

	// What the current code offers on the ORIGINAL data, before anything is changed.
	const oldSurface = agentLegalCommands(state, seat, original);
	const oldSig = summonSignature(oldSurface.commands, state, seat);
	const recordedIds = record.actions.map((a) => a.actionId).sort();
	const nowIds = oldSurface.commands.map((c) => actionIdForCommand(c)).sort();
	if (!same(recordedIds, nowIds)) flags.push('harness-drift');

	const handSpirits = handOf(state, seat).filter((h) => h.spiritId);
	const missing = handSpirits.filter((h) => !after.has(h.spiritId!));
	if (missing.length)
		return {
			status: 'skip',
			flags: ['spirit-removed'],
			detail: `not in the changed data: ${missing.map((h) => h.name).join(', ')}`
		};
	const moved = handSpirits.filter(
		(h) => bagForSpiritCost(after.get(h.spiritId!)!.cost) !== point.bag
	);
	if (moved.length)
		return {
			status: 'skip',
			flags: ['bag-changed'],
			detail: `new cost puts them outside the ${point.bag}: ${moved
				.map((h) => `${h.name} (cost ${after.get(h.spiritId!)!.cost})`)
				.join(', ')}`
		};

	const table = refreshTableSpirits(state, original, changed);
	if (table.removed.length)
		return {
			status: 'skip',
			flags: ['board-spirit-removed'],
			detail: `table spirits not in the changed data: ${table.removed.join(', ')}`
		};
	if (table.refreshed) flags.push(`board-refreshed:${table.refreshed}`);
	if (table.kept) flags.push(`board-kept:${table.kept}`);

	const newSurface = agentLegalCommands(state, seat, changed);
	const newSig = summonSignature(newSurface.commands, state, seat);
	if (oldSig.spirits !== newSig.spirits || oldSig.extras !== newSig.extras)
		return {
			status: 'skip',
			flags: ['summon-options-changed'],
			detail: `summon options: [${oldSig.spirits}; ${oldSig.extras}] became [${newSig.spirits}; ${newSig.extras}]`
		};
	if (oldSig.others !== newSig.others) flags.push('other-options-changed');

	const built = buildDecision({
		state,
		seat,
		catalog: changed,
		gameId: input.testId,
		requestId: input.testId,
		events: recordedEvents(record.prompt),
		phaseDecisionIndex: recordedPhaseIndex(record.prompt),
		surface: newSurface
	});
	if (built.request.kind !== 'summon')
		return {
			status: 'skip',
			flags: ['not-a-summon'],
			detail: `the rebuilt decision is ${built.request.kind}`
		};
	const hand = handOf(state, seat);
	const options = built.request.actions.map((a) => {
		const { pick, spiritId } = pickOf(a.command, hand);
		return { id: a.id, pick, spiritId };
	});
	return {
		status: 'ok',
		flags,
		request: built.request,
		options,
		offered: options.filter((o) => o.pick === 'spirit').map((o) => o.spiritId!),
		sameAsRecorded: record.prompt ? record.prompt.includes(renderDecisionMessage(built.request)) : null
	};
}

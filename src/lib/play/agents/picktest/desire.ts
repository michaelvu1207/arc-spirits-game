/**
 * Pick test, desire extension: besides the pick, the model scores EVERY offered spirit 0-10
 * ("how much do you want this spirit for your board right now") in the same answer, and each
 * offer is marked as fitting the board or not.
 *
 * Prompt `desire-v1` (one user message): the normal decision message (renderDecisionMessage, the
 * same text a seat gets; no plan note), then {@link desireLine}. The pick is parsed exactly as
 * before (parseAnswer on the same answer); the scores are read from the same JSON object.
 *
 * FIT (an offered spirit fits the seat's board at that moment) when at least one holds:
 *   - origin: the board already has >= 2 spirits sharing one of its origins
 *   - class:  the board already has >= 1 of one of its classes AND that class still has a higher
 *             breakpoint to reach or scales per spirit ("1+"); a second copy of a class whose
 *             only breakpoint is already met (most single-spirit classes, e.g. the heroes')
 *             adds nothing, so it does not count as a fit
 *   - status: its awaken condition is a "Fallen" condition and the seat is Fallen
 * "The board" is the seat's spirits on the table, face-up or face-down.
 */

import { STATUS_LADDER, type PlayCatalog, type PublicGameState, type SeatColor } from '../../types';
import type { DecisionRequest } from '../contract';
import { firstJsonObject, renderDecisionMessage } from '../prompt';

export const DESIRE_PROMPT = 'desire-v1';
export const DESIRE_SCALE_HIGH = 8;

export interface DesireScore {
	score: number;
	why: string;
}

/** The scoring instruction added after the decision message. */
export function desireLine(ids: string[]): string {
	const entries = ids.map((id) => `"${id}": [<0-10>, "<at most 6 words>"]`).join(', ');
	return [
		'',
		`ALSO, in the same JSON object, score EVERY spirit you could summon here (${ids.join(', ')}): how much you want that spirit for your board right now, whatever you choose. 0 = useless for me here, 5 = fine, 10 = an instant pick for this board.`,
		`Add "desire": {${entries}} with every one of these ids, an integer score and a few words why.`
	].join('\n');
}

/** The user message of a desire-v1 test. */
export function desireUserMessage(request: DecisionRequest, ids: string[]): string {
	return `${renderDecisionMessage(request)}\n${desireLine(ids)}`;
}

/** The scores in an answer, by short id, or why they could not be read. */
export function parseDesire(
	text: string,
	ids: string[]
): { scores: Record<string, DesireScore> | null; error: string | null } {
	let raw = firstJsonObject(text)?.desire;
	// The scores may sit in a second JSON object: read the object after a "desire" key.
	if (!raw) {
		const at = text.search(/"desire"\s*:\s*\{/);
		if (at >= 0) raw = firstJsonObject(text.slice(text.indexOf('{', at)));
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw))
		return { scores: null, error: 'no "desire" object' };
	const scores: Record<string, DesireScore> = {};
	for (const id of ids) {
		const entry = (raw as Record<string, unknown>)[id] ?? (raw as Record<string, unknown>)[id.toUpperCase()];
		let score: unknown;
		let why: unknown = '';
		if (Array.isArray(entry)) [score, why] = entry;
		else if (entry && typeof entry === 'object') {
			score = (entry as Record<string, unknown>).score;
			why = (entry as Record<string, unknown>).why ?? (entry as Record<string, unknown>).reason;
		} else score = entry;
		const n = typeof score === 'string' ? Number(score) : score;
		if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 10)
			return { scores: null, error: `no 0-10 score for ${id}` };
		scores[id] = { score: Math.round(n), why: typeof why === 'string' ? why.slice(0, 80) : '' };
	}
	return { scores, error: null };
}

export interface Fit {
	fits: boolean;
	/** e.g. ["origin:Fire Region x3", "class:Fighter", "status:Fallen"]. */
	why: string[];
}

const FALLEN_CONDITION = /fallen/i;

/** Whether one more spirit of a class can still matter: a breakpoint above `have`, or "N+". */
export function classGrows(catalog: PlayCatalog, name: string, have: number): boolean {
	const schema = catalog.classes.find((c) => c.name === name)?.effectSchema;
	if (!Array.isArray(schema)) return false;
	return schema.some((tier) => {
		const count = (tier as { count?: unknown }).count;
		if (typeof count === 'string' && count.trim().endsWith('+')) return true;
		const n = typeof count === 'number' ? count : Number(count);
		return Number.isFinite(n) && n > have;
	});
}

/** Whether an offered spirit fits the seat's board (see the module comment). */
export function fitOf(
	state: PublicGameState,
	seat: SeatColor,
	spiritId: string,
	catalog: PlayCatalog
): Fit {
	const spirit = catalog.spirits.find((s) => s.id === spiritId);
	const player = state.players[seat];
	if (!spirit || !player) return { fits: false, why: [] };
	const board = player.spirits ?? [];
	const why: string[] = [];
	for (const origin of Object.keys(spirit.origins)) {
		const n = board.filter((s) => (s.origins?.[origin] ?? 0) > 0).length;
		if (n >= 2) why.push(`origin:${origin.replace(' Region', '')} x${n}`);
	}
	for (const cls of Object.keys(spirit.classes)) {
		const have = board.reduce((n, s) => n + (s.classes?.[cls] ?? 0), 0);
		if (have >= 1 && classGrows(catalog, cls, have)) why.push(`class:${cls} x${have}`);
	}
	const awaken = spirit.awaken;
	if (
		awaken?.kind === 'text' &&
		FALLEN_CONDITION.test(awaken.text) &&
		player.statusLevel >= STATUS_LADDER.indexOf('Fallen')
	)
		why.push('status:Fallen');
	return { fits: why.length > 0, why };
}

// ─── per-spirit numbers and classes ─────────────────────────────────────────

/** One offer of a spirit in one answered test. */
export interface Offer {
	spiritId: string;
	group: string;
	picked: boolean;
	/** null: the answer had no usable scores. */
	score: number | null;
	why: string;
	fits: boolean;
}

export interface DesireStats {
	offers: number;
	picked: number;
	pickRate: number;
	scored: number;
	desire: number;
	fitOffers: number;
	fitPickRate: number;
	fitDesire: number;
	noFitOffers: number;
	noFitPickRate: number;
	noFitDesire: number;
	/** Of the fitting offers: share scored >= 8 AND picked. */
	instantRate: number;
	/** Of all scored offers: share scored >= 8. */
	highShare: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function desireStats(offers: Offer[]): DesireStats {
	const scored = offers.filter((o) => o.score !== null);
	const fit = offers.filter((o) => o.fits);
	const noFit = offers.filter((o) => !o.fits);
	const rate = (os: Offer[]) => (os.length ? os.filter((o) => o.picked).length / os.length : NaN);
	const avg = (os: Offer[]) => mean(os.filter((o) => o.score !== null).map((o) => o.score!));
	return {
		offers: offers.length,
		picked: offers.filter((o) => o.picked).length,
		pickRate: rate(offers),
		scored: scored.length,
		desire: avg(offers),
		fitOffers: fit.length,
		fitPickRate: rate(fit),
		fitDesire: avg(fit),
		noFitOffers: noFit.length,
		noFitPickRate: rate(noFit),
		noFitDesire: avg(noFit),
		instantRate: fit.length
			? fit.filter((o) => o.picked && (o.score ?? 0) >= DESIRE_SCALE_HIGH).length / fit.length
			: NaN,
		highShare: scored.length
			? scored.filter((o) => o.score! >= DESIRE_SCALE_HIGH).length / scored.length
			: NaN
	};
}

export type SpiritClass = 'Generalist' | 'Build-around' | 'Situational' | 'Dead' | 'Unclear';

/** The thresholds (also printed in the report). */
export const CLASS_RULES = {
	/** Generalist: pick rate at least its group's average AND average desire >= this. */
	generalistDesire: 6,
	/** Build-around: when it fits, average desire >= this OR instant-pick rate >= instantRate. */
	buildDesire: 7,
	buildInstant: 0.35,
	/** Fitting offers needed to judge "when it fits". */
	minFit: 3,
	/** Dead: average desire when it fits below this (with too few fitting offers: Unclear). */
	deadDesire: 4
};

export function classify(s: DesireStats, groupPickRate: number): SpiritClass {
	const r = CLASS_RULES;
	if (s.pickRate >= groupPickRate && s.desire >= r.generalistDesire) return 'Generalist';
	const judgeFit = s.fitOffers >= r.minFit;
	if (judgeFit && (s.fitDesire >= r.buildDesire || s.instantRate >= r.buildInstant))
		return 'Build-around';
	if (judgeFit && s.fitDesire < r.deadDesire) return 'Dead';
	// Low overall but (almost) never seen on a board it fits: "dead" cannot be told apart from
	// "build-around for a board the records rarely reach".
	if (!judgeFit && s.desire < r.deadDesire) return 'Unclear';
	return 'Situational';
}

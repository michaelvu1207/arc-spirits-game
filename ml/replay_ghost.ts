/**
 * Ghost-replay counterfactual for a recorded live game (built for room U94RP3,
 * the 2026-07-02 playtest: Michael 25 VP vs neural bots 15/14/0).
 *
 * Question it answers: "could the bots have beaten my game if they played
 * better?" — without the human replaying anything. The human seat (the GHOST)
 * replays its recorded command line verbatim; the bot seats think FRESH with
 * the current policy + current rules. The monster ladder is shared, so the
 * counterfactual is honest: if a bot outraces the ghost to a rung, the ghost's
 * historical kill simply isn't there any more (its recorded command falls back
 * tier-by-tier: exact → same-type coercion → skip). Dice are fair (no forced
 * outcomes): the ghost keeps the same DECISIONS, not the same luck, so across
 * many runs its score should center near the historical result — which is
 * itself the replay-fidelity check.
 *
 * Modes:
 *   validate — replay every recorded event verbatim and diff the result against
 *              the recorded final snapshot (engine determinism check).
 *   cf       — N counterfactual runs. Run 0 is deterministic (argmax bots);
 *              runs 1..N-1 sample bot decisions (temperature 0.8, seeded rand)
 *              for spread.
 *
 * Usage:
 *   npx tsx ml/replay_ghost.ts validate <events.json> <final_state.json>
 *   npx tsx ml/replay_ghost.ts cf <events.json> <runs> <out.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	createLobbyState,
	applyGameCommand,
	applyDeadlineAdvance
} from '../src/lib/play/runtime';
import { legalActionsWithNext } from '../src/lib/play/ml/actions';
import { botSeatNeedsToAct } from '../src/lib/play/server/botPolicy';
import { hybridIndex, getNeuralPolicy, type NeuralPolicy } from '../src/lib/play/ml/neuralBot';
import { VP_TO_WIN } from '../src/lib/play/types';
import type {
	GameActor,
	GameCommand,
	PlayCatalog,
	PublicGameState,
	SeatColor
} from '../src/lib/play/types';

interface EventRow {
	revision: number;
	actor_member_id: string;
	command_type: string;
	command_payload: GameCommand;
	created_at: string;
	// stamped during the validation pass:
	round?: number;
	phase?: string;
	seat?: SeatColor;
}

const SETUP_TYPES = new Set(['claimSeat', 'selectGuardian', 'startGame']);
/** Server/host plumbing rows — never part of any seat's own line. */
const PLUMBING_TYPES = new Set(['enforceDeadline', 'forceAdvancePhase']);
/** Fallback order when the ghost's recorded line is exhausted but it still gates the phase. */
const PASSIVE_TYPES = [
	'discardSpirit',
	'discardHandDraws',
	'discardRune',
	'resolveMonsterReward',
	'commitCleanup',
	'commitBenefits',
	'commitAwakening',
	'endLocationActions',
	'lockNavigation'
];

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function loadCatalog(): PlayCatalog {
	return JSON.parse(readFileSync(join('ml', 'catalog.json'), 'utf8')) as PlayCatalog;
}

/** member id → seat, learned from the recorded claimSeat rows. */
function seatMap(events: EventRow[]): Map<string, SeatColor> {
	const m = new Map<string, SeatColor>();
	for (const r of events) {
		if (r.command_type === 'claimSeat') {
			m.set(r.actor_member_id, (r.command_payload as { seatColor: SeatColor }).seatColor);
		}
	}
	return m;
}

function makeActor(memberId: string, seat: SeatColor | null, hostMemberId: string): GameActor {
	return {
		memberId,
		displayName: memberId.slice(0, 8),
		role: memberId === hostMemberId ? 'host' : 'player',
		seatColor: seat
	} as GameActor;
}

interface ReplayBase {
	state: PublicGameState;
	events: EventRow[]; // round/phase/seat-annotated, in order
	hostMemberId: string;
	seats: Map<string, SeatColor>;
	rejects: { revision: number; type: string; error: string }[];
	/** Ghost seat's end-of-round line: round → {vp, status, corruptions}. */
	ghostHistory: Map<number, { vp: number; status: number; corruptions: number }>;
}

/**
 * Replay the full recorded stream verbatim (the game exactly as it happened),
 * annotating each row with the (round, phase) it was issued in.
 */
function replayVerbatim(events: EventRow[], catalog: PlayCatalog): ReplayBase {
	const seats = seatMap(events);
	const hostMemberId = events[0]!.actor_member_id; // first claimSeat = room creator/host
	const roomCode = 'U94RP3';
	let state = createLobbyState({
		roomCode,
		guardianNames: catalog.guardians.map((g) => g.name)
	});
	const rejects: ReplayBase['rejects'] = [];
	const ghostSeat = seats.get(hostMemberId)!;
	const ghostHistory = new Map<number, { vp: number; status: number; corruptions: number }>();
	const noteGhost = (s: PublicGameState) => {
		const p = s.players[ghostSeat];
		if (!p || s.round <= 0) return;
		ghostHistory.set(s.round, {
			vp: p.victoryPoints ?? 0,
			status: p.statusLevel ?? 0,
			corruptions: p.corruptionCount ?? 0
		});
	};
	for (const row of events) {
		row.round = state.round;
		row.phase = state.phase;
		row.seat = seats.get(row.actor_member_id);
		if (row.command_type === 'enforceDeadline') {
			applyDeadlineAdvance(state, catalog);
			noteGhost(state);
			continue;
		}
		const actor = makeActor(row.actor_member_id, row.seat ?? null, hostMemberId);
		const res = applyGameCommand(state, actor, row.command_payload, catalog);
		if (res.ok) {
			state = res.state;
			noteGhost(state); // last write per round wins = end-of-round line
		} else {
			rejects.push({ revision: row.revision, type: row.command_type, error: res.error.code });
		}
	}
	return { state, events, hostMemberId, seats, rejects, ghostHistory };
}

function summarizeSeats(state: PublicGameState) {
	const out: Record<string, unknown> = {};
	for (const seat of state.activeSeats) {
		const p = state.players[seat]!;
		out[seat] = {
			vp: p.victoryPoints ?? 0,
			status: p.statusLevel ?? 0,
			corruptions: p.corruptionCount ?? 0,
			spirits: p.spirits?.length ?? 0
		};
	}
	return out;
}

// ── validate ────────────────────────────────────────────────────────────────
function runValidate(eventsPath: string, snapshotPath: string, catalog: PlayCatalog) {
	const events = JSON.parse(readFileSync(eventsPath, 'utf8')) as EventRow[];
	const snapRaw = JSON.parse(readFileSync(snapshotPath, 'utf8'));
	const snap = (snapRaw.state ?? snapRaw) as PublicGameState;
	const { state, rejects } = replayVerbatim(events, catalog);
	const report = {
		rejects,
		sim: {
			rng: state.rng,
			round: state.round,
			phase: state.phase,
			revision: state.revision,
			winnerSeat: state.winnerSeat,
			seats: summarizeSeats(state)
		},
		snapshot: {
			rng: snap.rng,
			round: snap.round,
			phase: snap.phase,
			revision: snap.revision,
			winnerSeat: snap.winnerSeat,
			seats: summarizeSeats(snap)
		}
	};
	const exact =
		rejects.length === 0 &&
		state.rng.cursor === snap.rng.cursor &&
		state.rng.seed === snap.rng.seed &&
		JSON.stringify(report.sim.seats) === JSON.stringify(report.snapshot.seats);
	console.log(JSON.stringify({ exact, ...report }, null, 1));
	if (!exact) process.exitCode = 1;
}

// ── counterfactual ──────────────────────────────────────────────────────────
interface CfRun {
	run: number;
	sampled: boolean;
	endRound: number;
	endPhase: string;
	winnerSeat: SeatColor | null;
	trueTargetWin: boolean; // someone actually reached VP_TO_WIN
	seats: Record<string, unknown>;
	ghost: { exact: number; coerced: number; skipped: number; fallback: number };
	deadlineAdvances: number;
	iterations: number;
}

function runCf(
	eventsPath: string,
	runs: number,
	outPath: string,
	catalog: PlayCatalog,
	policy: NeuralPolicy,
	pace = false
) {
	const eventsMaster = JSON.parse(readFileSync(eventsPath, 'utf8')) as EventRow[];
	// Annotation pass (also proves the base replay works before we branch it).
	const base = replayVerbatim(
		JSON.parse(readFileSync(eventsPath, 'utf8')) as EventRow[],
		catalog
	);
	if (base.rejects.length > 0) {
		throw new Error(`base replay rejected ${base.rejects.length} rows — fix before counterfactuals`);
	}
	const seats = base.seats;
	const hostMemberId = base.hostMemberId;
	const ghostSeat = seats.get(hostMemberId)!; // Red — the human host
	const memberOf = new Map<SeatColor, string>();
	for (const [m, s] of seats) memberOf.set(s, m);

	// The ghost's line, keyed by the (round, phase) it was recorded in.
	const ghostQ = new Map<string, GameCommand[]>();
	for (const row of base.events) {
		if (row.seat !== ghostSeat) continue;
		if (SETUP_TYPES.has(row.command_type) || PLUMBING_TYPES.has(row.command_type)) continue;
		const key = `${row.round}|${row.phase}`;
		if (!ghostQ.has(key)) ghostQ.set(key, []);
		ghostQ.get(key)!.push(row.command_payload);
	}

	const results: CfRun[] = [];
	for (let run = 0; run < runs; run++) {
		const sampled = run > 0;
		const rand = mulberry32(0xa5f00d + run);
		// identical setup: claimSeat/selectGuardian/startGame verbatim
		let state = createLobbyState({
			roomCode: 'U94RP3',
			guardianNames: catalog.guardians.map((g) => g.name)
		});
		for (const row of eventsMaster) {
			if (!SETUP_TYPES.has(row.command_type)) continue;
			const actor = makeActor(row.actor_member_id, seats.get(row.actor_member_id) ?? null, hostMemberId);
			const res = applyGameCommand(state, actor, row.command_payload, catalog);
			if (!res.ok) throw new Error(`setup row rejected: ${row.command_type} ${res.error.code}`);
			state = res.state;
		}

		const fid = { exact: 0, coerced: 0, skipped: 0, fallback: 0 };
		const qPos = new Map<string, number>();
		const stamped = new Set<number>();
		let deadlineAdvances = 0;
		let iterations = 0;

		const actorFor = (seat: SeatColor) => makeActor(memberOf.get(seat)!, seat, hostMemberId);

		/**
		 * PACE mode: the ghost seat never plays — it is a phantom pacer. Each round its
		 * VP/status/corruption are stamped to the HISTORICAL end-of-round line (the human's
		 * real trajectory), it never blocks a phase, and it never touches the shared
		 * monster ladder. The bots race that clock over the full recorded horizon. NOTE the
		 * pro-bot bias: the rungs the human really killed stay available to the bots here.
		 */
		const phantomStep = (): boolean => {
			const red = state.players[ghostSeat];
			if (!red) return false;
			let progressed = false;
			// Stamp the pace BEFORE resolving cleanup (the commit can advance the round).
			if (state.phase === 'cleanup' && !stamped.has(state.round)) {
				stamped.add(state.round);
				const h = base.ghostHistory.get(state.round) ?? base.ghostHistory.get(state.round - 1);
				if (h) {
					red.victoryPoints = h.vp;
					red.statusLevel = h.status;
					red.corruptionCount = h.corruptions;
				}
			}
			if (state.phase === 'navigation') {
				if (state.navigation[ghostSeat]?.locked !== true) {
					const act = legalActionsWithNext(state, ghostSeat, catalog).find(
						(a) => a.cmd.type === 'lockNavigation'
					);
					if (act) {
						const res = applyGameCommand(state, actorFor(ghostSeat), act.cmd, catalog);
						if (res.ok) {
							state = res.state;
							progressed = true;
						}
					}
				}
				return progressed;
			}
			let guard = 0;
			while (botSeatNeedsToAct(state, ghostSeat) && guard++ < 20) {
				const legal = legalActionsWithNext(state, ghostSeat, catalog);
				const pick = PASSIVE_TYPES.map((t) => legal.find((a) => a.cmd.type === t)).find(Boolean);
				if (!pick) {
					red.phaseReady = true; // nothing sensible left — never gate the phase
					progressed = true;
					break;
				}
				const res = applyGameCommand(state, actorFor(ghostSeat), pick.cmd, catalog);
				if (!res.ok) {
					state.players[ghostSeat]!.phaseReady = true;
					progressed = true;
					break;
				}
				state = res.state;
				progressed = true;
			}
			return progressed;
		};

		const ghostStep = (): boolean => {
			let progressed = false;
			// Drain the recorded line for the CURRENT (round, phase); the key can shift
			// under us when a command advances the phase, so re-derive it each pass.
			for (;;) {
				const key = `${state.round}|${state.phase}`;
				const q = ghostQ.get(key) ?? [];
				let pos = qPos.get(key) ?? 0;
				if (pos >= q.length) break;
				const cmd = q[pos]!;
				pos += 1;
				qPos.set(key, pos);
				const exact = applyGameCommand(state, actorFor(ghostSeat), cmd, catalog);
				if (exact.ok) {
					state = exact.state;
					fid.exact += 1;
					progressed = true;
					continue;
				}
				const sameType = legalActionsWithNext(state, ghostSeat, catalog).find(
					(a) => a.cmd.type === cmd.type
				);
				if (sameType) {
					const res = applyGameCommand(state, actorFor(ghostSeat), sameType.cmd, catalog);
					if (res.ok) {
						state = res.state;
						fid.coerced += 1;
						progressed = true;
						continue;
					}
				}
				fid.skipped += 1;
			}
			// Recorded line exhausted but the ghost still gates the phase → mandatory/pass.
			let guard = 0;
			while (botSeatNeedsToAct(state, ghostSeat) && guard++ < 20) {
				const legal = legalActionsWithNext(state, ghostSeat, catalog);
				const pick = PASSIVE_TYPES.map((t) => legal.find((a) => a.cmd.type === t)).find(Boolean);
				if (!pick) break;
				const res = applyGameCommand(state, actorFor(ghostSeat), pick.cmd, catalog);
				if (!res.ok) break;
				state = res.state;
				fid.fallback += 1;
				progressed = true;
			}
			return progressed;
		};

		const botStep = (seat: SeatColor): boolean => {
			let progressed = false;
			let guard = 0;
			while (botSeatNeedsToAct(state, seat) && guard++ < 40) {
				const withNext = legalActionsWithNext(state, seat, catalog);
				if (withNext.length === 0) break;
				const idx = hybridIndex(
					policy,
					state,
					seat,
					withNext,
					sampled ? { sample: true, temperature: 0.8, rand } : { sample: false },
					catalog
				);
				const res = applyGameCommand(state, actorFor(seat), withNext[idx]!.cmd, catalog);
				if (!res.ok) break;
				state = res.state;
				progressed = true;
			}
			return progressed;
		};

		while (state.status === 'active' && iterations++ < 30000) {
			let progressed = false;
			for (const seat of [...state.activeSeats]) {
				if (state.status !== 'active') break;
				progressed =
					(seat === ghostSeat ? (pace ? phantomStep() : ghostStep()) : botStep(seat)) || progressed;
			}
			if (state.status !== 'active') break;
			if (!progressed) {
				const rev = state.revision;
				applyDeadlineAdvance(state, catalog);
				deadlineAdvances += 1;
				if (state.revision === rev) break; // hard stuck — bail
			}
		}

		const trueTargetWin =
			state.winnerSeat != null &&
			(state.players[state.winnerSeat]?.victoryPoints ?? 0) >= VP_TO_WIN;
		results.push({
			run,
			sampled,
			endRound: state.round,
			endPhase: state.phase,
			winnerSeat: state.winnerSeat ?? null,
			trueTargetWin,
			seats: summarizeSeats(state),
			ghost: fid,
			deadlineAdvances,
			iterations
		});
		const line = results[results.length - 1]!;
		console.log(
			`run ${run}${sampled ? ' (sampled)' : ' (argmax)'}: winner=${line.winnerSeat} round=${line.endRound} seats=${JSON.stringify(line.seats)} ghost=${JSON.stringify(line.ghost)}`
		);
	}

	// Aggregate
	const ghostVps = results.map((r) => (r.seats[ghostSeat] as { vp: number }).vp);
	const botSeats = [...memberOf.keys()].filter((s) => s !== ghostSeat);
	const botBeatsGhost = results.filter((r) =>
		botSeats.some(
			(s) => ((r.seats[s] as { vp: number })?.vp ?? 0) > ((r.seats[ghostSeat] as { vp: number })?.vp ?? 0)
		)
	).length;
	const botWins = results.filter((r) => r.winnerSeat != null && r.winnerSeat !== ghostSeat).length;
	const botTrue30 = results.filter(
		(r) => r.trueTargetWin && r.winnerSeat != null && r.winnerSeat !== ghostSeat
	).length;
	const summary = {
		runs,
		ghostSeat,
		ghostVp: { mean: ghostVps.reduce((a, b) => a + b, 0) / runs, min: Math.min(...ghostVps), max: Math.max(...ghostVps) },
		botWins,
		botBeatsGhostVp: botBeatsGhost,
		botTrue30Wins: botTrue30,
		maxBotVp: Math.max(
			...results.flatMap((r) => botSeats.map((s) => ((r.seats[s] as { vp: number })?.vp ?? 0)))
		)
	};
	writeFileSync(outPath, JSON.stringify({ summary, results }, null, 1));
	console.log('SUMMARY ' + JSON.stringify(summary));
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
	const [mode, ...rest] = process.argv.slice(2);
	const catalog = loadCatalog();
	if (mode === 'validate') {
		const [eventsPath, snapshotPath] = rest;
		runValidate(eventsPath!, snapshotPath!, catalog);
	} else if (mode === 'cf' || mode === 'pace') {
		const [eventsPath, runsStr, outPath] = rest;
		const policy = await getNeuralPolicy();
		if (!policy) throw new Error('no neural policy bundled');
		runCf(
			eventsPath!,
			parseInt(runsStr ?? '20', 10),
			outPath ?? 'ml/replay_cf.json',
			catalog,
			policy,
			mode === 'pace'
		);
	} else {
		console.error(
			'usage: replay_ghost.ts validate <events.json> <final_state.json> | cf|pace <events.json> <runs> <out.json>'
		);
		process.exitCode = 2;
	}
}
main();

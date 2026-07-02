/**
 * GAUNTLET-V1 runner — scores ONE candidate on the frozen gauntlet (see ./manifest.ts).
 * The manifest is the spec; this file only executes it. GAUNTLET=1 to run.
 *
 *   # a weights candidate (any policy JSON at the current 62/52 contract):
 *   GAUNTLET=1 GAUNTLET_WEIGHTS=src/lib/play/ml/policy-weights.json \
 *     npx vitest run src/lib/play/ml/gauntlet/_gauntlet.test.ts --disable-console-intercept
 *
 *   # a heuristic candidate (any BOT_PROFILES name):
 *   GAUNTLET=1 GAUNTLET_PROFILE=pvphunter npx vitest run ... --disable-console-intercept
 *
 *   # a SERVED candidate (ml/infer_server.py socket) — scores the checkpoint the server
 *   # holds directly, no distilled proxy. Add GAUNTLET_POLICY_OBS_VERSION=2 for an
 *   # arc-entity-scorer-v2 checkpoint (candidate plays on flattenObsV2 through
 *   # RemotePolicy exactly as the actor pool does; anchors stay in-process v1):
 *   GAUNTLET=1 GAUNTLET_INFER_SOCKET=/tmp/arc-infer.sock GAUNTLET_POLICY_OBS_VERSION=2 \
 *     npx vitest run ... --disable-console-intercept
 *
 *   # smoke run (truncates the frozen schedule; multiples of 4 keep seed pairs intact):
 *   GAUNTLET=1 GAUNTLET_GAMES=8 GAUNTLET_WEIGHTS=... npx vitest run ...
 *
 * Results are written to ml/gauntlet_results/<candidate-slug>.json (override with
 * GAUNTLET_OUT) so they survive vitest's console interception. Smoke runs (fewer than
 * the full 800 games) are labeled `smoke: true` — never quote a smoke number as a
 * gauntlet score.
 */
import { describe, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { BOT_PROFILES, profileFor } from '../../server/botPolicy';
import { SEAT_COLORS, type SeatColor } from '../../types';
import { playRecordingGame } from '../driver';
import { OBS_DIM } from '../encode';
import { obsV2Meta } from '../encodeV2';
import { asNeuralPolicy, RemotePolicy } from '../inferenceClient';
import { loadOrSnapshotCatalog, loadPolicyForEval, mlPath } from '../nodeIo';
import type { NeuralPolicy } from '../net';
import {
	GAUNTLET_VERSION,
	GAUNTLET_MAX_ROUNDS,
	GAUNTLET_SEATS,
	TOTAL_GAMES,
	CHECKPOINT_ANCHORS,
	HEURISTIC_ANCHORS,
	buildSchedule,
	eloFromScore
} from './manifest';

const RUN = process.env.GAUNTLET === '1';

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

interface PairTally {
	games: number;
	scoreSum: number; // win 1 / tie 0.5 / loss 0 vs this anchor, summed
}

describe('gauntlet-v1', () => {
	(RUN ? it : it.skip)(
		'score one candidate on the frozen gauntlet',
		async () => {
			const weightsPath = process.env.GAUNTLET_WEIGHTS;
			const profileName = process.env.GAUNTLET_PROFILE;
			const inferSocket = process.env.GAUNTLET_INFER_SOCKET;
			if ([weightsPath, profileName, inferSocket].filter(Boolean).length !== 1) {
				throw new Error(
					'gauntlet: set exactly one of GAUNTLET_WEIGHTS, GAUNTLET_PROFILE or GAUNTLET_INFER_SOCKET'
				);
			}
			const policyObsVersion = parseInt(process.env.GAUNTLET_POLICY_OBS_VERSION ?? '1', 10);
			if (policyObsVersion !== 1 && policyObsVersion !== 2) {
				throw new Error(`gauntlet: GAUNTLET_POLICY_OBS_VERSION must be 1 or 2`);
			}
			if (policyObsVersion === 2 && !inferSocket) {
				throw new Error('gauntlet: GAUNTLET_POLICY_OBS_VERSION=2 requires GAUNTLET_INFER_SOCKET');
			}
			const totalGames = parseInt(process.env.GAUNTLET_GAMES ?? String(TOTAL_GAMES), 10);

			const catalog = await loadOrSnapshotCatalog();

			// ── Candidate ────────────────────────────────────────────────────────────
			let candidatePolicy: NeuralPolicy | null = null;
			let remote: RemotePolicy | null = null;
			let candidateRef: string;
			let slug: string;
			if (weightsPath) {
				candidatePolicy = loadPolicyForEval(resolve(process.cwd(), weightsPath));
				candidateRef = weightsPath;
				slug = slugify(
					weightsPath
						.replace(/\.json$/, '')
						.split('/')
						.filter(Boolean)
						.slice(-2)
						.join('--')
				);
			} else if (inferSocket) {
				// Served candidate: plays through RemotePolicy exactly as the actor pool does.
				// candidateRef is the SERVER-REPORTED checkpoint path (info handshake), so a
				// direct-socket score can never be confused with a distilled-proxy score.
				remote = new RemotePolicy(inferSocket, {
					expectObsDim: policyObsVersion === 2 ? obsV2Meta(catalog).flatLength : OBS_DIM
				});
				candidatePolicy = asNeuralPolicy(remote);
				candidateRef = remote.info.weights;
				slug = `socket--${slugify(
					candidateRef
						.replace(/\.(json|pt)$/, '')
						.split('/')
						.filter(Boolean)
						.slice(-2)
						.join('--')
				)}`;
			} else {
				// profileFor silently falls back to RANDOM_PROFILE for unknown names — the
				// gauntlet must never score the wrong bot, so gate on the real table.
				if (!BOT_PROFILES[profileName!]) {
					throw new Error(`gauntlet: unknown profile '${profileName}'`);
				}
				candidateRef = profileName!;
				slug = `profile-${slugify(profileName!)}`;
			}

			// ── Anchors (frozen pool; an unloadable ACTIVE checkpoint is a hard error —
			//     silently shrinking the pool would change the measure) ────────────────
			const anchorPolicies = new Map<string, NeuralPolicy>();
			for (const c of CHECKPOINT_ANCHORS) {
				if (c.status !== 'active') continue;
				const abs = resolve(process.cwd(), c.path);
				if (!existsSync(abs)) {
					throw new Error(`gauntlet: active checkpoint anchor '${c.name}' missing at ${c.path}`);
				}
				anchorPolicies.set(c.name, loadPolicyForEval(abs)); // throws on dim mismatch
			}
			for (const name of HEURISTIC_ANCHORS) {
				if (!BOT_PROFILES[name])
					throw new Error(`gauntlet: anchor profile '${name}' not in BOT_PROFILES`);
			}

			const seats = SEAT_COLORS.slice(0, GAUNTLET_SEATS) as SeatColor[];
			const schedule = buildSchedule(totalGames);

			try {
				// ── Play ─────────────────────────────────────────────────────────────────
				const perAnchor = new Map<string, PairTally>();
				const agg: PairTally = { games: 0, scoreSum: 0 };
				let wins = 0;
				let sumPlace = 0;
				let sumVP = 0;
				let sumRounds = 0;
				let finished = 0;
				const t0 = Date.now();

				for (const g of schedule) {
					const candidateSeat = seats[g.candidateSeatIdx];
					const otherSeats = seats.filter((s) => s !== candidateSeat);
					// anchors[j] → the ((j + rotation) % 3)-th non-candidate seat (manifest scheme)
					const anchorBySeat = new Map<SeatColor, string>();
					g.anchors.forEach((name, j) => {
						anchorBySeat.set(otherSeats[(j + g.rotation) % otherSeats.length], name);
					});

					const neuralSeats: SeatColor[] = [];
					const opponentPolicies: Partial<Record<SeatColor, NeuralPolicy>> = {};
					const profiles = seats.map((seat) => {
						if (seat === candidateSeat) {
							if (candidatePolicy) {
								neuralSeats.push(seat);
								return profileFor('medium'); // unstick fallback only, as in _elo
							}
							return BOT_PROFILES[candidateRef];
						}
						const anchor = anchorBySeat.get(seat)!;
						const pol = anchorPolicies.get(anchor);
						if (pol) {
							neuralSeats.push(seat);
							opponentPolicies[seat] = pol;
							return profileFor('medium');
						}
						return profileFor(anchor);
					});

					// `policy` must be non-null whenever any seat is neural (driver gate); anchor
					// seats always resolve through opponentPolicies, so passing an anchor policy
					// for a heuristic candidate is inert.
					const policy =
						candidatePolicy ?? (neuralSeats.length ? [...anchorPolicies.values()][0] : undefined);
					const r = playRecordingGame(catalog, {
						seed: g.seed,
						profiles,
						maxRounds: GAUNTLET_MAX_ROUNDS,
						policy,
						selection: 'hybrid',
						neuralSeats,
						opponentPolicies,
						recordSeats: [],
						// Socket candidates may play on flat v2 obs; anchors stay in-process v1
						// (the driver wraps only the learner policy, never opponentPolicies).
						policyObsVersion: policyObsVersion === 2 ? 2 : undefined
					});

					const candVP = r.finalVP[candidateSeat] ?? 0;
					const otherVPs = otherSeats.map((s) => r.finalVP[s] ?? 0);
					sumPlace += 1 + otherVPs.filter((v) => v > candVP).length;
					sumVP += candVP;
					sumRounds += r.rounds;
					if (r.winnerSeat === candidateSeat) wins += 1;
					if (r.finished) finished += 1;
					for (const [seat, anchor] of anchorBySeat) {
						const oppVP = r.finalVP[seat] ?? 0;
						const score = candVP > oppVP ? 1 : candVP === oppVP ? 0.5 : 0;
						const t = perAnchor.get(anchor) ?? { games: 0, scoreSum: 0 };
						t.games += 1;
						t.scoreSum += score;
						perAnchor.set(anchor, t);
						agg.games += 1;
						agg.scoreSum += score;
					}
					if ((g.game + 1) % 20 === 0 || g.game === schedule.length - 1) {
						// eslint-disable-next-line no-console
						console.log(
							`[gauntlet] ${g.game + 1}/${schedule.length} games, ${((Date.now() - t0) / (g.game + 1) / 1000).toFixed(1)}s/game`
						);
					}
				}

				// ── Score + write ────────────────────────────────────────────────────────
				const n = schedule.length;
				const wallClockMs = Date.now() - t0;
				const perAnchorOut: Record<string, { games: number; score: number; elo: number }> = {};
				for (const [name, t] of [...perAnchor.entries()].sort()) {
					perAnchorOut[name] = {
						games: t.games,
						score: t.scoreSum / t.games,
						elo: eloFromScore(t.scoreSum, t.games)
					};
				}
				const result = {
					gauntletVersion: GAUNTLET_VERSION,
					candidate: {
						kind: weightsPath ? 'weights' : inferSocket ? 'socket' : 'profile',
						ref: candidateRef, // socket runs: the SERVER-reported checkpoint path
						slug
					},
					// Transport provenance — a direct-socket v2 score must never be confused
					// with a distilled-proxy score of "the same" checkpoint.
					via: inferSocket ? 'socket' : 'in-process',
					policyObsVersion,
					games: n,
					smoke: n < TOTAL_GAMES,
					eloVsAnchors: {
						aggregate: {
							games: agg.games,
							score: agg.scoreSum / agg.games,
							elo: eloFromScore(agg.scoreSum, agg.games)
						},
						perAnchor: perAnchorOut
					},
					meanPlacement: sumPlace / n,
					winRate: wins / n,
					meanVP: sumVP / n,
					meanRounds: sumRounds / n,
					finishedRate: finished / n,
					wallClockMs,
					msPerGame: wallClockMs / n,
					timestamp: new Date().toISOString()
				};
				const out = process.env.GAUNTLET_OUT
					? resolve(process.cwd(), process.env.GAUNTLET_OUT)
					: mlPath('gauntlet_results', `${slug}.json`);
				mkdirSync(dirname(out), { recursive: true });
				writeFileSync(out, JSON.stringify(result, null, 2));

				// eslint-disable-next-line no-console
				console.log(
					`[gauntlet] ${candidateRef}: elo=${result.eloVsAnchors.aggregate.elo} ` +
						`place=${result.meanPlacement.toFixed(2)} win=${(100 * result.winRate).toFixed(1)}% ` +
						`vp=${result.meanVP.toFixed(1)} games=${n}${result.smoke ? ' (SMOKE — not a gauntlet score)' : ''}`
				);
				for (const [name, s] of Object.entries(perAnchorOut)) {
					// eslint-disable-next-line no-console
					console.log(
						`[gauntlet]   vs ${name.padEnd(16)} score=${s.score.toFixed(3)} elo=${String(s.elo).padStart(5)} n=${s.games}`
					);
				}
				// eslint-disable-next-line no-console
				console.log(`[gauntlet] DONE → ${out}`);
			} finally {
				remote?.close();
			}
		},
		24 * 60 * 60 * 1000
	);
});

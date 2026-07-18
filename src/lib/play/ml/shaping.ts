/**
 * Reward shaping for VP-MAXIMIZATION.
 *
 * This module supplies the dense Victory Point and build-progress part of the objective.
 * PPO additionally supplies terminal placement, true-win, and all-Fallen outcomes. Keeping
 * those concerns separate makes the dense discovery signal inspectable without pretending
 * that final VP alone is the complete competitive objective.
 *
 * Historical per-step reward  r_t = ΔVP (normalized) + Φ_build(s_{t+1}) − Φ_build(s_t)
 *   - ΔVP is the PRIMARY signal — summed over a game it telescopes to final VP.
 *   - Φ_build (attack dice, max barrier = Cultivator scaling, awakened spirits, corruption)
 *     guides discovery toward the build that produces VP.
 *   - The historical form retains final Φ and is therefore an explicit engine objective, not
 *     policy-invariant. `PotentialShapingMode='policy-invariant'` uses Ng et al.'s discounted
 *     γΦ(s')−Φ(s), with Φ(terminal)=0, so shaping cannot reward unused terminal engine.
 * Return-to-go  G_t = Σ_k γ^{k−t} r_k.  γ<1 ⇒ near-term VP worth more ⇒ optimizes VP/TURN.
 *
 * Build weights are configurable so a population can be guided toward distinct VP routes.
 * In corrected mode they change learning guidance, not the terminal objective.
 */

import { VP_TO_WIN, type PrivatePlayerState } from '../types';
import { awakenedClassCounts } from '../effects/apply';

/** Auxiliary build-progress proxies (NOT VP — VP is the direct reward). */
export interface ShapingWeights {
	dice: number;
	maxBarrier: number;
	awakened: number;
	status: number;
	/** Reward INTERMEDIATE progress toward the non-corrupt win engines — holding Cultivators
	 *  (toward the maxBarrier breakpoint) and VP-classes (World Ender/Golden Ruler). This gives a
	 *  DENSE gradient to ASSEMBLE multi-spirit setups whose final payoff (maxBarrier / +1-VP-round)
	 *  is otherwise invisible to a 1-step scorer until the breakpoint. Optional (defaults to 0). */
	classProgress?: number;
	/** Credit for HOLDING face-down (unawakened) spirits — min(1, faceDownCount/7). `awakened`
	 *  only ever credits face-UP spirits, so a spirit that is summoned but not yet awakened earned
	 *  zero potential; this term gives it some, so an unawakened Abyss Summon finally counts toward
	 *  Φ instead of looking like a wasted action. Optional (defaults to 0). */
	faceDown?: number;
	/** Credit for ATTACK POWER — min(1, expectedAttack/20) where expectedAttack is the dice pool's
	 *  summed mean face value (basic 1/3, enchanted 2/3, exalted 1, arcane 2), the same expRoll the
	 *  encoder exposes. Michael's diagnosis of the Fallen spiral: the bot accumulates far less attack
	 *  power than a strong opponent, so its fights keep failing and its corruptions are worthless.
	 *  This rewards the ENGINE (fight-winning power) directly instead of penalizing the corruption
	 *  symptom. Optional (defaults to 0). */
	attackPower?: number;
}

/**
 * The historical reward used a plain `Phi(next) - Phi(current)` delta and retained
 * `Phi(final)` at a terminal state. That is useful as an explicit engine objective,
 * but it is not policy-invariant under discounted RL and can reward an engine that
 * is never converted into VP. The corrected mode uses Ng et al.'s discounted form
 * `gamma * Phi(next) - Phi(current)` and defines terminal potential as zero.
 */
export type PotentialShapingMode = 'legacy-terminal-retention' | 'policy-invariant';

export function potentialShapingDelta(
	currentPhi: number,
	nextPhi: number,
	gamma: number,
	terminal: boolean,
	mode: PotentialShapingMode = 'legacy-terminal-retention'
): number {
	if (mode === 'policy-invariant') {
		return gamma * (terminal ? 0 : nextPhi) - currentPhi;
	}
	return nextPhi - currentPhi;
}

/** Dice-tier mean face value (matches encode.ts expRoll: basic 1/3, enchanted 2/3, exalted 1, arcane 2). */
const DICE_MEAN: Record<string, number> = { basic: 1 / 3, enchanted: 2 / 3, exalted: 1, arcane: 2 };

/** Expected roll of a player's attack-dice pool — Σ mean face value over the pool. */
export function expectedAttack(p: PrivatePlayerState | undefined): number {
	let sum = 0;
	for (const d of p?.attackDice ?? []) sum += DICE_MEAN[d.tier] ?? 0;
	return sum;
}

/** Balanced default: modest build guidance toward dice + barrier (the economy core). */
export const BALANCED_SHAPING: ShapingWeights = {
	dice: 0.15,
	maxBarrier: 0.15,
	awakened: 0.1,
	status: 0.05
};

/**
 * Population playstyle presets — same VP objective, different build guidance → diverse VP routes.
 *
 * The `status` weight is the corruption lever: statusLevel/3 rises as a player descends the
 * corruption ladder toward Fallen, which is the gateway to the +3-VP Evil group-attack. A
 * POSITIVE status weight (pvp) nudges discovery toward corrupting; ZERO leaves it neutral; a
 * NEGATIVE weight (pure) actively steers discovery AWAY from corruption so the learner must find
 * a Good economy / monster-hunting line to earn VP. These weights change the historical objective
 * whenever terminal Φ is retained; use policy-invariant shaping when they should only accelerate
 * discovery without changing the true VP optimum.
 */
export const SHAPING_PRESETS: Record<string, ShapingWeights> = {
	balanced: BALANCED_SHAPING,
	economy: { dice: 0.05, maxBarrier: 0.13, awakened: 0.04, status: 0 }, // barrier-leaning economy: build the maxBarrier needed to survive/kill monsters (VP still dominates via monster-kill bonus)
	pvp: { dice: 0.05, maxBarrier: 0.05, awakened: 0.05, status: 0.2 },
	lean: { dice: 0.05, maxBarrier: 0.05, awakened: 0.05, status: 0.02 }, // mostly raw VP
	// --- diversity archetypes (all status<=0: no corruption nudge) ---
	// CALIBRATION: build weights are kept TINY (total Φ ≲ 0.08) so they are a faint nudge, NOT a
	// competing objective. A single monster kill is worth 2-10 VP = 0.067-0.333 normalized reward
	// (ΔVP/30); earlier presets summed to ~0.65 build potential, which OUT-REWARDED scoring and made
	// bots build-without-scoring (0 VP). Now VP dominates; build shaping only breaks ties toward the
	// survivable build (barrier/dice) that lets a bot actually win monster fights.
	pure: { dice: 0.06, maxBarrier: 0.12, awakened: 0.04, status: -0.05 }, // never-corrupt Good scaler — barrier to SURVIVE monster combat
	hunter: { dice: 0.12, maxBarrier: 0.1, awakened: 0.04, status: 0 }, // dice (damage) + barrier (survival) — kill monsters
	explorer: { dice: 0, maxBarrier: 0, awakened: 0, status: 0 }, // pure VP → discover via raw VP under high temperature
	// --- wave-6 STRONG-build archetypes (force the multi-round economy setup that weak shaping never reached) ---
	// Rationale: maxBarrier/awakened are MULTI-ROUND investments with no immediate VP; weak shaping
	// (~0.1) never overcame the noise, so bots stayed at base barrier 4 / scored 0. Crank them so the
	// return-to-go (γ→1) credits the setup steps. With effect-aware encoding the net can now SEE+pick them.
	banker: { dice: 0.05, maxBarrier: 0.35, awakened: 0.15, status: 0, classProgress: 0.4 }, // assemble Cultivators → maxBarrier → kill monsters
	ascend: { dice: 0.05, maxBarrier: 0.15, awakened: 0.35, status: 0, classProgress: 0.4 }, // assemble + awaken VP-class spirits (World Ender +1/round)
	// ascend2 (ladder4, ABLATION): tested whether a NEGATIVE status potential (−0.25) reduces the
	// corruption→Fallen spiral. It did NOT — Fallen held ~100% across all 60 gens. The historical
	// terminal-retention implementation also made this an explicit end-state preference, so the
	// negative result cannot be treated as a clean policy-invariant ablation. Kept frozen for
	// reproducibility; `ascend` is likewise frozen.
	ascend2: {
		dice: 0.05,
		maxBarrier: 0.15,
		awakened: 0.35,
		status: -0.25,
		faceDown: 0.1,
		classProgress: 0.4
	},
	// ascend3 (ladder5): the ENGINE-POWER fix. Michael's diagnosis is that the Fallen spiral is a
	// SYMPTOM — the real deficit is attack power / initiative: the bot fights with a far weaker dice
	// pool than a strong player, so its fights fail and its corruptions pay nothing. So NO status
	// penalty (corruption is fine when it earns value); instead ADD attackPower 0.3 crediting the
	// dice-pool expected roll, keep faceDown 0.1 (unawakened summons feed the engine loop), and lower
	// awakened 0.35→0.25 to keep total Φ ~O(1). These terms are policy-invariant only when paired
	// with `PotentialShapingMode='policy-invariant'`.
	ascend3: {
		dice: 0.05,
		maxBarrier: 0.15,
		awakened: 0.25,
		status: 0,
		faceDown: 0.1,
		classProgress: 0.4,
		attackPower: 0.3
	}
};

export function shapingFor(name: string | undefined): ShapingWeights {
	return SHAPING_PRESETS[name ?? 'balanced'] ?? BALANCED_SHAPING;
}

/** Raw VP of a player. */
export function vpOf(p: PrivatePlayerState | undefined): number {
	return p?.victoryPoints ?? 0;
}

/** Build-progress potential Φ_build(player) — auxiliary shaping only, excludes VP. */
export function buildPotential(p: PrivatePlayerState | undefined, w: ShapingWeights): number {
	if (!p) return 0;
	const dice = Math.min(1, (p.attackDice?.length ?? 0) / 10);
	const barrier = Math.min(1, (p.maxBarrier ?? 0) / 10);
	const awakened = Math.min(1, (p.spirits?.filter((s) => !s.isFaceDown).length ?? 0) / 7);
	const faceDown = Math.min(1, (p.spirits?.filter((s) => s.isFaceDown).length ?? 0) / 7);
	const status = Math.min(1, (p.statusLevel ?? 0) / 3);
	const attack = Math.min(1, expectedAttack(p) / 20); // dice-pool expected roll (fight-winning engine power)
	const cc = awakenedClassCounts(p);
	const cultProg = Math.min(1, (cc['Cultivator'] ?? 0) / 5); // progress toward the 5-Cultivator maxBarrier breakpoint
	const vpClass = Math.min(1, ((cc['World Ender'] ?? 0) + (cc['Golden Ruler'] ?? 0)) / 3); // +1 VP/round classes
	return (
		w.dice * dice +
		w.maxBarrier * barrier +
		w.awakened * awakened +
		(w.faceDown ?? 0) * faceDown +
		(w.attackPower ?? 0) * attack +
		w.status * status +
		(w.classProgress ?? 0) * (cultProg + vpClass)
	);
}

/**
 * Return-to-go that maximizes discounted VP (+ build shaping) for ONE seat's decisions, in
 * play order. `vp[i]`/`build[i]` are the VP and build potential at decision i's state;
 * `finalVp`/`finalBuild` are the seat's values at game end (so the VP gained AFTER the last
 * recorded decision is still credited). Per-step reward = ΔVP/VP_TO_WIN + (Φ_build delta);
 * G_t = r_t + γ·G_{t+1}, computed backwards. γ<1 favors VP/turn.
 */
export function vpReturnsToGo(
	vp: number[],
	build: number[],
	finalVp: number,
	finalBuild: number,
	gamma = 0.97,
	bonus: number[] = [],
	opts: {
		potentialMode?: PotentialShapingMode;
		/** True only when the trajectory reached a real terminal game state. */
		terminal?: boolean;
	} = {}
): number[] {
	const n = vp.length;
	const g = new Array<number>(n).fill(0);
	let running = 0;
	for (let i = n - 1; i >= 0; i--) {
		const nextVp = i < n - 1 ? vp[i + 1] : finalVp;
		const nextBuild = i < n - 1 ? build[i + 1] : finalBuild;
		const terminalTransition = opts.terminal === true && i === n - 1;
		// Core = normalized ΔVP + potential-based build shaping. `bonus` is an additive per-step
		// event reward (e.g. monster-kill bonus) — amplifies the sparse monster-VP signal and, via
		// the backward return-to-go, credits the whole setup sequence that led to the kill.
		const r =
			(nextVp - vp[i]) / VP_TO_WIN +
			potentialShapingDelta(build[i], nextBuild, gamma, terminalTransition, opts.potentialMode) +
			(bonus[i] ?? 0);
		running = r + gamma * running;
		g[i] = running;
	}
	return g;
}

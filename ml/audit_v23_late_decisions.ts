/** Targeted terminal-rollout audit of the frozen V23 solo line on Michael's held-out seed.
 * Diagnostic only: outputs labels and outcomes, never training rows. */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { profileFor } from '../src/lib/play/server/botPolicy';
import type { GameCommand, PlayCatalog, PublicGameState, SeatColor } from '../src/lib/play/types';
import { type LegalAction, policyPreviewState } from '../src/lib/play/ml/actions';
import { playRecordingGame } from '../src/lib/play/ml/driver';
import { encodeAction, encodeObs } from '../src/lib/play/ml/encode';
import { hybridIndex } from '../src/lib/play/ml/neuralBot';
import type { NeuralPolicy } from '../src/lib/play/ml/net';
import { loadPolicyForEval } from '../src/lib/play/ml/nodeIo';
import {
	canonicalCommandSignature,
	evaluateTerminalDecision,
	navigationDecisionSupport
} from '../src/lib/play/ml/terminalTeacher';

interface AuditRow {
	stateId: string;
	round: number;
	phase: PublicGameState['phase'];
	decisionKind: 'navigation' | 'corruption-discard' | 'awaken-or-commit' | 'relic-mix';
	vp: number;
	spirits: number;
	statusLevel: number;
	chosenIndex: number;
	chosenSignature: string;
	teacherIndex: number;
	teacherSignature: string;
	teacherChanged: boolean;
	decisive: boolean;
	rollouts: number;
	stats: unknown;
}

function sha256File(file: string): string {
	return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function f32(values: number[]): number[] {
	return Array.from(Float32Array.from(values));
}

function f32Policy(policy: NeuralPolicy): NeuralPolicy {
	if (policy.optionDim !== 0) throw new Error('audit requires a stripped option_dim=0 checkpoint');
	return new Proxy(policy, {
		get(target, prop) {
			if (prop === 'pick') {
				return (
					obs: number[],
					cands: number[][],
					opts?: { sample?: boolean; temperature?: number; rand?: () => number }
				): number => target.pick(f32(obs), cands.map(f32), opts);
			}
			if (prop === 'scoreCandidates') {
				return (obs: number[], cands: number[][]): number[] =>
					target.scoreCandidates(f32(obs), cands.map(f32));
			}
			const value = Reflect.get(target, prop, target) as unknown;
			return typeof value === 'function' ? value.bind(target) : value;
		}
	}) as NeuralPolicy;
}

function relicMixSupport(withNext: readonly LegalAction[], chosenIndex: number): number[] {
	const desired = new Set([
		'2,2,2,2,2',
		'2,2,2,2,3',
		'2,2,2,3,3',
		'2,2,3,3,3',
		'3,3,3,3,3',
		'0,0,0,0,0',
		'4,4,4,4,4'
	]);
	const support = withNext.flatMap((action, index) => {
		if (action.cmd.type !== 'resolveAwakenReward') return [];
		const key = [...(action.cmd.relicPicks ?? [])].sort((a, b) => a - b).join(',');
		return desired.has(key) ? [index] : [];
	});
	if (!support.includes(chosenIndex)) support.push(chosenIndex);
	return [...new Set(support)].sort((a, b) => a - b);
}

function auditSupport(
	state: PublicGameState,
	withNext: readonly LegalAction[],
	chosenIndex: number
): { kind: AuditRow['decisionKind']; support: number[] } | null {
	if (state.phase === 'navigation' && [8, 9, 12, 16, 20].includes(state.round)) {
		return { kind: 'navigation', support: navigationDecisionSupport(withNext.map((row) => row.cmd)) };
	}
	if (state.round === 8 && withNext[chosenIndex]?.cmd.type === 'discardSpirit') {
		return {
			kind: 'corruption-discard',
			support: withNext.flatMap((row, index) => (row.cmd.type === 'discardSpirit' ? [index] : []))
		};
	}
	if (
		state.round === 8 &&
		state.phase === 'benefits' &&
		withNext[chosenIndex]?.cmd.type === 'resolveAwakenReward'
	) {
		return { kind: 'relic-mix', support: relicMixSupport(withNext, chosenIndex) };
	}
	if (state.phase === 'awakening' && state.round >= 12 && withNext.length <= 12) {
		return { kind: 'awaken-or-commit', support: withNext.map((_, index) => index) };
	}
	return null;
}

function main(): void {
	const [weightsArg, catalogArg, snapshotArg, outArg] = process.argv.slice(2);
	if (!weightsArg || !catalogArg || !snapshotArg || !outArg) {
		throw new Error(
			'usage: npx tsx ml/audit_v23_late_decisions.ts <weights> <catalog> <snapshot> <out>'
		);
	}
	const weightsPath = resolve(weightsArg);
	const catalogPath = resolve(catalogArg);
	const snapshotPath = resolve(snapshotArg);
	const outPath = resolve(outArg);
	const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as PlayCatalog;
	const snapshotRaw = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { state: PublicGameState };
	const source = snapshotRaw.state;
	const seat = source.activeSeats[0] as SeatColor;
	const guardian = source.players[seat]?.selectedGuardian;
	if (!guardian) throw new Error('snapshot does not identify the solo guardian');
	const policy = f32Policy(loadPolicyForEval(weightsPath));
	const rows: AuditRow[] = [];
	let decisionOrdinal = 0;
	const result = playRecordingGame(catalog, {
		seed: source.rng.seed,
		profiles: [profileFor('medium')],
		maxRounds: 30,
		policy,
		neuralSeats: [seat],
		recordSeats: [],
		selection: 'hybrid',
		sample: false,
		guardianNames: [guardian],
		chooser: (_obs, _features, _commands, actingSeat, state, withNext) => {
			const chosenIndex = hybridIndex(policy, state, actingSeat, withNext, { sample: false }, catalog);
			const audit = auditSupport(state, withNext, chosenIndex);
			if (audit && audit.support.length >= 2) {
				const stateId = `v23-heldout-${source.rng.seed}-r${state.round}-${state.phase}-d${decisionOrdinal}`;
				const teacher = evaluateTerminalDecision(
					state,
					actingSeat,
					withNext.map((row) => row.cmd),
					audit.support,
					policy,
					catalog,
					{
						stateId,
						salt: 'v26-heldout-audit',
						rollouts: 8,
						temperature: 0.1,
						pairedUtilityMargin: 0.05
					}
				);
				rows.push({
					stateId,
					round: state.round,
					phase: state.phase,
					decisionKind: audit.kind,
					vp: state.players[actingSeat]?.victoryPoints ?? 0,
					spirits: state.players[actingSeat]?.spirits.length ?? 0,
					statusLevel: state.players[actingSeat]?.statusLevel ?? 0,
					chosenIndex,
					chosenSignature: canonicalCommandSignature(withNext[chosenIndex].cmd),
					teacherIndex: teacher.index,
					teacherSignature: canonicalCommandSignature(withNext[teacher.index].cmd),
					teacherChanged: teacher.index !== chosenIndex,
					decisive: teacher.label.decisive,
					rollouts: teacher.label.rollouts,
					stats: teacher.label.stats
				});
			}
			decisionOrdinal += 1;
			return chosenIndex;
		}
	});
	if (result.stalled || !result.finalState) throw new Error('audited bot run failed or stalled');
	const report = {
		schemaVersion: 'arc-v23-targeted-terminal-audit-v1',
		createdAt: new Date().toISOString(),
		diagnosticOnly: true,
		trainingUseProhibited: true,
		provenance: {
			weightsSha256: sha256File(weightsPath),
			catalogSha256: sha256File(catalogPath),
			snapshotSha256: sha256File(snapshotPath),
			seed: source.rng.seed,
			guardian,
			rolloutsPerCandidate: 8
		},
		finalVP: result.finalVP[seat],
		finalRound: result.rounds,
		stalled: result.stalled,
		audits: rows,
		summary: {
			decisions: rows.length,
			changed: rows.filter((row) => row.teacherChanged).length,
			decisive: rows.filter((row) => row.decisive).length,
			decisiveChanges: rows.filter((row) => row.teacherChanged && row.decisive).length
		}
	};
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify({ out: outPath, finalVP: result.finalVP[seat], ...report.summary }));
}

main();

/**
 * Observation/action contract sufficiency audit.
 *
 * Reads route-critical counterfactual JSONL samples and checks whether the
 * current encoder collapses contradictory labels into identical or near-identical
 * feature vectors. This does not prove the strategy is solved; it tells us
 * whether another training run is even allowed to blame the learner instead of
 * the contract.
 */
import { describe, expect, it } from 'vitest';
import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ALL_DESTINATIONS } from '../types';
import { ACT_DIM, COMMAND_VOCAB, OBS_DIM } from './encode';
import { mlPath } from './nodeIo';

const RUN = process.env.CONTRACTAUDIT === '1';

interface Row {
	obs: number[];
	cands: number[][];
	chosen: number;
	pi?: number[];
	ret?: number;
}

interface Conflict {
	key: string;
	labels: string[];
	rows: number[];
}

interface NearConflict {
	a: number;
	b: number;
	distance: number;
	labelA: string;
	labelB: string;
}

function dataFiles(): string[] {
	const raw = process.env.CONTRACTAUDIT_DATA ?? mlPath('data_contract_audit', 'survivalq.jsonl');
	return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function roundKey(values: number[], digits: number): string {
	return values.map((x) => Number.isFinite(x) ? x.toFixed(digits) : 'nan').join(',');
}

function candidateSetKey(row: Row, digits: number): string {
	return row.cands.map((cand) => roundKey(cand, digits)).sort().join('|');
}

function distance(a: number[], b: number[]): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		sum += d * d;
	}
	return Math.sqrt(sum);
}

function actionLabel(cand: number[] | undefined): string {
	if (!cand) return '<missing>';
	const commandIndex = cand.slice(0, COMMAND_VOCAB.length).findIndex((v) => v > 0.5);
	const command = COMMAND_VOCAB[commandIndex] ?? `<cmd:${commandIndex}>`;
	if (command === 'lockNavigation') {
		const offset = COMMAND_VOCAB.length;
		const destIndex = cand.slice(offset, offset + ALL_DESTINATIONS.length).findIndex((v) => v > 0.5);
		return `lockNavigation:${ALL_DESTINATIONS[destIndex] ?? '<unknown>'}`;
	}
	return command;
}

function chosenLabel(row: Row): string {
	return actionLabel(row.cands[row.chosen]);
}

function readRows(files: string[]): Row[] {
	const rows: Row[] = [];
	for (const file of files) {
		if (!existsSync(file)) throw new Error(`missing CONTRACTAUDIT_DATA file: ${file}`);
		const lines = readFileSync(file, 'utf8').split(/\n/).filter((line) => line.trim().length > 0);
		for (const line of lines) rows.push(JSON.parse(line) as Row);
	}
	return rows;
}

describe('ML contract sufficiency audit', () => {
	(RUN ? it : it.skip)('route-critical labels do not alias under the current 62/52 contract', () => {
		const files = dataFiles();
		const rows = readRows(files);
		const obsDigits = parseInt(process.env.CONTRACTAUDIT_OBS_DIGITS ?? '4', 10);
		const actionDigits = parseInt(process.env.CONTRACTAUDIT_ACTION_DIGITS ?? String(obsDigits), 10);
		const keyMode = process.env.CONTRACTAUDIT_KEY_MODE === 'obs' ? 'obs' : 'obs-cands';
		const nearThreshold = parseFloat(process.env.CONTRACTAUDIT_NEAR_THRESHOLD ?? '0.005');
		const maxExactConflicts = parseInt(process.env.CONTRACTAUDIT_MAX_EXACT_CONFLICTS ?? '0', 10);
		const maxNearConflicts = parseInt(process.env.CONTRACTAUDIT_MAX_NEAR_CONFLICTS ?? '0', 10);
		const minRows = parseInt(process.env.CONTRACTAUDIT_MIN_ROWS ?? '8', 10);
		const minLabels = parseInt(process.env.CONTRACTAUDIT_MIN_LABELS ?? '2', 10);
		const out = process.env.CONTRACTAUDIT_OUT ?? mlPath('contract_audit_summary.json');

		expect(rows.length).toBeGreaterThanOrEqual(minRows);
		const labelCounts: Record<string, number> = {};
		const byKey = new Map<string, { labels: Set<string>; rows: number[] }>();
		const byObs = new Map<string, { labels: Set<string>; rows: number[] }>();
		const candidateKeys: string[] = [];
		let badObsDim = 0;
		let badActDim = 0;
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			if (row.obs.length !== OBS_DIM) badObsDim++;
			for (const cand of row.cands) if (cand.length !== ACT_DIM) badActDim++;
			const label = chosenLabel(row);
			labelCounts[label] = (labelCounts[label] ?? 0) + 1;
			const obsKey = roundKey(row.obs, obsDigits);
			const candKey = candidateSetKey(row, actionDigits);
			candidateKeys[i] = candKey;
			const key = keyMode === 'obs' ? obsKey : `${obsKey}||${candKey}`;
			const bucket = byKey.get(key) ?? { labels: new Set<string>(), rows: [] };
			bucket.labels.add(label);
			bucket.rows.push(i);
			byKey.set(key, bucket);
			const obsBucket = byObs.get(obsKey) ?? { labels: new Set<string>(), rows: [] };
			obsBucket.labels.add(label);
			obsBucket.rows.push(i);
			byObs.set(obsKey, obsBucket);
		}

		const exactConflicts: Conflict[] = [];
		for (const [key, bucket] of byKey) {
			if (bucket.labels.size <= 1) continue;
			exactConflicts.push({ key, labels: [...bucket.labels].sort(), rows: bucket.rows });
		}
		const obsOnlyExactConflicts: Conflict[] = [];
		for (const [key, bucket] of byObs) {
			if (bucket.labels.size <= 1) continue;
			obsOnlyExactConflicts.push({ key, labels: [...bucket.labels].sort(), rows: bucket.rows });
		}

		let minDifferentLabelDistance = Infinity;
		let nearestDifferentLabel: NearConflict | null = null;
		const nearConflicts: NearConflict[] = [];
		const labels = rows.map(chosenLabel);
		for (let i = 0; i < rows.length; i++) {
			for (let j = i + 1; j < rows.length; j++) {
				if (labels[i] === labels[j]) continue;
				if (keyMode === 'obs-cands' && candidateKeys[i] !== candidateKeys[j]) continue;
				const d = distance(rows[i].obs, rows[j].obs);
				if (d < minDifferentLabelDistance) {
					minDifferentLabelDistance = d;
					nearestDifferentLabel = {
						a: i,
						b: j,
						distance: +d.toFixed(6),
						labelA: labels[i],
						labelB: labels[j]
					};
				}
				if (d <= nearThreshold) {
					nearConflicts.push({
						a: i,
						b: j,
						distance: +d.toFixed(6),
						labelA: labels[i],
						labelB: labels[j]
					});
				}
			}
		}

		const summary = {
			files,
			rows: rows.length,
			obsDim: OBS_DIM,
			actDim: ACT_DIM,
			keyMode,
			badObsDim,
			badActDim,
			uniqueKeys: byKey.size,
			uniqueObs: byObs.size,
			labelCounts,
			exactConflictCount: exactConflicts.length,
			exactConflicts: exactConflicts.slice(0, 10),
			obsOnlyExactConflictCount: obsOnlyExactConflicts.length,
			obsOnlyExactConflicts: obsOnlyExactConflicts.slice(0, 10),
			nearThreshold,
			nearConflictCount: nearConflicts.length,
			nearConflicts: nearConflicts.slice(0, 10),
			minDifferentLabelDistance: Number.isFinite(minDifferentLabelDistance)
				? +minDifferentLabelDistance.toFixed(6)
				: null,
			nearestDifferentLabel
		};
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
		/* eslint-disable-next-line no-console */
		console.log(`[contractaudit] ${JSON.stringify(summary)}`);

		expect(badObsDim).toBe(0);
		expect(badActDim).toBe(0);
		expect(Object.keys(labelCounts).length).toBeGreaterThanOrEqual(minLabels);
		expect(exactConflicts.length).toBeLessThanOrEqual(maxExactConflicts);
		expect(nearConflicts.length).toBeLessThanOrEqual(maxNearConflicts);
	});
});

/**
 * Node-only IO helpers for the ML pipeline. Imported ONLY by the `_*.test.ts` runners
 * (which execute under vitest/node), never by the SvelteKit app — so the `node:fs`
 * import never reaches the client bundle.
 *
 *   - loadOrSnapshotCatalog(): freeze the live Supabase catalog to ml/catalog.json once,
 *     then load it from disk on every subsequent run (offline, deterministic, portable).
 *   - JSONL sample writer + meta writer for the training data.
 *   - weights loader for neural self-play / evaluation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PlayCatalog } from '../types';
import { OBS_DIM, ACT_DIM } from './encode';
import { loadPolicyWeights, NeuralPolicy, type PolicyWeights, type LinearLayer } from './net';
import type { Sample } from './driver';
import { createRng, nextInt } from '../rng';

/** Repo-root-relative path (vitest runs with cwd = repo root). */
export function mlPath(...parts: string[]): string {
	return resolve(process.cwd(), 'ml', ...parts);
}

function ensureDir(file: string): void {
	mkdirSync(dirname(file), { recursive: true });
}

/**
 * Load the frozen catalog from ml/catalog.json, snapshotting it from Supabase on first
 * use (or when `force`). This is the Phase-1 "freeze the catalog" deliverable: training
 * never depends on the network after the first snapshot.
 */
export async function loadOrSnapshotCatalog(force = false): Promise<PlayCatalog> {
	const file = mlPath('catalog.json');
	if (!force && existsSync(file)) {
		return JSON.parse(readFileSync(file, 'utf8')) as PlayCatalog;
	}
	const { loadPlayCatalog } = await import('../server/catalog');
	const catalog = await loadPlayCatalog();
	ensureDir(file);
	writeFileSync(file, JSON.stringify(catalog));
	return catalog;
}

/** Append samples to a JSONL shard (one decision per line). */
export function appendSamples(file: string, samples: Sample[], iter = 0): void {
	if (samples.length === 0) return;
	ensureDir(file);
	const lines = samples
		.map((s) =>
			JSON.stringify({
				obs: round4(s.obs),
				cands: s.cands.map(round4),
				chosen: s.chosen,
				ret: r4(s.ret),
				...(s.pi ? { pi: round4(s.pi) } : {}),
				...(typeof s.farmValue === 'number' ? { farmValue: r4(s.farmValue) } : {}),
					...(s.rewardPi ? { rewardPi: round4(s.rewardPi) } : {}),
					...(typeof s.policyWeight === 'number' ? { policyWeight: r4(s.policyWeight) } : {}),
					...(typeof s.routeMode === 'number' ? { routeMode: r4(s.routeMode) } : {}),
					...(typeof s.teacherKind === 'string' ? { teacherKind: s.teacherKind } : {}),
					// PPO trajectory fields (ml/ppo.py); optional so old-format consumers see no change.
					...(typeof s.gameId === 'string' ? { gameId: s.gameId } : {}),
					...(typeof s.stepIdx === 'number' ? { stepIdx: s.stepIdx } : {}),
					...(typeof s.rStep === 'number' ? { rStep: r4(s.rStep) } : {}),
					...(typeof s.done === 'boolean' ? { done: s.done } : {}),
					...(typeof s.logpOld === 'number' ? { logpOld: r4(s.logpOld) } : {}),
					...(typeof s.vPred === 'number' ? { vPred: r4(s.vPred) } : {}),
					...(typeof s.placement === 'number' ? { placement: s.placement } : {}),
					iter
				})
			)
		.join('\n');
	appendFileSync(file, lines + '\n');
}

/** Truncate floats to 4 decimals to shrink JSONL ~3x with no learning impact. */
function r4(x: number): number {
	return Math.round(x * 1e4) / 1e4;
}
function round4(a: number[]): number[] {
	return a.map(r4);
}

export function writeMeta(samples: number, games: number, extra: Record<string, unknown> = {}): void {
	const file = process.env.ML_META_PATH ? resolve(process.cwd(), process.env.ML_META_PATH) : mlPath('data', 'meta.json');
	ensureDir(file);
	writeFileSync(file, JSON.stringify({ obs_dim: OBS_DIM, act_dim: ACT_DIM, samples, games, ...extra }, null, 2));
}

/** Load an exported policy weights file (ml/weights/policy.json), or null if absent. */
export function loadWeightsIfPresent(file = mlPath('weights', 'policy.json')): NeuralPolicy | null {
	if (!existsSync(file)) return null;
	return loadPolicyWeights(JSON.parse(readFileSync(file, 'utf8')), {
		expectedObsDim: OBS_DIM,
		expectedActDim: ACT_DIM
	});
}

/** Load an evaluation checkpoint strictly. Quality gates must not silently fall back
 *  to random weights, especially after an encoder contract bump. */
export function loadPolicyForEval(file = mlPath('weights', 'policy.json')): NeuralPolicy {
	if (!existsSync(file)) throw new Error(`missing policy weights for eval: ${file}`);
	return loadPolicyWeights(JSON.parse(readFileSync(file, 'utf8')), {
		expectedObsDim: OBS_DIM,
		expectedActDim: ACT_DIM
	});
}

/** A small-random-weight net at the CURRENT obs/act dims — the AlphaZero iteration-0 bootstrap
 *  (the planner leans on its heuristic-playout leaf until the value net is trained). */
export function randomPolicy(seed = 1, trunkHidden = [128, 128], valueHidden = [64]): NeuralPolicy {
	const rng = createRng((seed >>> 0) || 1);
	const g = (): number => (nextInt(rng, 20001) / 10000 - 1) * 0.1;
	const lin = (out: number, inn: number): LinearLayer => ({
		W: Array.from({ length: out }, () => Array.from({ length: inn }, g)),
		b: Array.from({ length: out }, () => 0)
	});
	const dims = (hidden: number[], inn: number): LinearLayer[] => {
		const ds = [inn, ...hidden, 1];
		return ds.slice(0, -1).map((d, i) => lin(ds[i + 1], d));
	};
	const w: PolicyWeights = {
		format: 'arc-cand-scorer-v1',
		obs_dim: OBS_DIM,
		act_dim: ACT_DIM,
		trunk: dims(trunkHidden, OBS_DIM + ACT_DIM),
		value: dims(valueHidden, OBS_DIM)
	};
	return new NeuralPolicy(w);
}

/** Load weights if present AND dims match the current encoder; otherwise a random bootstrap net. */
export function loadOrRandomPolicy(file = mlPath('weights', 'policy.json'), seed = 1): NeuralPolicy {
	if (existsSync(file)) {
		const w = JSON.parse(readFileSync(file, 'utf8')) as PolicyWeights;
		if (w.obs_dim === OBS_DIM && w.act_dim === ACT_DIM) return loadPolicyWeights(w);
	}
	return randomPolicy(seed);
}

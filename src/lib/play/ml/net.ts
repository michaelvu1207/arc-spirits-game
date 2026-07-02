/**
 * Pure-TypeScript forward pass for the candidate-scoring policy/value net.
 *
 * Training and all gradients live in Python (PyTorch/MPS); it exports weights as JSON
 * (see ml/train.py → ml/weights/policy.json). This file ONLY does inference, so the
 * data-generation self-play and the arena evaluation can run at native Node speed with
 * zero native dependencies. The math here must mirror the Python forward EXACTLY:
 *   trunk(concat(obs, cand)) → scalar logit per candidate;  softmax = policy.
 *   value(obs) → scalar baseline.
 * Each Linear is stored as W (out×in, row-major) + b (out); ReLU between layers, none last.
 */

export interface LinearLayer {
	W: number[][]; // out x in
	b: number[]; // out
}

export interface PolicyWeights {
	format: string;
	obs_dim: number;
	act_dim: number;
	trunk: LinearLayer[];
	value: LinearLayer[];
	farm_value?: LinearLayer[];
	reward_pick?: LinearLayer[];
	route_mode?: LinearLayer[];
}

export interface PolicyLoadOptions {
	expectedObsDim?: number;
	expectedActDim?: number;
}

function linear(x: number[], layer: LinearLayer): number[] {
	const { W, b } = layer;
	const out = new Array<number>(W.length);
	for (let o = 0; o < W.length; o++) {
		const row = W[o];
		let acc = b[o];
		for (let i = 0; i < row.length; i++) acc += row[i] * x[i];
		out[o] = acc;
	}
	return out;
}

function relu(x: number[]): number[] {
	for (let i = 0; i < x.length; i++) if (x[i] < 0) x[i] = 0;
	return x;
}

/** Run an MLP (ReLU between layers, none after the last). */
function mlp(x: number[], layers: LinearLayer[]): number[] {
	let h = x;
	for (let l = 0; l < layers.length; l++) {
		h = linear(h, layers[l]);
		if (l < layers.length - 1) h = relu(h);
	}
	return h;
}

export class NeuralPolicy {
	readonly w: PolicyWeights;
	constructor(weights: PolicyWeights) {
		this.w = weights;
	}

	/** Logit for one candidate = trunk(concat(obs, cand))[0]. */
	private logit(obs: number[], cand: number[]): number {
		const x = obs.concat(cand);
		return mlp(x, this.w.trunk)[0];
	}

	/** Raw logits for every candidate (same order as `cands`). */
	scoreCandidates(obs: number[], cands: number[][]): number[] {
		return cands.map((c) => this.logit(obs, c));
	}

	/** State value baseline in ~[0,1]. */
	value(obs: number[]): number {
		return mlp(obs, this.w.value)[0];
	}

	/** Optional auxiliary clean-farm opportunity prediction. Missing on older checkpoints. */
	farmValue(obs: number[]): number {
		return this.w.farm_value ? mlp(obs, this.w.farm_value)[0] : 0;
	}

	/** Optional Fallen route-mode probability. Missing on older checkpoints. */
	routeMode(obs: number[]): number | null {
		if (!this.w.route_mode) return null;
		const raw = mlp(obs, this.w.route_mode)[0];
		return 1 / (1 + Math.exp(-raw));
	}

	/** Optional auxiliary reward-pick logits over candidates. Missing on older checkpoints. */
	rewardPickScores(obs: number[], cands: number[][]): number[] | null {
		if (!this.w.reward_pick) return null;
		return cands.map((cand) => mlp(obs.concat(cand), this.w.reward_pick!)[0]);
	}

	rewardPickProbs(obs: number[], cands: number[][], temperature = 1): number[] | null {
		const logits = this.rewardPickScores(obs, cands);
		if (!logits) return null;
		const t = Math.max(1e-6, temperature);
		let max = -Infinity;
		for (const l of logits) if (l > max) max = l;
		const exps = logits.map((l) => Math.exp((l - max) / t));
		const sum = exps.reduce((a, b) => a + b, 0) || 1;
		return exps.map((e) => e / sum);
	}

	/** Softmax probabilities over candidates (numerically stable). */
	probs(obs: number[], cands: number[][], temperature = 1): number[] {
		const logits = this.scoreCandidates(obs, cands);
		const t = Math.max(1e-6, temperature);
		let max = -Infinity;
		for (const l of logits) if (l > max) max = l;
		const exps = logits.map((l) => Math.exp((l - max) / t));
		const sum = exps.reduce((a, b) => a + b, 0) || 1;
		return exps.map((e) => e / sum);
	}

	/**
	 * Choose a candidate index. Greedy (argmax) by default; set `sample` to draw from the
	 * softmax (exploration during data generation). `rand` is a [0,1) source so callers can
	 * thread the seeded engine RNG for reproducibility.
	 */
	pick(
		obs: number[],
		cands: number[][],
		opts?: { sample?: boolean; temperature?: number; rand?: () => number }
	): number {
		if (cands.length <= 1) return 0;
		if (!opts?.sample) {
			const logits = this.scoreCandidates(obs, cands);
			let best = 0;
			for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
			return best;
		}
		const p = this.probs(obs, cands, opts.temperature ?? 1);
		const r = (opts.rand ?? Math.random)();
		let acc = 0;
		for (let i = 0; i < p.length; i++) {
			acc += p[i];
			if (r <= acc) return i;
		}
		return p.length - 1;
	}
}

function validateLinear(layer: LinearLayer | undefined, name: string): void {
	if (!layer || !Array.isArray(layer.W) || !Array.isArray(layer.b) || layer.W.length !== layer.b.length) {
		throw new Error(`Invalid policy weights: ${name} layer has inconsistent W/b`);
	}
	const width = layer.W[0]?.length;
	if (typeof width !== 'number') {
		throw new Error(`Invalid policy weights: ${name} layer has no input width`);
	}
	for (const row of layer.W) {
		if (!Array.isArray(row) || row.length !== width) {
			throw new Error(`Invalid policy weights: ${name} layer has ragged rows`);
		}
	}
}

/** Parse + validate an exported weights blob. */
export function loadPolicyWeights(json: unknown, opts: PolicyLoadOptions = {}): NeuralPolicy {
	const w = json as PolicyWeights;
	if (!w || !Array.isArray(w.trunk) || !Array.isArray(w.value)) {
		throw new Error('Invalid policy weights: missing trunk/value layers');
	}
	if (w.trunk[w.trunk.length - 1]?.W.length !== 1) {
		throw new Error('Invalid policy weights: trunk must end in a single logit');
	}
	for (let i = 0; i < w.trunk.length; i++) validateLinear(w.trunk[i], `trunk[${i}]`);
	for (let i = 0; i < w.value.length; i++) validateLinear(w.value[i], `value[${i}]`);
	if (w.farm_value) for (let i = 0; i < w.farm_value.length; i++) validateLinear(w.farm_value[i], `farm_value[${i}]`);
	if (w.reward_pick) for (let i = 0; i < w.reward_pick.length; i++) validateLinear(w.reward_pick[i], `reward_pick[${i}]`);
	if (w.route_mode) for (let i = 0; i < w.route_mode.length; i++) validateLinear(w.route_mode[i], `route_mode[${i}]`);
	if (opts.expectedObsDim !== undefined && w.obs_dim !== opts.expectedObsDim) {
		throw new Error(`Invalid policy weights: obs_dim ${w.obs_dim} does not match encoder ${opts.expectedObsDim}`);
	}
	if (opts.expectedActDim !== undefined && w.act_dim !== opts.expectedActDim) {
		throw new Error(`Invalid policy weights: act_dim ${w.act_dim} does not match encoder ${opts.expectedActDim}`);
	}
	const trunkInput = w.trunk[0]?.W[0]?.length;
	const valueInput = w.value[0]?.W[0]?.length;
	if (trunkInput !== w.obs_dim + w.act_dim) {
		throw new Error(`Invalid policy weights: trunk input ${trunkInput} does not match obs_dim + act_dim`);
	}
	if (valueInput !== w.obs_dim) {
		throw new Error(`Invalid policy weights: value input ${valueInput} does not match obs_dim`);
	}
	const farmInput = w.farm_value?.[0]?.W[0]?.length;
	if (farmInput !== undefined && farmInput !== w.obs_dim) {
		throw new Error(`Invalid policy weights: farm_value input ${farmInput} does not match obs_dim`);
	}
	const rewardPickInput = w.reward_pick?.[0]?.W[0]?.length;
	if (rewardPickInput !== undefined && rewardPickInput !== w.obs_dim + w.act_dim) {
		throw new Error(`Invalid policy weights: reward_pick input ${rewardPickInput} does not match obs_dim + act_dim`);
	}
	const routeModeInput = w.route_mode?.[0]?.W[0]?.length;
	if (routeModeInput !== undefined && routeModeInput !== w.obs_dim) {
		throw new Error(`Invalid policy weights: route_mode input ${routeModeInput} does not match obs_dim`);
	}
	return new NeuralPolicy(w);
}

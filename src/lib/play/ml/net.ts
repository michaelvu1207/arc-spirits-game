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
	/** Persistent round-option width. Absent/0 is the exact legacy checkpoint contract. */
	option_dim?: number;
	trunk: LinearLayer[];
	value: LinearLayer[];
	/** State-only categorical round-option policy. Required iff option_dim > 0. */
	option?: LinearLayer[];
	/** State-only round-start baseline. Required iff option_dim > 0. */
	option_value?: LinearLayer[];
	farm_value?: LinearLayer[];
	placement?: LinearLayer[];
	reward_pick?: LinearLayer[];
	route_mode?: LinearLayer[];
	reach30?: LinearLayer[];
	reach30_horizon?: number;
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
	readonly optionDim: number;
	constructor(weights: PolicyWeights) {
		this.w = weights;
		this.optionDim = weights.option_dim ?? 0;
	}

	private optionInput(option?: number[]): number[] {
		if (this.optionDim === 0) {
			if (option !== undefined && option.length > 0) {
				throw new Error('Legacy policy does not accept a round option');
			}
			return [];
		}
		if (!option || option.length !== this.optionDim) {
			throw new Error(`Option-aware policy requires an option vector of length ${this.optionDim}`);
		}
		if (option.some((value) => !Number.isFinite(value))) {
			throw new Error('Option-aware policy received a non-finite option vector');
		}
		return option;
	}

	/** Logit for one candidate = trunk(concat(obs, cand, option))[0]. */
	private logit(obs: number[], cand: number[], option?: number[]): number {
		const x = obs.concat(cand, this.optionInput(option));
		return mlp(x, this.w.trunk)[0];
	}

	/** Raw logits for every candidate (same order as `cands`). */
	scoreCandidates(obs: number[], cands: number[][], option?: number[]): number[] {
		return cands.map((c) => this.logit(obs, c, option));
	}

	/** State value baseline in ~[0,1]. */
	value(obs: number[], option?: number[]): number {
		return mlp(obs.concat(this.optionInput(option)), this.w.value)[0];
	}

	/** Supported option probabilities. Null is the explicit legacy/non-option result. */
	optionProbs(obs: number[], behaviorMask?: number[]): number[] | null {
		if (this.optionDim === 0) return null;
		const mask = behaviorMask ?? Array<number>(this.optionDim).fill(1);
		if (
			mask.length !== this.optionDim ||
			mask.some((value) => value !== 0 && value !== 1) ||
			!mask.some((value) => value === 1)
		) {
			throw new Error(`Option behavior mask must be ${this.optionDim} binary values with support`);
		}
		const logits = mlp(obs, this.w.option!);
		let max = -Infinity;
		for (let i = 0; i < logits.length; i++) if (mask[i] && logits[i] > max) max = logits[i];
		const exps = logits.map((logit, i) => (mask[i] ? Math.exp(logit - max) : 0));
		const sum = exps.reduce((a, b) => a + b, 0);
		if (!Number.isFinite(sum) || sum <= 0) throw new Error('Option policy produced invalid logits');
		return exps.map((value) => value / sum);
	}

	/** Round-start option baseline. Null is the explicit legacy/non-option result. */
	optionValue(obs: number[]): number | null {
		return this.optionDim === 0 ? null : mlp(obs, this.w.option_value!)[0];
	}

	pickOption(
		obs: number[],
		opts?: { sample?: boolean; behaviorMask?: number[]; rand?: () => number }
	): number | null {
		const probs = this.optionProbs(obs, opts?.behaviorMask);
		if (!probs) return null;
		if (!opts?.sample) {
			let best = 0;
			for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
			return best;
		}
		const r = (opts.rand ?? Math.random)();
		let acc = 0;
		for (let i = 0; i < probs.length; i++) {
			acc += probs[i];
			if (r <= acc) return i;
		}
		return probs.length - 1;
	}

	/** Optional auxiliary clean-farm opportunity prediction. Missing on older checkpoints. */
	farmValue(obs: number[], option?: number[]): number {
		return this.w.farm_value ? mlp(obs.concat(this.optionInput(option)), this.w.farm_value)[0] : 0;
	}

	/** Optional 4-way final-placement probabilities (KataGo outcome aux). */
	placementProbs(obs: number[], option?: number[]): number[] | null {
		if (!this.w.placement) return null;
		const logits = mlp(obs.concat(this.optionInput(option)), this.w.placement);
		let max = -Infinity;
		for (const x of logits) if (x > max) max = x;
		const exps = logits.map((x) => Math.exp(x - max));
		const sum = exps.reduce((a, b) => a + b, 0) || 1;
		return exps.map((e) => e / sum);
	}

	/** Optional solo-objective critic. Missing until the head has actually been trained. */
	reach30Probability(obs: number[], option?: number[]): number | null {
		if (!this.w.reach30) return null;
		const raw = mlp(obs.concat(this.optionInput(option)), this.w.reach30)[0];
		return 1 / (1 + Math.exp(-raw));
	}

	/** State-only round-30 critic over a batch of independent observations. The
	 * in-process implementation is deliberately simple; RemotePolicy overrides
	 * this contract with one true batched server request. */
	reach30Probabilities(observations: number[][], option?: number[]): Array<number | null> {
		return observations.map((obs) => this.reach30Probability(obs, option));
	}

	/** Objective horizon attached to the optional reach-30 critic. */
	reach30Horizon(): number | null {
		return this.w.reach30 ? (this.w.reach30_horizon ?? null) : null;
	}

	/** Optional Fallen route-mode probability. Missing on older checkpoints. */
	routeMode(obs: number[], option?: number[]): number | null {
		if (!this.w.route_mode) return null;
		const raw = mlp(obs.concat(this.optionInput(option)), this.w.route_mode)[0];
		return 1 / (1 + Math.exp(-raw));
	}

	/** Optional auxiliary reward-pick logits over candidates. Missing on older checkpoints. */
	rewardPickScores(obs: number[], cands: number[][], option?: number[]): number[] | null {
		if (!this.w.reward_pick) return null;
		const optionInput = this.optionInput(option);
		return cands.map((cand) => mlp(obs.concat(cand, optionInput), this.w.reward_pick!)[0]);
	}

	rewardPickProbs(
		obs: number[],
		cands: number[][],
		temperature = 1,
		option?: number[]
	): number[] | null {
		const logits = this.rewardPickScores(obs, cands, option);
		if (!logits) return null;
		const t = Math.max(1e-6, temperature);
		let max = -Infinity;
		for (const l of logits) if (l > max) max = l;
		const exps = logits.map((l) => Math.exp((l - max) / t));
		const sum = exps.reduce((a, b) => a + b, 0) || 1;
		return exps.map((e) => e / sum);
	}

	/** Softmax probabilities over candidates (numerically stable). */
	probs(obs: number[], cands: number[][], temperature = 1, option?: number[]): number[] {
		const logits = this.scoreCandidates(obs, cands, option);
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
		opts?: { sample?: boolean; temperature?: number; rand?: () => number; option?: number[] }
	): number {
		// Forced low-level actions still belong to the persistent option contract.
		this.optionInput(opts?.option);
		if (cands.length <= 1) return 0;
		if (!opts?.sample) {
			const logits = this.scoreCandidates(obs, cands, opts?.option);
			let best = 0;
			for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
			return best;
		}
		const p = this.probs(obs, cands, opts.temperature ?? 1, opts.option);
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
	if (
		!layer ||
		!Array.isArray(layer.W) ||
		!Array.isArray(layer.b) ||
		layer.W.length !== layer.b.length
	) {
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
		if (row.some((value) => !Number.isFinite(value))) {
			throw new Error(`Invalid policy weights: ${name} layer has non-finite weights`);
		}
	}
	if (layer.b.some((value) => !Number.isFinite(value))) {
		throw new Error(`Invalid policy weights: ${name} layer has non-finite biases`);
	}
}

function validateAdjacentLayers(layers: LinearLayer[], name: string): void {
	if (layers.length === 0) throw new Error(`Invalid policy weights: ${name} has no layers`);
	for (let i = 1; i < layers.length; i++) {
		const priorOutput = layers[i - 1].W.length;
		const input = layers[i].W[0]?.length;
		if (input !== priorOutput) {
			throw new Error(
				`Invalid policy weights: ${name}[${i}] input ${input} does not match prior output ${priorOutput}`
			);
		}
	}
}

const OBS_CONDITIONED_HEADS = [
	'value',
	'farm_value',
	'placement',
	'route_mode',
	'reach30'
] as const;
const OPTION_HEADS = ['option', 'option_value'] as const;
const OBS_ACTION_HEADS = ['trunk', 'reward_pick'] as const;

function cloneLayers(layers: LinearLayer[] | undefined): LinearLayer[] | undefined {
	return layers?.map((layer) => ({
		W: layer.W.map((row) => row.slice()),
		b: layer.b.slice()
	}));
}

/**
 * Zero-expand an older checkpoint whose observation encoder was a strict prefix of the current
 * one. Since every head receives observation columns first, inserting zero columns at the old
 * observation boundary preserves every output exactly until the new features are trained.
 */
export function expandPolicyObsDim(weights: PolicyWeights, newObsDim: number): PolicyWeights {
	const oldObsDim = weights.obs_dim;
	if (
		!Number.isInteger(oldObsDim) ||
		oldObsDim <= 0 ||
		!Number.isInteger(weights.act_dim) ||
		weights.act_dim <= 0
	) {
		throw new Error('Invalid policy weights: obs_dim and act_dim must be positive integers');
	}
	if (!Number.isInteger(newObsDim) || newObsDim < oldObsDim) {
		throw new Error(`Invalid policy weights: cannot expand obs_dim ${oldObsDim} to ${newObsDim}`);
	}
	if (newObsDim === oldObsDim) return weights;

	const expanded: PolicyWeights = {
		...weights,
		obs_dim: newObsDim,
		trunk: cloneLayers(weights.trunk) ?? [],
		value: cloneLayers(weights.value) ?? [],
		farm_value: cloneLayers(weights.farm_value),
		placement: cloneLayers(weights.placement),
		reward_pick: cloneLayers(weights.reward_pick),
		route_mode: cloneLayers(weights.route_mode),
		reach30: cloneLayers(weights.reach30),
		option: cloneLayers(weights.option),
		option_value: cloneLayers(weights.option_value)
	};
	const zeroCount = newObsDim - oldObsDim;
	const optionDim = weights.option_dim ?? 0;
	for (const head of OBS_CONDITIONED_HEADS) {
		const layers = expanded[head];
		if (!layers) continue;
		validateLinear(layers[0], `${head}[0]`);
		const width = layers[0].W[0].length;
		if (width !== oldObsDim + optionDim) {
			throw new Error(
				`Invalid policy weights: ${head}[0] input ${width} does not match obs_dim + option_dim`
			);
		}
		layers[0].W = layers[0].W.map((row) => [
			...row.slice(0, oldObsDim),
			...Array<number>(zeroCount).fill(0),
			...row.slice(oldObsDim)
		]);
	}
	for (const head of OPTION_HEADS) {
		const layers = expanded[head];
		if (!layers) continue;
		validateLinear(layers[0], `${head}[0]`);
		if (layers[0].W[0].length !== oldObsDim) {
			throw new Error(`Invalid policy weights: ${head}[0] input does not match obs_dim`);
		}
		layers[0].W = layers[0].W.map((row) => [...row, ...Array<number>(zeroCount).fill(0)]);
	}
	for (const head of OBS_ACTION_HEADS) {
		const layers = expanded[head];
		if (!layers) continue;
		validateLinear(layers[0], `${head}[0]`);
		const expectedWidth = oldObsDim + weights.act_dim + optionDim;
		const width = layers[0].W[0].length;
		if (width !== expectedWidth) {
			throw new Error(
				`Invalid policy weights: ${head}[0] input ${width} does not match obs_dim + act_dim ${expectedWidth}`
			);
		}
		layers[0].W = layers[0].W.map((row) => [
			...row.slice(0, oldObsDim),
			...Array<number>(zeroCount).fill(0),
			...row.slice(oldObsDim)
		]);
	}
	return expanded;
}

/**
 * Zero-expand an older checkpoint whose action encoder is a strict prefix of the
 * current one. Action columns trail observation columns in action-aware heads, so
 * appending zero columns preserves every old-checkpoint output exactly.
 */
export function expandPolicyActDim(weights: PolicyWeights, newActDim: number): PolicyWeights {
	const oldActDim = weights.act_dim;
	if (
		!Number.isInteger(weights.obs_dim) ||
		weights.obs_dim <= 0 ||
		!Number.isInteger(oldActDim) ||
		oldActDim <= 0
	) {
		throw new Error('Invalid policy weights: obs_dim and act_dim must be positive integers');
	}
	if (!Number.isInteger(newActDim) || newActDim < oldActDim) {
		throw new Error(`Invalid policy weights: cannot expand act_dim ${oldActDim} to ${newActDim}`);
	}
	if (newActDim === oldActDim) return weights;

	const expanded: PolicyWeights = {
		...weights,
		act_dim: newActDim,
		trunk: cloneLayers(weights.trunk) ?? [],
		value: cloneLayers(weights.value) ?? [],
		farm_value: cloneLayers(weights.farm_value),
		placement: cloneLayers(weights.placement),
		reward_pick: cloneLayers(weights.reward_pick),
		route_mode: cloneLayers(weights.route_mode),
		reach30: cloneLayers(weights.reach30),
		option: cloneLayers(weights.option),
		option_value: cloneLayers(weights.option_value)
	};
	const zeroCount = newActDim - oldActDim;
	const optionDim = weights.option_dim ?? 0;
	for (const head of OBS_ACTION_HEADS) {
		const layers = expanded[head];
		if (!layers) continue;
		validateLinear(layers[0], `${head}[0]`);
		const expectedWidth = weights.obs_dim + oldActDim + optionDim;
		const width = layers[0].W[0].length;
		if (width !== expectedWidth) {
			throw new Error(
				`Invalid policy weights: ${head}[0] input ${width} does not match obs_dim + act_dim ${expectedWidth}`
			);
		}
		layers[0].W = layers[0].W.map((row) => [
			...row.slice(0, weights.obs_dim + oldActDim),
			...Array<number>(zeroCount).fill(0),
			...row.slice(weights.obs_dim + oldActDim, weights.obs_dim + oldActDim + optionDim)
		]);
	}
	return expanded;
}

/** Parse + validate an exported weights blob. */
export function loadPolicyWeights(json: unknown, opts: PolicyLoadOptions = {}): NeuralPolicy {
	let w = json as PolicyWeights;
	if (!w || !Array.isArray(w.trunk) || !Array.isArray(w.value)) {
		throw new Error('Invalid policy weights: missing trunk/value layers');
	}
	const declaredOptionDim = w.option_dim ?? 0;
	if (
		!Number.isInteger(declaredOptionDim) ||
		(declaredOptionDim !== 0 && declaredOptionDim !== 4)
	) {
		throw new Error('Invalid policy weights: option_dim must be absent/0 (legacy) or exactly 4');
	}
	if (declaredOptionDim === 0 && (w.option || w.option_value)) {
		throw new Error('Invalid policy weights: legacy option_dim=0 cannot contain option heads');
	}
	if (declaredOptionDim === 4 && (!Array.isArray(w.option) || !Array.isArray(w.option_value))) {
		throw new Error('Invalid policy weights: option_dim=4 requires option and option_value heads');
	}
	if (opts.expectedObsDim !== undefined && w.obs_dim < opts.expectedObsDim) {
		w = expandPolicyObsDim(w, opts.expectedObsDim);
	}
	if (opts.expectedActDim !== undefined && w.act_dim < opts.expectedActDim) {
		w = expandPolicyActDim(w, opts.expectedActDim);
	}
	if (w.trunk[w.trunk.length - 1]?.W.length !== 1) {
		throw new Error('Invalid policy weights: trunk must end in a single logit');
	}
	for (let i = 0; i < w.trunk.length; i++) validateLinear(w.trunk[i], `trunk[${i}]`);
	for (let i = 0; i < w.value.length; i++) validateLinear(w.value[i], `value[${i}]`);
	if (w.farm_value)
		for (let i = 0; i < w.farm_value.length; i++)
			validateLinear(w.farm_value[i], `farm_value[${i}]`);
	if (w.placement)
		for (let i = 0; i < w.placement.length; i++) validateLinear(w.placement[i], `placement[${i}]`);
	if (w.reward_pick)
		for (let i = 0; i < w.reward_pick.length; i++)
			validateLinear(w.reward_pick[i], `reward_pick[${i}]`);
	if (w.route_mode)
		for (let i = 0; i < w.route_mode.length; i++)
			validateLinear(w.route_mode[i], `route_mode[${i}]`);
	if (w.reach30)
		for (let i = 0; i < w.reach30.length; i++) validateLinear(w.reach30[i], `reach30[${i}]`);
	if (w.option)
		for (let i = 0; i < w.option.length; i++) validateLinear(w.option[i], `option[${i}]`);
	if (w.option_value)
		for (let i = 0; i < w.option_value.length; i++)
			validateLinear(w.option_value[i], `option_value[${i}]`);
	for (const [name, layers] of Object.entries({
		trunk: w.trunk,
		value: w.value,
		farm_value: w.farm_value,
		placement: w.placement,
		reward_pick: w.reward_pick,
		route_mode: w.route_mode,
		reach30: w.reach30,
		option: w.option,
		option_value: w.option_value
	})) {
		if (layers) validateAdjacentLayers(layers, name);
	}
	if (w.reach30 && (!Number.isInteger(w.reach30_horizon) || (w.reach30_horizon as number) < 1)) {
		throw new Error('Invalid policy weights: reach30 head requires a positive reach30_horizon');
	}
	if (opts.expectedObsDim !== undefined && w.obs_dim !== opts.expectedObsDim) {
		throw new Error(
			`Invalid policy weights: obs_dim ${w.obs_dim} does not match encoder ${opts.expectedObsDim}`
		);
	}
	if (opts.expectedActDim !== undefined && w.act_dim !== opts.expectedActDim) {
		throw new Error(
			`Invalid policy weights: act_dim ${w.act_dim} does not match encoder ${opts.expectedActDim}`
		);
	}
	const trunkInput = w.trunk[0]?.W[0]?.length;
	const valueInput = w.value[0]?.W[0]?.length;
	if (trunkInput !== w.obs_dim + w.act_dim + declaredOptionDim) {
		throw new Error(
			`Invalid policy weights: trunk input ${trunkInput} does not match obs_dim + act_dim + option_dim`
		);
	}
	if (valueInput !== w.obs_dim + declaredOptionDim) {
		throw new Error(
			`Invalid policy weights: value input ${valueInput} does not match obs_dim + option_dim`
		);
	}
	const farmInput = w.farm_value?.[0]?.W[0]?.length;
	if (farmInput !== undefined && farmInput !== w.obs_dim + declaredOptionDim) {
		throw new Error(
			`Invalid policy weights: farm_value input ${farmInput} does not match obs_dim + option_dim`
		);
	}
	const placementInput = w.placement?.[0]?.W[0]?.length;
	if (placementInput !== undefined && placementInput !== w.obs_dim + declaredOptionDim) {
		throw new Error(
			`Invalid policy weights: placement input ${placementInput} does not match obs_dim + option_dim`
		);
	}
	const rewardPickInput = w.reward_pick?.[0]?.W[0]?.length;
	if (
		rewardPickInput !== undefined &&
		rewardPickInput !== w.obs_dim + w.act_dim + declaredOptionDim
	) {
		throw new Error(
			`Invalid policy weights: reward_pick input ${rewardPickInput} does not match obs_dim + act_dim + option_dim`
		);
	}
	const routeModeInput = w.route_mode?.[0]?.W[0]?.length;
	if (routeModeInput !== undefined && routeModeInput !== w.obs_dim + declaredOptionDim) {
		throw new Error(
			`Invalid policy weights: route_mode input ${routeModeInput} does not match obs_dim + option_dim`
		);
	}
	const reach30Input = w.reach30?.[0]?.W[0]?.length;
	if (reach30Input !== undefined && reach30Input !== w.obs_dim + declaredOptionDim) {
		throw new Error(
			`Invalid policy weights: reach30 input ${reach30Input} does not match obs_dim + option_dim`
		);
	}
	const optionInput = w.option?.[0]?.W[0]?.length;
	if (optionInput !== undefined && optionInput !== w.obs_dim) {
		throw new Error(`Invalid policy weights: option input ${optionInput} does not match obs_dim`);
	}
	const optionValueInput = w.option_value?.[0]?.W[0]?.length;
	if (optionValueInput !== undefined && optionValueInput !== w.obs_dim) {
		throw new Error(
			`Invalid policy weights: option_value input ${optionValueInput} does not match obs_dim`
		);
	}
	if (w.option && w.option[w.option.length - 1]?.W.length !== declaredOptionDim) {
		throw new Error('Invalid policy weights: option head output does not match option_dim');
	}
	if (w.option_value && w.option_value[w.option_value.length - 1]?.W.length !== 1) {
		throw new Error('Invalid policy weights: option_value must end in one scalar');
	}
	if (
		declaredOptionDim === 4 &&
		(w.option!.length !== 2 ||
			w.option![0].W.length < 1 ||
			w.option![1].W[0]?.length !== w.option![0].W.length ||
			w.option_value!.length !== 2 ||
			w.option_value![0].W.length !== w.option![0].W.length ||
			w.option_value![1].W[0]?.length !== w.option_value![0].W.length)
	) {
		throw new Error(
			'Invalid policy weights: option heads must use matching obs -> H -> output widths'
		);
	}
	return new NeuralPolicy(w);
}

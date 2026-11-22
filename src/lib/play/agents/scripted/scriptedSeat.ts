/**
 * A seat played by a fixed script (no model): `script:fe` is the Fighter + Elementalist player
 * of `fePolicy.ts`, `script:beast` the Beast player of `beastPolicy.ts`. It plugs into
 * `runAgentGame` like the mock seats. It reads the seat's own projection from
 * `DecideContext.view` (the same data the LLM seats get as text).
 */

import type { PlayCatalog, SeatColor, SpectatorProjection } from '../../types';
import type {
	ControllerAnswer,
	DecideContext,
	DecisionRequest,
	OfferedAction,
	SeatController
} from '../contract';
import { safeFallback } from '../llmSeat';
import { chooseBeastAction, DEFAULT_BEAST_PARAMS } from './beastPolicy';
import { chooseFeAction, DEFAULT_FE_PARAMS } from './fePolicy';

export const SCRIPTED_POLICIES = ['fe', 'beast'] as const;
export type ScriptedPolicy = (typeof SCRIPTED_POLICIES)[number];

export function isScriptedPolicy(name: string): name is ScriptedPolicy {
	return (SCRIPTED_POLICIES as readonly string[]).includes(name);
}

/** Parameter overrides of a scripted policy (each policy reads the names it knows). */
export type ScriptedParams = Record<string, number>;

type Chooser = (
	view: SpectatorProjection,
	seat: SeatColor,
	actions: OfferedAction[]
) => { id: string; reason: string };

function chooserFor(policy: ScriptedPolicy, catalog: PlayCatalog, params: ScriptedParams): Chooser {
	if (policy === 'beast') {
		const merged = { ...DEFAULT_BEAST_PARAMS, ...params };
		return (view, seat, actions) => chooseBeastAction(view, seat, actions, catalog, merged);
	}
	const merged = { ...DEFAULT_FE_PARAMS, ...params };
	return (view, seat, actions) => chooseFeAction(view, seat, actions, catalog, merged);
}

export class ScriptedSeatController implements SeatController {
	readonly label: string;
	readonly modelId: string;
	readonly strategy = null;
	readonly policy: ScriptedPolicy;
	readonly #choose: Chooser;

	constructor(opts: {
		catalog: PlayCatalog;
		policy?: ScriptedPolicy;
		params?: ScriptedParams;
		/** Seat label in records (default `script:<policy>`). */
		label?: string;
	}) {
		this.policy = opts.policy ?? 'fe';
		this.label = opts.label ?? `script:${this.policy}`;
		this.modelId = this.label;
		this.#choose = chooserFor(this.policy, opts.catalog, opts.params ?? {});
	}

	async decide(request: DecisionRequest, ctx: DecideContext): Promise<ControllerAnswer> {
		if (!ctx.view) {
			// No structured view (a caller that does not pass one): the harness's safe default.
			const pick = safeFallback(request.actions);
			return {
				response: { actionId: pick.action.id, reason: `script: no view, ${pick.why}` },
				attempts: [],
				repaired: false,
				fallback: true,
				fallbackReason: 'no view in DecideContext'
			};
		}
		const choice = this.#choose(ctx.view, request.seat, request.actions);
		return {
			response: { actionId: choice.id, reason: `script:${this.policy}: ${choice.reason}` },
			attempts: [],
			repaired: false,
			fallback: false
		};
	}
}

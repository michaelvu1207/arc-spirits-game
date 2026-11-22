/**
 * A seat played by a fixed script (no model): `script:fe` is the Fighter + Elementalist player
 * of `fePolicy.ts`. It plugs into `runAgentGame` like the mock seats. It reads the seat's own
 * projection from `DecideContext.view` (the same data the LLM seats get as text).
 */

import type { PlayCatalog } from '../../types';
import type { ControllerAnswer, DecideContext, DecisionRequest, SeatController } from '../contract';
import { safeFallback } from '../llmSeat';
import { chooseFeAction, DEFAULT_FE_PARAMS, type FeParams } from './fePolicy';

export const SCRIPTED_POLICIES = ['fe'] as const;
export type ScriptedPolicy = (typeof SCRIPTED_POLICIES)[number];

export function isScriptedPolicy(name: string): name is ScriptedPolicy {
	return (SCRIPTED_POLICIES as readonly string[]).includes(name);
}

export class ScriptedSeatController implements SeatController {
	readonly label: string;
	readonly modelId: string;
	readonly strategy = null;
	readonly #catalog: PlayCatalog;
	readonly #params: FeParams;

	constructor(opts: {
		catalog: PlayCatalog;
		policy?: ScriptedPolicy;
		params?: Partial<FeParams>;
		/** Seat label in records (default `script:<policy>`). */
		label?: string;
	}) {
		const policy = opts.policy ?? 'fe';
		this.label = opts.label ?? `script:${policy}`;
		this.modelId = this.label;
		this.#catalog = opts.catalog;
		this.#params = { ...DEFAULT_FE_PARAMS, ...(opts.params ?? {}) };
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
		const choice = chooseFeAction(
			ctx.view,
			request.seat,
			request.actions,
			this.#catalog,
			this.#params
		);
		return {
			response: { actionId: choice.id, reason: `script:fe: ${choice.reason}` },
			attempts: [],
			repaired: false,
			fallback: false
		};
	}
}

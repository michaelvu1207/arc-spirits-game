/** Decision prompt rendering and answer parsing (provider-independent). */

import type { DecisionRequest, OfferedAction } from './contract';
import type { ChatMessage } from './providers/types';

export const ANSWER_LINE =
	'Reply with ONE JSON object only: {"action": "<id>", "reason": "<1-3 short sentences>"}';

export function actionLines(actions: OfferedAction[]): string[] {
	return actions.map((a) => `  ${a.id} (${a.group}) ${a.label}`);
}

/** The user message for one decision. The mock provider parses the same text. */
export function renderDecisionMessage(request: DecisionRequest): string {
	const events = request.events.length
		? request.events.map((e) => `  ${e}`).join('\n')
		: '  (nothing new)';
	return [
		`Round ${request.round}, ${request.phase} phase. You are ${request.seat}. This is your decision #${request.phaseDecisionIndex + 1} in this phase.`,
		...(request.pace ? [request.pace] : []),
		'',
		request.viewText,
		'',
		'RECENT EVENTS (since your last decision):',
		events,
		...(request.facts?.length
			? [
					'',
					'ENGINE FACTS (checked by the game engine on your current state; facts, not advice):',
					...request.facts
				]
			: []),
		'',
		`DECISION: ${request.situation}`,
		'LEGAL ACTIONS:',
		...actionLines(request.actions),
		'',
		ANSWER_LINE
	].join('\n');
}

/** The rules brief (same bytes for every seat), then the seat's strategy and notebook messages, if any. */
export function systemMessages(
	rulesBrief: string,
	strategy?: string | null,
	notebook?: string | null
): ChatMessage[] {
	return [
		{ role: 'system', content: rulesBrief },
		...[strategy, notebook]
			.filter((text): text is string => !!text)
			.map((content) => ({ role: 'system' as const, content }))
	];
}

export function buildMessages(
	rulesBrief: string,
	request: DecisionRequest,
	strategy?: string | null
): ChatMessage[] {
	return [
		...systemMessages(rulesBrief, strategy),
		{ role: 'user', content: renderDecisionMessage(request) }
	];
}

export function repairMessage(error: string, request: DecisionRequest): string {
	const ids = request.actions.map((a) => a.id);
	const range = ids.length > 6 ? `${ids[0]} … ${ids[ids.length - 1]}` : ids.join(', ');
	return `Your answer could not be used: ${error}. Answer again with ONE JSON object only, for example {"action": "${ids[0]}", "reason": "…"}. The action must be one of: ${range}.`;
}

export interface ParsedAnswer {
	id: string | null;
	reason: string;
	error: string | null;
	/** The optional plan note of a fresh-question seat (memory.ts). */
	note?: string;
}

/** Longest plan note kept (characters). */
export const NOTE_LIMIT = 600;

export function firstJsonObject(text: string): Record<string, unknown> | null {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
	const candidates = [fenced, text].filter((t): t is string => !!t);
	for (const candidate of candidates) {
		for (
			let start = candidate.indexOf('{');
			start >= 0;
			start = candidate.indexOf('{', start + 1)
		) {
			let depth = 0;
			let inString = false;
			for (let i = start; i < candidate.length; i++) {
				const ch = candidate[i];
				if (inString) {
					if (ch === '\\') i++;
					else if (ch === '"') inString = false;
					continue;
				}
				if (ch === '"') inString = true;
				else if (ch === '{') depth++;
				else if (ch === '}') {
					depth--;
					if (depth === 0) {
						try {
							const parsed = JSON.parse(candidate.slice(start, i + 1));
							if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
								return parsed as Record<string, unknown>;
						} catch {
							// try the next '{'
						}
						break;
					}
				}
			}
		}
	}
	return null;
}

/**
 * Parse a model answer against the offered actions. Accepts the short id ("a3"), the canonical
 * arc-bot-v1 id, or a bare id when the model forgot the JSON wrapper. Anything else is invalid.
 */
export function parseAnswer(text: string, actions: OfferedAction[]): ParsedAnswer {
	const byShort = new Map(actions.map((a) => [a.id.toLowerCase(), a.id]));
	const byCanonical = new Map<string, string>(actions.map((a) => [a.actionId, a.id]));
	const resolve = (raw: unknown): string | null => {
		if (typeof raw !== 'string' && typeof raw !== 'number') return null;
		const value = String(raw).trim();
		return (
			byShort.get(value.toLowerCase()) ?? byShort.get(`a${value}`) ?? byCanonical.get(value) ?? null
		);
	};
	const json = firstJsonObject(text);
	if (json) {
		const raw = json.action ?? json.actionId ?? json.action_id ?? json.id ?? json.choice;
		const reason = typeof json.reason === 'string' ? json.reason.slice(0, 600) : '';
		const note = typeof json.note === 'string' ? json.note.trim().slice(0, NOTE_LIMIT) : '';
		const id = resolve(raw);
		if (id) return { id, reason, error: null, ...(note ? { note } : {}) };
		return {
			id: null,
			reason,
			error:
				raw === undefined
					? 'the JSON has no "action" field'
					: `"${String(raw).slice(0, 40)}" is not one of the offered action ids`
		};
	}
	const trimmed = text.trim();
	const bare = resolve(trimmed);
	if (bare) return { id: bare, reason: '', error: null };
	const mentioned = [...new Set(trimmed.match(/\ba\d+\b/gi) ?? [])]
		.map((m) => resolve(m))
		.filter(Boolean);
	if (mentioned.length === 1)
		return { id: mentioned[0]!, reason: trimmed.slice(0, 300), error: null };
	return {
		id: null,
		reason: '',
		error: trimmed
			? 'the answer is not a JSON object with an "action" field'
			: 'the answer was empty'
	};
}

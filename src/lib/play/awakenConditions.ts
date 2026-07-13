/**
 * Normalizes a spirit's raw `awaken_condition` (from hex_spirits) into the
 * engine-facing {@link NormalizedAwaken} shape used by the play catalog.
 *
 * This is a pure, dependency-light module so it can be unit-tested in isolation
 * and reused by later rules-engine phases (awakening gate + rune payment).
 */
import type { AwakenCondition } from '$lib/types';
import type { AwakenMatRequirement, MatItemKind, NormalizedAwaken } from './types';

/** The two wildcard rune UUIDs that accept any matching item when paying a cost. */
export const WILDCARD_MAT_IDS = {
	/** "Any Relic" — accepts any relic-kind item only. */
	anyRelic: '19d72567-4ac8-4214-a21f-596bc88de8f7',
	/** "Any Rune" — accepts any origin rune. */
	anyRune: '7ca279f0-1ca8-484a-a86e-0a87aaa7b312'
} as const;

const WILDCARD_MAT_ID_SET: ReadonlySet<string> = new Set(Object.values(WILDCARD_MAT_IDS));

export function isWildcardRuneId(runeId: string): boolean {
	return WILDCARD_MAT_ID_SET.has(runeId);
}

/** Wildcard kind is defined by the sentinel id, not by the sentinel row's FKs.
 * Production's "Any Relic" asset currently carries an origin_id, which would
 * otherwise misclassify it as a rune and suppress the relic payment picker. */
function wildcardKind(runeId: string): MatItemKind | undefined {
	if (runeId === WILDCARD_MAT_IDS.anyRune) return 'rune';
	if (runeId === WILDCARD_MAT_IDS.anyRelic) return 'relic';
	return undefined;
}

/** Minimal rune-lookup shape: just what awaken normalization needs (name + kind). */
export interface AwakenRuneInfo {
	name: string;
	kind: MatItemKind;
}

/**
 * Group a `rune_cost`'s repeated UUIDs into one requirement per distinct rune,
 * counting repeats. Resolves each rune's display name + kind from `runesById`
 * (falling back to the raw id / a 'relic' kind when unknown), and flags the two
 * wildcard ids. Order of first appearance is preserved (no lossy collapsing).
 */
export function normalizeRuneCost(
	runeIds: string[],
	runesById: ReadonlyMap<string, AwakenRuneInfo>
): AwakenMatRequirement[] {
	const byRune = new Map<string, AwakenMatRequirement>();
	for (const runeId of runeIds) {
		const existing = byRune.get(runeId);
		if (existing) {
			existing.count += 1;
			continue;
		}
		const info = runesById.get(runeId);
		byRune.set(runeId, {
			runeId,
			name: info?.name ?? runeId,
			kind: wildcardKind(runeId) ?? info?.kind ?? 'relic',
			count: 1,
			wildcard: isWildcardRuneId(runeId)
		});
	}
	return [...byRune.values()];
}

/**
 * Normalize a raw `awaken_condition` into {@link NormalizedAwaken}.
 * `rune_cost` → grouped, resolved rune requirements; `text` → carried verbatim;
 * `null`/`undefined`/unknown → `undefined`.
 */
export function normalizeAwaken(
	condition: AwakenCondition | null | undefined,
	runesById: ReadonlyMap<string, AwakenRuneInfo>
): NormalizedAwaken | undefined {
	if (!condition) return undefined;
	if (condition.type === 'rune_cost') {
		return { kind: 'rune_cost', mats: normalizeRuneCost(condition.rune_ids ?? [], runesById) };
	}
	if (condition.type === 'text') {
		return { kind: 'text', text: condition.text };
	}
	return undefined;
}

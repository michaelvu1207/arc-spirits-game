import type { AwakenCondition, MatSlotSnapshot } from '../types';
import type { AwakenMatRequirement, NormalizedAwaken, PublicGameState } from './types';

export const ANY_BASE_RUNE = '7ca279f0-1ca8-484a-a86e-0a87aaa7b312';
export const BASE_RUNES: Record<string, { name: string; originId: string }> = {
	'480cd5f7-adea-481d-8ea9-aad776599d7b': {
		name: 'Fire Rune',
		originId: '178449e9-cc6b-45ab-8522-5183fe1d9307'
	},
	'34b2a963-f8c6-4fc0-8272-ddc50b0036a8': {
		name: 'Forest Rune',
		originId: 'ad555f03-9b89-4a71-a47c-464fd67d2c05'
	},
	'356f3ad2-4cac-4b69-a3cc-7559f8891d8e': {
		name: 'Mountain Rune',
		originId: 'fa7db249-d99d-4c1d-a37d-9027c9f5a31e'
	},
	'5eba8681-16b8-4563-b017-22c80a84b35b': {
		name: 'Water Rune',
		originId: '294cee31-a7ac-4292-9b61-d4293c05c146'
	}
};
export const RELIC_TO_RUNE: Record<string, string> = {
	'8a0d54ca-aeab-405c-9e5c-1c1425d1aa86': '480cd5f7-adea-481d-8ea9-aad776599d7b',
	'690a7e3b-5737-4494-bb8a-b58bee13f473': '34b2a963-f8c6-4fc0-8272-ddc50b0036a8',
	'ee1486a0-8b61-499c-809b-b4de9920aa8f': '356f3ad2-4cac-4b69-a3cc-7559f8891d8e',
	'a6111d01-2c55-4b1f-854a-32887d92b8e1': '5eba8681-16b8-4563-b017-22c80a84b35b',
	'19d72567-4ac8-4214-a21f-596bc88de8f7': ANY_BASE_RUNE
};
export const canonicalAwakenRuneId = (id: string): string => RELIC_TO_RUNE[id] ?? id;

export function migrateAwakenCondition(
	condition: AwakenCondition | null | undefined
): AwakenCondition | null | undefined {
	if (condition?.type === 'rune_cost')
		return { ...condition, rune_ids: condition.rune_ids.map(canonicalAwakenRuneId) };
	if (condition?.type === 'text')
		return {
			...condition,
			text: condition.text.replace(
				/discard\s+2\s+unique\s+relics\.?/gi,
				'Discard 2 Runes of different types.'
			)
		};
	return condition;
}

export function migrateNormalizedAwaken(
	awaken: NormalizedAwaken | undefined
): NormalizedAwaken | undefined {
	if (awaken?.kind === 'text')
		return {
			...awaken,
			text: awaken.text.replace(
				/discard\s+2\s+unique\s+relics\.?/gi,
				'Discard 2 Runes of different types.'
			)
		};
	if (awaken?.kind !== 'rune_cost') return awaken;
	const grouped = new Map<string, AwakenMatRequirement>();
	for (const mat of awaken.mats) {
		const runeId = canonicalAwakenRuneId(mat.runeId);
		const info = BASE_RUNES[runeId];
		const migrated: AwakenMatRequirement =
			info || runeId === ANY_BASE_RUNE
				? {
						...mat,
						runeId,
						name: info?.name ?? 'Any Rune',
						kind: 'rune',
						wildcard: runeId === ANY_BASE_RUNE
					}
				: { ...mat };
		const previous = grouped.get(runeId);
		if (previous) previous.count += migrated.count;
		else grouped.set(runeId, migrated);
	}
	return { ...awaken, mats: [...grouped.values()] };
}

/** Four elemental currencies only. Legacy name-only saves remain readable. */
export function baseRuneIdForSlot(
	slot: Pick<MatSlotSnapshot, 'id' | 'name' | 'originId' | 'classId' | 'type'>
): string | null {
	if (slot.classId || slot.type === 'augment') return null;
	if (slot.id && BASE_RUNES[slot.id]) return slot.id;
	if (slot.type === 'relic') return null;
	const byOrigin = Object.entries(BASE_RUNES).find(([, rune]) => rune.originId === slot.originId);
	if (byOrigin) return byOrigin[0];
	if (slot.id) return null;
	const name = (slot.name ?? '')
		.toLowerCase()
		.replace(/\s+(region|rune)s?/g, '')
		.trim();
	const aliases: Record<string, string> = {
		fire: 'Fire Rune',
		'lantern lights': 'Fire Rune',
		forest: 'Forest Rune',
		'floral patch': 'Forest Rune',
		mountain: 'Mountain Rune',
		'cyber city': 'Mountain Rune',
		water: 'Water Rune',
		'tidal tribe': 'Water Rune',
		'moon tide': 'Water Rune'
	};
	return Object.entries(BASE_RUNES).find(([, rune]) => rune.name === aliases[name])?.[0] ?? null;
}

/** Convert named legacy relic inventory one-for-one; Fairy Rune and Crown stay untouched. */
export function upgradeRelicRuneSlots(state: PublicGameState): void {
	for (const player of Object.values(state.players ?? {})) {
		if (!player) continue;
		for (const slot of player.mats ?? []) {
			const names: Record<string, string> = {
				Firecracker: '480cd5f7-adea-481d-8ea9-aad776599d7b',
				Flower: '34b2a963-f8c6-4fc0-8272-ddc50b0036a8',
				Magnet: '356f3ad2-4cac-4b69-a3cc-7559f8891d8e',
				Teapot: '5eba8681-16b8-4563-b017-22c80a84b35b'
			};
			const runeId = slot.id ? RELIC_TO_RUNE[slot.id] : names[slot.name ?? ''];
			const info = runeId ? BASE_RUNES[runeId] : undefined;
			if (!runeId || !info) continue;
			Object.assign(slot, {
				id: runeId,
				name: info.name,
				type: 'rune',
				originId: info.originId,
				special: false
			});
			delete slot.classId;
		}
	}
}

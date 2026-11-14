/**
 * Origin rewards and relic tools (November 2026 design data).
 *
 * Origin rewards — `~/ArcSpiritsArt/game/origins.json` `calling_card`:
 *   3 spirits of an origin → on Cultivate, 1 rune of that origin;
 *   5 spirits of an origin → on Cultivate, the relic of that origin (one time per player).
 * All spirits of the origin count, awakened or not (origin is always active).
 *
 * Relic tools — `~/ArcSpiritsArt/game/relics.json` `ability`:
 *   "You may <effect>, then discard this." (the "gain 2 VP or" side was removed 2026-11-13)
 * A held relic tool is offered as a decision card once per round, in the Benefits step
 * (next to the other Awakening Phase cards): keep it, use its effect, or (only when the catalog's
 * relic VP is above 0) take that VP. Using
 * either side discards it. Data only here (no `apply.ts` import, so `apply.ts` can use it).
 */

import { nextId } from '../rng';
import type { PlaySpirit, PrivatePlayerState, PublicGameState } from '../types';

export const FIRECRACKER_ID = '8a0d54ca-aeab-405c-9e5c-1c1425d1aa86';
export const FLOWER_ID = '690a7e3b-5737-4494-bb8a-b58bee13f473';
export const DIAMOND_ID = 'ee1486a0-8b61-499c-809b-b4de9920aa8f';
export const CLEANSING_TEAPOT_ID = 'a6111d01-2c55-4b1f-854a-32887d92b8e1';

export type RelicToolEffect = 'strikeFirst' | 'fullBarrier' | 'augment' | 'awaken';

export interface RelicTool {
	name: string;
	effect: RelicToolEffect;
	/** The effect clause of the relic text; see {@link relicToolText} for the whole text. */
	ability: string;
	/** The effect half of the text, for the option label. */
	effectLabel: string;
}

/**
 * VP for the "gain N VP or …" side of a relic tool comes from the CATALOG (`relicToolVp`, parsed
 * from relics.json ability text by the loaders). A catalog without the field is a catalog saved
 * before 2026-11-13, when every relic tool read "You may gain 2 VP or …": those keep 2, so old
 * game records replay exactly. Michael 2026-11-13: relics are not worth VP → current data = 0.
 */
export const LEGACY_RELIC_TOOL_VP = 2;

export function relicToolVp(catalog?: { relicToolVp?: number } | null): number {
	const vp = catalog?.relicToolVp;
	return typeof vp === 'number' && Number.isFinite(vp) ? vp : LEGACY_RELIC_TOOL_VP;
}

/** The relic text for a VP value: "You may [gain N VP or ]<ability>, then discard this." */
export function relicToolText(tool: RelicTool, vp: number): string {
	return `You may ${vp > 0 ? `gain ${vp} VP or ` : ''}${tool.ability}, then discard this.`;
}

/** relics.json ability texts → the VP value ("gain N VP or" → N; no VP clause → 0; no text → null). */
export function relicToolVpFromAbilities(rows: { id?: unknown; ability?: unknown }[]): number | null {
	let found: number | null = null;
	for (const row of rows) {
		if (!RELIC_TOOLS[String(row.id)] || typeof row.ability !== 'string' || !row.ability.trim()) continue;
		const match = /gain\s+(\d+)\s*VP\b/i.exec(row.ability);
		const vp = match ? Number(match[1]) : 0;
		found = found === null ? vp : Math.max(found, vp);
	}
	return found;
}

export const RELIC_TOOLS: Record<string, RelicTool> = {
	[FIRECRACKER_ID]: {
		name: 'Firecracker',
		effect: 'strikeFirst',
		ability: 'strike first in one combat',
		effectLabel: 'Strike first in your next combat'
	},
	[FLOWER_ID]: {
		name: 'Flower',
		effect: 'fullBarrier',
		ability: 'restore your Barrier to full',
		effectLabel: 'Restore your Barrier to full'
	},
	[DIAMOND_ID]: {
		name: 'Diamond',
		effect: 'augment',
		ability: 'gain 1 Spirit Augment of your choice',
		effectLabel: 'Gain 1 Spirit Augment of your choice'
	},
	[CLEANSING_TEAPOT_ID]: {
		name: 'Cleansing Teapot',
		effect: 'awaken',
		ability: 'awaken any one spirit',
		effectLabel: 'Awaken'
	}
};

/** The calling-card rewards of the four land origins (engine origin names). */
export const ORIGIN_REWARDS: Record<string, { runeAt: number; relicAt: number; relicId: string }> = {
	'Fire Region': { runeAt: 3, relicAt: 5, relicId: FIRECRACKER_ID },
	'Forest Region': { runeAt: 3, relicAt: 5, relicId: FLOWER_ID },
	'Mountain Region': { runeAt: 3, relicAt: 5, relicId: DIAMOND_ID },
	'Water Region': { runeAt: 3, relicAt: 5, relicId: CLEANSING_TEAPOT_ID }
};

/** Number of SPIRITS (not traits) per origin, awakened or not. */
export function spiritsByOrigin(spirits: Pick<PlaySpirit, 'origins'>[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const spirit of spirits) {
		for (const [origin, n] of Object.entries(spirit.origins ?? {})) {
			if ((typeof n === 'number' ? n : 1) > 0) counts[origin] = (counts[origin] ?? 0) + 1;
		}
	}
	return counts;
}

/** Put a relic tool in the player's rune slots (held like any relic). */
export function grantRelicTool(player: PrivatePlayerState, relicId: string, log: string[]): void {
	const tool = RELIC_TOOLS[relicId];
	if (!tool) return;
	player.mats.push({
		slotIndex: player.mats.length + 1,
		hasRune: true,
		id: relicId,
		name: tool.name,
		type: 'relic',
		special: true,
		relicTool: true
	});
	player.relics = (player.relics ?? 0) + 1;
	log.push(`Gained the ${tool.name} relic.`);
}

/** A held relic slot that is a relic tool (a named relic with a tool text). */
export function isHeldRelicTool(slot: PrivatePlayerState['mats'][number]): boolean {
	return slot.hasRune && slot.type === 'relic' && !!slot.id && !!RELIC_TOOLS[slot.id];
}

/**
 * A relic card that is still open when the player ends the Awakening step resolves as "keep"
 * (team-lead, 2026-11-12): the relic stays, and `offerHeldRelicTools` offers it again next
 * round. So no relic card stays open across Cleanup. Returns the number of cards closed.
 */
export function keepUnansweredRelicTools(player: PrivatePlayerState, log: string[]): number {
	const open = (player.pendingDecisions ?? []).filter((d) => d.kind === 'relicTool');
	if (open.length === 0) return 0;
	player.pendingDecisions = player.pendingDecisions.filter((d) => d.kind !== 'relicTool');
	for (const card of open) {
		const name = card.sourceLabel?.replace(/^Relic: /, '') ?? 'relic';
		log.push(`${name}: no answer — kept for later.`);
	}
	return open.length;
}

/**
 * Offer every held relic tool: keep, VP (only when relicToolVp(catalog) > 0), or the effect. Called once per round (Benefits).
 * Earlier relic cards are replaced, because rune slots are re-numbered between rounds.
 * Option ids carry the relic's slot and id (`keep:3:<id>`, `vp:3:<id>`, `effect:3:<id>`,
 * `awaken:3:<id>:5` for the spirit in slot 5); the resolver checks both.
 */
export function offerHeldRelicTools(
	state: PublicGameState,
	player: PrivatePlayerState,
	log: string[],
	catalog?: { relicToolVp?: number } | null
): void {
	const vp = relicToolVp(catalog);
	player.pendingDecisions = (player.pendingDecisions ?? []).filter((d) => d.kind !== 'relicTool');
	for (const slot of player.mats ?? []) {
		if (!isHeldRelicTool(slot)) continue;
		const tool = RELIC_TOOLS[slot.id!];
		const ref = `${slot.slotIndex}:${slot.id}`;
		const options: { id: string; label: string }[] = [
			{ id: `keep:${ref}`, label: `Keep ${tool.name} for later` }
		];
		if (vp > 0) options.push({ id: `vp:${ref}`, label: `Gain ${vp} VP, then discard ${tool.name}` });
		if (tool.effect === 'awaken') {
			for (const spirit of player.spirits.filter((s) => s.isFaceDown)) {
				options.push({
					id: `awaken:${ref}:${spirit.slotIndex}`,
					label: `Awaken ${spirit.name}, then discard ${tool.name}`
				});
			}
		} else {
			options.push({ id: `effect:${ref}`, label: `${tool.effectLabel}, then discard ${tool.name}` });
		}
		player.pendingDecisions.push({
			id: nextId(state.rng, 'dec'),
			source: 'class',
			kind: 'relicTool',
			prompt: `${tool.name}: ${relicToolText(tool, vp)}`,
			options,
			// A relic card, not a class ability: name the relic in the card header.
			sourceLabel: `Relic: ${tool.name}`
		});
		log.push(`Decision: use the ${tool.name} relic?`);
	}
}

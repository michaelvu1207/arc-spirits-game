/**
 * The rules brief every agent receives (first system message, identical for a whole run so
 * providers can cache it).
 *
 * Two parts:
 *  1. CORE RULES — a short summary written from the engine and the docs. Numbers the engine
 *     exports (VP target, round cap, dice faces, carry limit, spirit slots, bag cost ranges, PvP VP,
 *     origin thresholds) are read from those constants. The few that are not exported (start Barrier
 *     4/4, four starting spirits, one Any Rune, a 3-card power draft, Rest +2, summon sizes
 *     4/2 and 3/1) are checked against a real game by the "rules brief" tests in `agents.test.ts`,
 *     so an engine change fails the test instead of silently making the brief wrong.
 *  2. CARD TEXT — generated from the catalog and the engine's own card tables: locations and
 *     their actions, monster decks, Navigation Powers, relic tools, origins, every class's
 *     printed breakpoints, and every spirit. When the catalog or the card tables change, the
 *     brief changes with them; its sha256 is recorded in each transcript header.
 *
 * Strategy advice is deliberately NOT included: agents get the rules a player at the table
 * knows, not the designer's intentions.
 */

import { createHash } from 'node:crypto';
import {
	ARCANE_ABYSS_COST_MAX,
	ARCANE_ABYSS_COST_MIN,
	SPIRIT_WORLD_COST_MAX,
	SPIRIT_WORLD_COST_MIN
} from '../bags';
import { DICE_TIER_FACES, PVP_ENGAGE_VP, PVP_GOOD_BOUNTY, PVP_VP_PER_CORRUPTED, pvpVpForAttack } from '../combat';
import { navigationPowerPool } from '../navigationPowers';
import { ORIGIN_REWARDS, RELIC_TOOLS, relicToolText, relicToolVp } from '../effects/relicTools';
import { monsterDifficulty } from '../runtime';
import { buildMonsterRewards } from '../monsterRewards';
import {
	MAX_ATTACK_DICE,
	MAX_ROUNDS,
	RUNE_CARRY_LIMIT,
	MAX_SPIRITS,
	STATUS_LADDER,
	VP_TO_WIN,
	type PlayCatalog
} from '../types';
import { destinationSummaries } from './labels';
import { ruleAdjustedClassSchema, ruleValue } from '../rules';

const MAX_BARRIER_CAP = 10;

/** Classes whose printed text has an "On Rest" effect (from the catalog). */
export function restClasses(catalog: PlayCatalog): string[] {
	return catalog.classes
		.filter((k) => /\bon rest\b/i.test(schemaText(k.effectSchema)))
		.map((k) => k.name);
}

function coreRules(catalog: PlayCatalog): string {
	const faces = (Object.entries(DICE_TIER_FACES) as [string, number[]][])
		.map(([tier, f]) => `${tier} ${f.join(',')}`)
		.join('; ');
	return [
		'# ARC SPIRITS — RULES BRIEF',
		"You are one player at a 2-4 player table of Arc Spirits, a digital board game. You make every decision a human player makes, through text. You see only what your seat can see: other players' secret choices, hands and draws are hidden from you.",
		'',
		'## Goal and end of game',
		`- The first player with ${VP_TO_WIN}+ Victory Points (VP) when a round ends wins (the highest if several).`,
		`- Otherwise the game ends after round ${MAX_ROUNDS}, or when every player is Fallen${(catalog.monsters ?? []).some((m) => m.permanent) ? '' : ', or when every monster card is defeated'}; then the most VP wins (ties: seat order).`,
		'',
		'## A round (6 phases; you act in each, then you finish/yield it)',
		'1. Navigation: every player SECRETLY locks one destination — one of the four Spirit World regions or the Arcane Abyss — and may commit one held Navigation Power with it. All destinations are revealed together.',
		`2. Encounter: an Evil (Fallen) player at the same location as Good players may attack them all (group PvP)${ruleValue(catalog, 'pvpInAbyss') ? ', at the Arcane Abyss too' : ''}. Everyone else passes.`,
		'3. Location: use the actions of your location (list below). A "gain" action works once per round; a "trade" action (pay → gain) can be repeated while you can pay. At the Arcane Abyss you draw and fight monster cards instead (below).',
		'4. Benefits: claim Awakening-phase grants (e.g. Cursed Spirit); held relic tools are offered as decision cards.',
		'5. Awakening: awaken face-down spirits by paying their cost; answer decision cards; place Spirit Augments.',
		`6. Cleanup: keep at most ${RUNE_CARRY_LIMIT} runes/relics (discard the rest); pay any spirit sacrifice you owe.`,
		'Decision cards (class abilities, relic tools, Navigation Powers) can appear in any phase; answer them when offered. Several actions per location visit are allowed and often good.',
		'',
		'## Your resources',
		`- Barrier is your health; Max Barrier is its capacity, at most ${MAX_BARRIER_CAP}. Damage turns Barrier into Broken Barrier.`,
		`- Rest restores 2 Barrier (never above your Max Barrier), then fires your active "On Rest" class effects (classes with one: ${restClasses(catalog).join(', ') || 'none'}). With full Barrier and no active On Rest effect, Rest changes nothing.`,
		`- Attack dice: at most ${MAX_ATTACK_DICE}; a dice gain at ${MAX_ATTACK_DICE} dice is lost (upgrades still work). Faces: ${faces}. Your combat damage is the sum of your rolled dice plus bonuses.`,
		'- "Any basic rune" costs are paid with one basic rune: an origin rune (e.g. Mountain Rune) or the wild Any Rune. Relics, Spirit Augments and class runes never pay them. "Any relic" costs take a relic only.',
		'- Location requirements: a "replace one of your Powers" action needs a Power you hold; a "gain" action works once per round; a "trade" action repeats while you can pay.',
		'- Initiative decides who strikes first in PvP. Runes pay costs (awakening, trades). Relics are special items; relic tools are one-time items.',
		'- Start of game: Barrier 4/4, no attack dice, four starting spirits, one Any Rune, and a choice of 1 of 3 Navigation Powers.',
		'',
		'## Corruption and alignment (source: engine combat.ts, docs/rules-v1.2.md)',
		`- When a hit (after damage reduction) is equal to or larger than your current Barrier, your Barrier drops to 0 and you are Corrupted: your status moves one step down (${STATUS_LADDER.join(' → ')}), your Barrier is restored to full, and you must sacrifice spirits of your choice — 1 for your 1st corruption, 2 for the 2nd, 3 for the 3rd, 4 for the 4th. If you are already Fallen and cannot pay in spirits, each missing spirit costs 1 VP${ruleValue(catalog, 'fallenDebtBelowZero') ? ', even below 0 (VP can go negative)' : ''}. Before Fallen, a part you cannot pay is forgiven.${ruleValue(catalog, 'pvpAttackerSacrificeCap') ? ' An Evil attacker corrupted in a player attack it started owes at most 1 sacrifice for that corruption.' : ''}`,
		`- Spirit slots: ${MAX_SPIRITS} at every status; a status drop costs only that sacrifice, and you may refill to ${MAX_SPIRITS}.`,
		ruleValue(catalog, 'pvpPaysOnCorrupt')
			? `- Only Fallen is Evil. Only Evil players can attack players. ${ruleValue(catalog, 'pvpEngageVp') ? `An Evil attacker gets ${PVP_ENGAGE_VP} VP for the attack plus ${PVP_VP_PER_CORRUPTED} VP per opponent corrupted in it.` : `An Evil attacker gets ${PVP_VP_PER_CORRUPTED} VP per opponent corrupted in the attack and nothing for the attack itself.`}${ruleValue(catalog, 'pvpGoodBounty') ? ` Each Good player in it gets ${PVP_GOOD_BOUNTY} VP per Evil attacker corrupted.` : ''}`
			: `- Only Fallen is Evil. Only Evil players can attack players. An Evil attacker gets ${pvpVpForAttack(0)} VP for the attack plus ${pvpVpForAttack(1) - pvpVpForAttack(0)} VP per opponent corrupted in it.`,
		'',
		'## Monsters (Arcane Abyss)',
		'- Monster cards are in 3 decks by Barrier (Difficulty 1: Barrier 1-3, 2: 4-7, 3: 8+). Once per visit you may draw from one deck: 2 cards are revealed, you keep 1 (the other goes to the bottom of its deck). Your monster hand holds at most 3 cards and is private. A defeated card leaves the game; an empty deck cannot be drawn from.',
		(catalog.monsters ?? []).some((m) => typeof m.initiative === 'number') ? '- Fighting: choose a card from your hand. Each monster card has an initiative number. If your initiative in that combat is HIGHER than the monster\'s (a tie goes to the monster unless you win ties, e.g. Paladin), or you have a strike-first effect (e.g. Firecracker), you strike first: if your damage defeats it, it never hits you. Otherwise the monster strikes first (its damage hits your Barrier).' + ' If that hit corrupts you, you cannot strike back (unless your side "attacks at the same time", e.g. Sharpshooter). So when a monster\'s hit (after reductions) is at least your current Barrier, your dice do not matter: only more Barrier, damage reduction (e.g. Battle Guard), a strike-first effect or a simultaneous attack lets you strike. Your damage lowers the card\'s Barrier; that damage stays on the card between fights. At Barrier 0 the card is defeated and you claim EVERY reward on it. Normally one fight per round (Monster Hunter: two).' : '- Fighting: choose a card from your hand. The monster strikes first (its damage hits your Barrier) unless you strike first (e.g. Firecracker).' + ' If that hit corrupts you, you cannot strike back (unless your side "attacks at the same time", e.g. Sharpshooter). So when a monster\'s hit (after reductions) is at least your current Barrier, your dice do not matter: only more Barrier, damage reduction (e.g. Battle Guard), a strike-first effect or a simultaneous attack lets you strike. Your damage lowers the card\'s Barrier; that damage stays on the card between fights. At Barrier 0 the card is defeated and you claim EVERY reward on it. Normally one fight per round (Monster Hunter: two).',		'',
		'## Spirits, classes, origins',
		`- Spirit World Summon: draw 4 from the Spirit World bag, summon up to 2. The 4 are 3 spirits + 1 reward hex (a basic rune, restore 2 Barrier, or a Power draft); taking it uses one of the 2 picks. Arcane Abyss Summon: ${ruleValue(catalog, 'abyssSummonDraw4Pick2') ? 'draw 4 from the Abyss bag, summon up to 2' : 'draw 3 from the Abyss bag, summon 1'}. Spirit World spirits enter AWAKE; Arcane (Abyss) spirits enter FACE-DOWN and must be awakened. Only awake spirits give their class abilities.`,
		`- Bags: Spirit World = cost ${SPIRIT_WORLD_COST_MIN}-${SPIRIT_WORLD_COST_MAX} spirits; Abyss = every cost ${ARCANE_ABYSS_COST_MIN}-${ARCANE_ABYSS_COST_MAX} (Arcane) spirit of every origin, incl. all Sun and Moon. Arcane spirits come only from an Arcane Abyss Summon (or a Summoner draw).`,
		'- Class abilities trigger at breakpoints of your count of that class among awake spirits plus placed Spirit Augments (texts below).',
		`- Origins count every spirit you hold of that origin, awake or not. When you Cultivate, for each origin: ${Object.values(ORIGIN_REWARDS)[0].runeAt}+ spirits → 1 rune of that origin; ${Object.values(ORIGIN_REWARDS)[0].relicAt}+ spirits → ${ruleValue(catalog, 'cultivateRuneOrRelic') ? "you choose one reward on a card: that rune, or that origin's relic instead (the relic once per game; an unanswered card takes the relic)" : "that origin's relic, once per game"} (${Object.entries(
			ORIGIN_REWARDS
		)
			.map(([origin, r]) => `${origin}: ${RELIC_TOOLS[r.relicId]?.name ?? 'relic'}`)
			.join(', ')}); other origins give nothing. Cultivate also fires On Cultivate class effects and does nothing else: it never adds spirits; only summoning raises an origin count.`,
		'- A Spirit Augment adds one class trait to a spirit (you choose the class when you place it; 1 augment per spirit). Augments not placed by the end of the round are lost.',
		...(ruleValue(catalog, 'summonReplaceWhenFull')
			? [
					`- Full board: when all ${MAX_SPIRITS} of your slots hold spirits, a summon may replace one of your spirits (your choice). The replaced spirit is discarded: it goes back to its bag, its augment is lost and its discard effects fire.`
				]
			: []),
		''
	].join('\n');
}

function schemaText(schema: unknown): string {
	if (!Array.isArray(schema)) return '';
	return schema
		.map((tier: { count?: unknown; effects?: { description?: string }[] }) => {
			const text = (tier.effects ?? [])
				.map((e) => e.description?.trim())
				.filter(Boolean)
				.join(' ');
			return `(${String(tier.count ?? '?')}) ${text}`;
		})
		.join(' ');
}

function cardText(catalog: PlayCatalog): string {
	const lines: string[] = [
		'# CARD TEXT (generated from the game catalog)',
		'',
		'## Locations and their actions'
	];
	for (const line of destinationSummaries(catalog)) lines.push(`- ${line}`);

	lines.push('', '## Monster decks');
	for (const difficulty of [1, 2, 3] as const) {
		const cards = (catalog.monsters ?? []).filter((m) => !m.permanent && monsterDifficulty(m) === difficulty);
		if (!cards.length) continue;
		const barrier = cards.map((m) => m.barrier);
		const damage = cards.map((m) => m.damage);
		const vp = cards.map((m) =>
			buildMonsterRewards(m.rewardTrack).reduce(
				(s, o) => s + (o.effect.type === 'vp' ? o.effect.amount : 0),
				0
			)
		);
		lines.push(
			`- Difficulty ${difficulty}: ${cards.length} cards; Barrier ${Math.min(...barrier)}-${Math.max(...barrier)}; damage ${Math.min(...damage)}-${Math.max(...damage)}; VP per kill ${Math.min(...vp)}-${Math.max(...vp)}.`
		);
	}

	const permanent = (catalog.monsters ?? []).find((m) => m.permanent);
	if (permanent) {
		const vp = buildMonsterRewards(permanent.rewardTrack).reduce(
			(s, o) => s + (o.effect.type === 'vp' ? o.effect.amount : 0),
			0
		);
		lines.push(
			`- Permanent monster "${permanent.name}": Barrier ${permanent.barrier}, damage ${permanent.damage}${typeof permanent.initiative === 'number' ? `, initiative ${permanent.initiative}` : ''}, ${vp} VP per kill plus its other rewards. It is in no deck and never runs out: instead of drawing from a deck you may take a copy into your hand (that is your draw of the visit), then fight it like any card. Because it is always there, empty decks do not end the game.`
		);
	}

	lines.push(
		'',
		'## Navigation Powers (hold several; commit at most one with your destination; it is used up at the reveal)'
	);
	for (const power of navigationPowerPool(catalog)) lines.push(`- ${power.name}: ${power.text}`);

	lines.push(
		'',
		`## Relic tools (offered once per round in Benefits: keep it or use the effect; using it discards it${relicToolVp(catalog) > 0 ? `; or take ${relicToolVp(catalog)} VP` : '. Relics give no VP'})`
	);
	for (const tool of Object.values(RELIC_TOOLS))
		lines.push(`- ${tool.name}: ${relicToolText(tool, relicToolVp(catalog))}`);

	const used = new Set<string>();
	for (const spirit of catalog.spirits)
		for (const name of Object.keys(spirit.classes ?? {})) used.add(name);
	lines.push('', '## Classes (count in brackets → effect)');
	for (const klass of catalog.classes) {
		if (!used.has(klass.name)) continue;
		const text = schemaText(ruleAdjustedClassSchema(catalog, klass.name, klass.effectSchema));
		if (text) lines.push(`- ${klass.name}: ${text}`);
	}

	lines.push('', '## Spirits (name; cost; origin; classes; awaken cost)');
	for (const spirit of catalog.spirits) {
		const origin = Object.keys(spirit.origins ?? {}).join('/') || 'none';
		const classes = Object.entries(spirit.classes ?? {})
			.map(([n, c]) => (c > 1 ? `${n}×${c}` : n))
			.join(', ');
		const awaken = !spirit.awaken
			? 'none'
			: spirit.awaken.kind === 'text'
				? `"${spirit.awaken.text}"`
				: spirit.awaken.mats.map((m) => `${m.count}× ${m.name}`).join(' + ');
		lines.push(`- ${spirit.name}; ${spirit.cost}; ${origin}; ${classes || '-'}; ${awaken}`);
	}
	return lines.join('\n');
}

const ANSWER_FORMAT = [
	'',
	'# HOW TO ANSWER',
	'Each turn you get the pace (round, your VP, VP per round still needed), your view of the table, recent events, sometimes ENGINE FACTS, and a numbered list of legal actions (ids like a1, a2, …). Choose exactly one.',
	"ENGINE FACTS are computed by the game engine on a copy of your current state: for each destination, what each location action would do for you now or the engine's reason why it is not possible; for monster cards, trial fights with practice dice rolls (not the real future rolls). They are facts, not advice.",
	'Reply with ONE JSON object and nothing else: {"action": "<id>", "reason": "<1-3 short sentences>"}'
].join('\n');

export function buildRulesBrief(catalog: PlayCatalog): string {
	return `${coreRules(catalog)}\n${cardText(catalog)}\n${ANSWER_FORMAT}\n`;
}

export function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

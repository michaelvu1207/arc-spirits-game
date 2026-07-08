/**
 * Bot-stats data generator for the /bot-stats dashboard. For each curated strategy, measures
 * win rate (reach 30 VP first) vs a field of the standard `medium` bot at player counts 1–4,
 * plus average winning round. ONE clean metric per cell — the dashboard turns it into a verdict.
 *
 * Pre-computed offline (sims are too heavy for the browser) and pooled into a committed JSON
 * (src/lib/play/sim/bot-stats.json) that the page imports. Shard-friendly via SEED_BASE so N
 * processes cover disjoint seeds; raw wins/games aggregate exactly (see aggregateBotStats.py).
 *
 *   RUN_SIM=1 BOTSTATS_GAMES=40 SEED_BASE=1 BOTSTATS_OUT=/tmp/botstats_shard_0 \
 *     npx vitest run src/lib/play/sim/botStatsData.test.ts
 */
import { describe, expect, test } from 'vitest';
import { writeFileSync } from 'node:fs';
import { loadPlayCatalog } from '../server/catalog';
import { BOT_PROFILES } from '../server/botPolicy';
import { runVsBaseline, type Entrant } from './arena';

const RUN_SIM = !!process.env.RUN_SIM;
const num = (v: string | undefined, d: number) => (v != null && v !== '' ? Number(v) : d);

/** Curated, decision-relevant strategies (NOT every micro-variant) on the real
 *  specialized-location model. Win rate is vs a field of the standard `medium` bot. */
const STRATEGIES: { key: string; label: string; group: string; blurb: string }[] = [
	// The aggressive PvP line + its no-PvP cousin.
	{ key: 'pvphunter', label: 'PvP Hunter', group: 'Aggressive / PvP', blurb: 'Corrupt→Fallen→camp Rest→PvP VP every round PvP.' },
	{ key: 'cursed', label: 'Cursed (no PvP)', group: 'Aggressive / PvP', blurb: 'Stack Cursed, descend for rewards — no PvP.' },
	// Economy safe-scaler family.
	{ key: 'hard', label: 'Hard', group: 'Economy safe-scaler', blurb: 'Safe-scaler + fight-urgency.' },
	{ key: 'rushpatient', label: 'Rush-patient', group: 'Economy safe-scaler', blurb: 'Rush potential, patient fights.' },
	{ key: 'culrush', label: 'Cultivator rush', group: 'Economy safe-scaler', blurb: 'Stack 4 Cultivators (fast potential).' },
	{ key: 'cullean', label: 'Cultivator-lean', group: 'Economy safe-scaler', blurb: 'Only 2 Cultivators, more damage slots.' },
	{ key: 'cultivator', label: 'Capacity-first', group: 'Economy safe-scaler', blurb: 'Rush potential to target.' },
	// Corruption / anti-stun probes.
	{ key: 'sim6', label: 'Anti-stun · pot 6', group: 'Corruption / anti-stun', blurb: 'Sharpshooter, low potential.' },
	{ key: 'corruption', label: 'Corrupt-punch', group: 'Corruption / anti-stun', blurb: 'Cursed + Sharpshooter, pot 6.' },
	// Potential-target lesson (trimmed sweep).
	{ key: 'pot5', label: 'Potential 5', group: 'Potential target', blurb: 'Caps barrier at 5.' },
	{ key: 'pot7', label: 'Potential 7', group: 'Potential target', blurb: 'Caps at 7 = the boss damage.' },
	{ key: 'pot10', label: 'Potential 10', group: 'Potential target', blurb: 'Old default — over-built.' },
	// Reference + baseline.
	{ key: 'medium', label: 'Medium', group: 'Reference', blurb: 'The baseline field itself (≈ fair share).' },
	{ key: 'fighter', label: 'No potential', group: 'Reference', blurb: 'Dice only — proves potential matters.' }
];

const COUNTS = [2, 3, 4, 6];

describe.skipIf(!RUN_SIM)('bot-stats data', () => {
	test('win rate by player count vs the standard field', async () => {
		const catalog = await loadPlayCatalog();
		const games = num(process.env.BOTSTATS_GAMES, 40);
		const seedBase = num(process.env.SEED_BASE, 1);
		const maxRounds = num(process.env.BOTSTATS_MAXROUNDS, 150);
		const out = process.env.BOTSTATS_OUT ?? '/tmp/botstats_shard';
		const baseline: Entrant = { name: 'medium', profile: BOT_PROFILES['medium'] };

		const strategies = STRATEGIES.map((s) => {
			const entrant: Entrant = { name: s.key, profile: BOT_PROFILES[s.key] };
			const byCount: Record<number, { wins: number; games: number; winRoundSum: number }> = {};
			for (const k of COUNTS) {
				const r = runVsBaseline(catalog, entrant, baseline, { games, seats: k, seed0: seedBase, maxRounds });
				const wins = r.wins;
				byCount[k] = {
					wins,
					games: r.games,
					winRoundSum: wins && !Number.isNaN(r.avgWinRound) ? r.avgWinRound * wins : 0
				};
			}
			return { ...s, byCount };
		});

		writeFileSync(`${out}.json`, JSON.stringify({ seedBase, games, maxRounds, baseline: 'medium', counts: COUNTS, strategies }, null, 2));
		expect(strategies.length).toBeGreaterThan(0);
	}, 1_800_000);
});

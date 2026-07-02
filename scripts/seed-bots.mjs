#!/usr/bin/env node
/**
 * Seed ~30 persistent, RATED bot accounts for ranked 2D matchmaking.
 *
 * Each bot becomes a real auth.users account (human-looking display name, is_bot metadata)
 * plus a seeded arc_spirits_2d.player_ratings row with a believable floating rating, so the
 * bots populate the leaderboard and affect OpenSkill ratings exactly like humans. The
 * `bot_profile` stores the shared ML policy key used by the bot engine at match time.
 *
 * IDEMPOTENT: a bot whose email already exists is skipped (auth account) and its rating row
 * is upserted on user_id, so re-running never duplicates accounts.
 *
 * Run (operator, NOT in CI / not from an agent):
 *   PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed-bots.mjs
 *   # or, with a .env file:  node --env-file=.env scripts/seed-bots.mjs
 *
 * Canonical roster lives in src/lib/play/server/botRoster.ts. This script duplicates it
 * inline (kept in sync by hand) because it runs as plain Node ESM with no TS loader.
 */
import { createClient } from '@supabase/supabase-js';
import { rating, ordinal } from 'openskill';

const PLAY_SCHEMA = 'arc_spirits_2d';
const RATING_VERSION = 1; // must match RATING_VERSION in src/lib/play/server/ranked.ts
const BOT_PROFILE = 'neural';

/** The bot email for a roster slug (idempotency key). Mirrors botRoster.botEmail. */
const botEmail = (slug) => `bot+${slug}@arcspirits.bot`;

// Mirror of BOT_ROSTER in src/lib/play/server/botRoster.ts (keep in sync).
const BOT_ROSTER = [
	{ displayName: 'Mia', slug: 'mia', botProfile: BOT_PROFILE },
	{ displayName: 'Leo', slug: 'leo', botProfile: BOT_PROFILE },
	{ displayName: 'Ava', slug: 'ava', botProfile: BOT_PROFILE },
	{ displayName: 'Noah', slug: 'noah', botProfile: BOT_PROFILE },
	{ displayName: 'Ella', slug: 'ella', botProfile: BOT_PROFILE },
	{ displayName: 'Finn', slug: 'finn', botProfile: BOT_PROFILE },
	{ displayName: 'Ruby', slug: 'ruby', botProfile: BOT_PROFILE },
	{ displayName: 'Owen', slug: 'owen', botProfile: BOT_PROFILE },
	{ displayName: 'Iris', slug: 'iris', botProfile: BOT_PROFILE },
	{ displayName: 'Jack', slug: 'jack', botProfile: BOT_PROFILE },
	{ displayName: 'Nora', slug: 'nora', botProfile: BOT_PROFILE },
	{ displayName: 'Theo', slug: 'theo', botProfile: BOT_PROFILE },
	{ displayName: 'Hazel', slug: 'hazel', botProfile: BOT_PROFILE },
	{ displayName: 'Milo', slug: 'milo', botProfile: BOT_PROFILE },
	{ displayName: 'Clara', slug: 'clara', botProfile: BOT_PROFILE },
	{ displayName: 'Wyatt', slug: 'wyatt', botProfile: BOT_PROFILE },
	{ displayName: 'Lena', slug: 'lena', botProfile: BOT_PROFILE },
	{ displayName: 'Caleb', slug: 'caleb', botProfile: BOT_PROFILE },
	{ displayName: 'Faye', slug: 'faye', botProfile: BOT_PROFILE },
	{ displayName: 'Reid', slug: 'reid', botProfile: BOT_PROFILE },
	{ displayName: 'Tessa', slug: 'tessa', botProfile: BOT_PROFILE },
	{ displayName: 'Dax', slug: 'dax', botProfile: BOT_PROFILE },
	{ displayName: 'Vera', slug: 'vera', botProfile: BOT_PROFILE },
	{ displayName: 'Cole', slug: 'cole', botProfile: BOT_PROFILE },
	{ displayName: 'Mara', slug: 'mara', botProfile: BOT_PROFILE },
	{ displayName: 'Silas', slug: 'silas', botProfile: BOT_PROFILE },
	{ displayName: 'Juno', slug: 'juno', botProfile: BOT_PROFILE },
	{ displayName: 'Ezra', slug: 'ezra', botProfile: BOT_PROFILE },
	{ displayName: 'Wren', slug: 'wren', botProfile: BOT_PROFILE },
	{ displayName: 'Kai', slug: 'kai', botProfile: BOT_PROFILE }
];

/**
 * Floating seed rating per bot policy. A small per-bot jitter keeps seeded bot accounts
 * from stacking on one leaderboard row while their actual play policy remains identical.
 */
const POLICY_SEED = {
	neural: { mu: 25, sigma: 5.0, games: 25 }
};

function seededRatingFor(slug, botProfile) {
	const tier = POLICY_SEED[botProfile] ?? POLICY_SEED.neural;
	// Deterministic jitter in [-1.5, 1.5) from the slug, so re-runs are stable.
	let h = 0;
	for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	const jitter = (h % 3000) / 1000 - 1.5;
	const mu = tier.mu + jitter;
	const r = rating({ mu, sigma: tier.sigma });
	return { mu: r.mu, sigma: r.sigma, ordinal: ordinal(r), games: tier.games };
}

async function main() {
	const url = process.env.PUBLIC_SUPABASE_URL;
	const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !serviceKey) {
		console.error('Missing PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.');
		process.exit(1);
	}

	const admin = createClient(url, serviceKey, {
		auth: { persistSession: false, autoRefreshToken: false }
	});
	const play = createClient(url, serviceKey, {
		db: { schema: PLAY_SCHEMA },
		auth: { persistSession: false, autoRefreshToken: false }
	});

	// Build an email → existing user map by paging through auth users (idempotency).
	const existingByEmail = new Map();
	for (let page = 1; page <= 50; page += 1) {
		const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
		if (error) {
			console.error('listUsers failed:', error.message);
			process.exit(1);
		}
		for (const u of data.users) if (u.email) existingByEmail.set(u.email.toLowerCase(), u);
		if (data.users.length < 1000) break;
	}

	let created = 0;
	let skipped = 0;
	const ratingRows = [];
	const nowIso = new Date().toISOString();

	for (const bot of BOT_ROSTER) {
		const email = botEmail(bot.slug);
		let user = existingByEmail.get(email.toLowerCase());

		if (user) {
			skipped += 1;
		} else {
			const { data, error } = await admin.auth.admin.createUser({
				email,
				email_confirm: true,
				user_metadata: {
					display_name: bot.displayName,
					is_bot: true,
					bot_profile: bot.botProfile
				}
			});
			if (error) {
				// A duplicate (race / already-exists) is fine — treat as skipped.
				if (/already|exist|registered/i.test(error.message)) {
					skipped += 1;
					console.warn(`  skip ${bot.displayName} <${email}>: ${error.message}`);
					continue;
				}
				console.error(`createUser failed for ${email}:`, error.message);
				process.exit(1);
			}
			user = data.user;
			created += 1;
		}

		if (!user) continue;
		const seed = seededRatingFor(bot.slug, bot.botProfile);
		// Match the arc_spirits_2d.player_ratings shape written by ranked.ts finalizeMatch.
		ratingRows.push({
			user_id: user.id,
			display_name: bot.displayName,
			mu: seed.mu,
			sigma: seed.sigma,
			games_played: seed.games,
			last_session_id: null,
			last_game_at: null,
			rating_version: RATING_VERSION,
			// Non-null only for bots; marks this rating row as a backfill-eligible bot account
			// and carries its shared policy key (read by matchmaking's ensureBotPresence).
			bot_profile: bot.botProfile,
			updated_at: nowIso
		});
	}

	if (ratingRows.length > 0) {
		const { error } = await play
			.from('player_ratings')
			.upsert(ratingRows, { onConflict: 'user_id' });
		if (error) {
			console.error('player_ratings upsert failed:', error.message);
			process.exit(1);
		}
	}

	console.log(
		`Bot seeding complete: ${created} created, ${skipped} skipped, ${ratingRows.length} ratings upserted.`
	);
}

main().catch((err) => {
	console.error('seed-bots failed:', err);
	process.exit(1);
});

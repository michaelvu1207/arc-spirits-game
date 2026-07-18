import { beforeEach, describe, expect, test, vi } from 'vitest';
import { FakePlayDb } from './fakePlayDb';

const holder = vi.hoisted(() => ({
	dbs: {} as Record<string, unknown>
}));

vi.mock('$lib/server/supabaseAdmin', () => ({
	getSupabaseAdmin: (schema = 'arc_spirits_game') => holder.dbs[schema] ?? null
}));

import {
	computePivotalRounds,
	computeFramePivotalMoments,
	createReplayShare,
	loadSharedReplay,
	revokeReplayShare,
	sanitizeReplayFrame,
	sanitizeReplaySnapshot
} from './replaySharing';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const GAME = 'replay-game-1';
const SESSION = '33333333-3333-4333-8333-333333333333';

function seed() {
	const play = new FakePlayDb({ rpc: true });
	const history = new FakePlayDb({ rpc: true });
	holder.dbs = { arc_spirits_2d: play, arc_spirits_game: history };
	play.rowsFor('match_results').push({ session_id: SESSION, game_id: GAME, ended_at: new Date().toISOString() });
	play.rowsFor('match_result_players').push({ session_id: SESSION, user_id: USER, is_bot: false });
	for (const [round, redVp, blueVp] of [[1, 1, 0], [2, 2, 4], [3, 8, 5]] as const) {
		for (const [player_color, victory_points] of [['Red', redVp], ['Blue', blueVp]] as const) {
			history.rowsFor('game_state_snapshots').push({
				game_id: GAME,
				navigation_count: round,
				game_timestamp: `2026-07-13T00:0${round}:00.000Z`,
				player_color,
				tts_username: player_color,
				navigation_destination: 'Abyss',
				selected_character: 'Guardian',
				victory_points,
				barrier: 3,
				max_tokens: 5,
				status_level: 0,
				status_token: 'Pure',
				spirits: [
					{ slotIndex: 1, id: 'public-spirit', name: 'Beacon', isFaceDown: false, nestedSecret: 'face-up-secret' },
					{ slotIndex: 2, id: 'secret-spirit', name: 'Secret', classes: { Rogue: 1 }, isFaceDown: true }
				],
				mats: [{ slotIndex: 1, hasRune: true, name: 'Rune', nestedSecret: 'mat-secret' }],
				spirit_augment_attachments: [{ runeId: 'r1', spiritId: 'public-spirit', spiritSlotIndex: 1, nestedSecret: 'augment-secret' }],
				hand_draws: [{ id: 'private-hand' }],
				bags: { history: [{ id: 'private-bag' }] },
				scenario: { secret: true },
				pending_work: { secret: true }
			});
		}
		history.rowsFor('replay_frames').push({
			game_id: GAME,
			revision: 9 + round,
			round,
			phase: round === 3 ? 'finished' : 'navigation',
			created_at: `2026-07-13T00:0${round}:30.000Z`,
			public_state: {
				status: round === 3 ? 'finished' : 'active',
				players: { Red: { victoryPoints: redVp }, Blue: { victoryPoints: blueVp } },
				handDraws: [{ id: 'frame-hand-secret' }],
				roomCode: 'PRIVATE',
				stateHash: 'private-state-hash',
				seats: { Red: { memberId: 'private-member', displayName: 'Red' } }
			}
		});
	}
	return { play, history };
}

beforeEach(() => {
	seed();
});

describe('replay sharing privacy and authority', () => {
	test('only a finished human participant can create a stable share', async () => {
		await expect(createReplayShare(OTHER, GAME)).rejects.toMatchObject({ status: 404 });
		const first = await createReplayShare(USER, GAME, 'A finished match');
		const repeat = await createReplayShare(USER, GAME, 'A different title');
		expect(first.code).toMatch(/^[A-Za-z0-9_-]{16}$/);
		expect(repeat).toEqual(first);
		expect((holder.dbs.arc_spirits_game as FakePlayDb).rowsFor('replay_shares')).toHaveLength(1);
	});

	test('public payload is allow-listed even when the database adapter ignores select projection', async () => {
		const share = await createReplayShare(USER, GAME);
		const replay = await loadSharedReplay(share.code);
		expect(replay.snapshots).toHaveLength(6);
		const encoded = JSON.stringify(replay);
		for (const secret of [
			'private-hand', 'private-bag', 'pending_work', 'secret-spirit', 'Secret', 'Rogue',
			'face-up-secret', 'mat-secret', 'augment-secret', 'frame-hand-secret', 'PRIVATE',
			'private-state-hash', 'private-member'
		]) {
			expect(encoded).not.toContain(secret);
		}
		expect(replay.mode).toBe('command-revision');
		expect(replay.frames.map((frame) => frame.revision)).toEqual([10, 11, 12]);
		expect(replay.snapshots[0].spirits).toContainEqual({ slotIndex: 2, isFaceDown: true });
		expect(replay.pivotalRounds).toEqual([
			{ playerColor: 'Blue', round: 2, revision: 11, gain: 4 },
			{ playerColor: 'Red', round: 3, revision: 12, gain: 6 }
		]);
	});

	test('owner revocation is immediate and creating again reactivates the same stable code', async () => {
		const share = await createReplayShare(USER, GAME);
		await expect(revokeReplayShare(OTHER, share.code)).rejects.toMatchObject({ status: 404 });
		await expect(revokeReplayShare(USER, share.code)).resolves.toEqual({ revoked: true });
		await expect(loadSharedReplay(share.code)).rejects.toMatchObject({ status: 404 });
		const restored = await createReplayShare(USER, GAME, 'Restored');
		expect(restored.code).toBe(share.code);
		await expect(loadSharedReplay(share.code)).resolves.toMatchObject({ title: 'Restored' });
	});

	test('private, revoked, expired, malformed, and empty shares fail closed', async () => {
		const { history } = seed();
		const variants = [
			{ code: 'AAAAAAAAAAAAAAAA', visibility: 'private' },
			{ code: 'BBBBBBBBBBBBBBBB', visibility: 'public', revoked_at: new Date().toISOString() },
			{ code: 'CCCCCCCCCCCCCCCC', visibility: 'public', expires_at: '2020-01-01T00:00:00.000Z' },
			{ code: 'DDDDDDDDDDDDDDDD', visibility: 'public', game_id: 'missing-game' }
		];
		for (const variant of variants) {
			history.rowsFor('replay_shares').push({
				game_id: GAME,
				owner_user_id: USER,
				created_at: new Date().toISOString(),
				revoked_at: null,
				expires_at: null,
				...variant
			});
			await expect(loadSharedReplay(variant.code)).rejects.toMatchObject({ status: 404 });
		}
		await expect(loadSharedReplay('not-valid')).rejects.toMatchObject({ status: 404 });
	});
});

describe('replay pure helpers', () => {
	test('pivotal tie-breaking is deterministic and sanitization exposes only documented keys', () => {
		const row = sanitizeReplaySnapshot({
			game_id: 'g', navigation_count: 1, game_timestamp: 't', player_color: 'Red',
			victory_points: 2, spirits: [], mats: [], spirit_augment_attachments: [], secret: 'never'
		});
		expect(Object.keys(row).sort()).toEqual([
			'barrier', 'game_id', 'game_timestamp', 'mats', 'max_tokens', 'navigation_count',
			'navigation_destination', 'player_color', 'selected_character', 'spirit_augment_attachments',
			'spirits', 'status_level', 'status_token', 'tts_username', 'victory_points'
		].sort());
		expect(computePivotalRounds([row])).toEqual([{ playerColor: 'Red', round: 1, gain: 2 }]);
		const frame = sanitizeReplayFrame({
			game_id: 'g', revision: 2, round: 1, phase: 'navigation', created_at: 't',
			public_state: { players: { Red: { victoryPoints: 3 } }, handDraws: ['secret'], memberId: 'secret' },
			secret: 'outside'
		});
		expect(JSON.stringify(frame)).not.toContain('secret');
		expect(computeFramePivotalMoments([frame])).toEqual([
			{ playerColor: 'Red', round: 1, revision: 2, gain: 3 }
		]);
	});
});

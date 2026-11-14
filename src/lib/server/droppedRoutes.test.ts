import { describe, expect, test } from 'vitest';
import { isDroppedRoute } from './droppedRoutes';

describe('isDroppedRoute', () => {
	test.each([
		'/play/ranked',
		'/play/champions',
		'/play/builder',
		'/play/builder/__data.json',
		'/invite/abc',
		'/admin',
		'/admin/login',
		'/frame-editor',
		'/api/play/matchmaking/queue',
		'/api/play/ranked/leaderboard',
		'/api/play/progression/equip',
		'/api/play/social/party/room',
		'/api/play/sessions/ABC234/concede',
		'/api/notes',
		'/api/compositions/1',
		'/api/composition-targets/rename',
		'/api/composition-analysis/game-data',
		'/api/player-compositions'
	])('drops %s', (path) => {
		expect(isDroppedRoute(path)).toBe(true);
	});

	test.each([
		'/',
		'/play',
		'/play/browse',
		'/play/records',
		'/play/ABC234',
		'/game',
		'/account',
		'/auth/callback',
		'/replay/abcdefghijklmnop',
		'/explorer',
		'/api/play/sessions',
		'/api/play/sessions/ABC234/view',
		'/api/play/sessions/ABC234/postgame',
		'/api/play/replays',
		'/api/play/solo',
		'/api/account/delete',
		'/administrator',
		'/play/rankedx'
	])('keeps %s', (path) => {
		expect(isDroppedRoute(path)).toBe(false);
	});
});

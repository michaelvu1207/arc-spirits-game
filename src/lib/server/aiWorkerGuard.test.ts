import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	listPendingAiDecisions: vi.fn(),
	actForAiSeat: vi.fn()
}));
vi.mock('$lib/play/server/aiSeats', () => mocks);

import { verifyAiWorkerKey } from '$lib/play/server/aiPlayers';
import { GET as pending } from '../../routes/api/ai/pending/+server';
import { POST as act } from '../../routes/api/ai/act/+server';

const KEY = 'test-worker-key-0123456789';

function call(handler: typeof pending | typeof act, init: RequestInit & { key?: string } = {}) {
	const headers = new Headers(init.headers);
	if (init.key !== undefined) headers.set('x-arc-ai-key', init.key);
	const request = new Request('https://arcspirits.test/api/ai/x', { ...init, headers });
	return handler({ request } as never) as Promise<Response>;
}

let saved: string | undefined;
beforeEach(() => {
	saved = process.env.ARC_AI_WORKER_KEY;
	vi.clearAllMocks();
	mocks.listPendingAiDecisions.mockResolvedValue([{ roomCode: 'ROOM01' }]);
	mocks.actForAiSeat.mockResolvedValue({ status: 200, body: { ok: true, revision: 9 } });
});
afterEach(() => {
	if (saved === undefined) delete process.env.ARC_AI_WORKER_KEY;
	else process.env.ARC_AI_WORKER_KEY = saved;
});

describe('verifyAiWorkerKey', () => {
	test('disabled without a key, constant-time match otherwise', () => {
		expect(verifyAiWorkerKey(KEY, {})).toBe('disabled');
		expect(verifyAiWorkerKey(KEY, { ARC_AI_WORKER_KEY: '  ' })).toBe('disabled');
		expect(verifyAiWorkerKey(null, { ARC_AI_WORKER_KEY: KEY })).toBe('unauthorized');
		expect(verifyAiWorkerKey('wrong', { ARC_AI_WORKER_KEY: KEY })).toBe('unauthorized');
		expect(verifyAiWorkerKey(KEY, { ARC_AI_WORKER_KEY: KEY })).toBe('ok');
	});
});

describe('/api/ai/* key guard', () => {
	test('no ARC_AI_WORKER_KEY → 404 for both endpoints, nothing runs', async () => {
		delete process.env.ARC_AI_WORKER_KEY;
		expect((await call(pending, { key: KEY })).status).toBe(404);
		expect((await call(act, { method: 'POST', key: KEY, body: '{}' })).status).toBe(404);
		expect(mocks.listPendingAiDecisions).not.toHaveBeenCalled();
		expect(mocks.actForAiSeat).not.toHaveBeenCalled();
	});

	test('missing or wrong key → 401, nothing runs', async () => {
		process.env.ARC_AI_WORKER_KEY = KEY;
		expect((await call(pending)).status).toBe(401);
		expect((await call(pending, { key: 'nope' })).status).toBe(401);
		expect((await call(act, { method: 'POST', key: 'nope', body: '{}' })).status).toBe(401);
		expect(mocks.listPendingAiDecisions).not.toHaveBeenCalled();
		expect(mocks.actForAiSeat).not.toHaveBeenCalled();
	});

	test('the right key reaches the handlers', async () => {
		process.env.ARC_AI_WORKER_KEY = KEY;
		const res = await call(pending, { key: KEY });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ items: [{ roomCode: 'ROOM01' }] });

		const body = { roomCode: 'ROOM01', seat: 'Blue', revision: 8, actionId: 'a2' };
		const acted = await call(act, {
			method: 'POST',
			key: KEY,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		expect(acted.status).toBe(200);
		expect(await acted.json()).toEqual({ ok: true, revision: 9 });
		expect(mocks.actForAiSeat).toHaveBeenCalledWith(body);
	});
});

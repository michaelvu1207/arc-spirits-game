/**
 * Rematch lifetime/ordering contract (rematchAction.ts) — a held rematch
 * response must never act on a screen the player left: no member seed, no goto
 * over the route they chose, no error write to a dead component. Rollback on a
 * failed navigation and the identity/room fence are retained.
 */
import { describe, expect, test } from 'vitest';
import { runRematch } from './rematchAction';

interface HarnessState {
	fresh: boolean;
	departed: boolean;
}

function harness(state: Partial<HarnessState> = {}) {
	const s: HarnessState = { fresh: true, departed: false, ...state };
	let resolvePost: (r: { roomCode: string; memberId: string }) => void = () => {};
	let rejectPost: (e: Error) => void = () => {};
	const post = new Promise<{ roomCode: string; memberId: string }>((resolve, reject) => {
		resolvePost = resolve;
		rejectPost = reject;
	});
	const seeds: string[] = [];
	const restores: { prior: unknown; seeded: string }[] = [];
	const navigations: string[] = [];
	const errors: string[] = [];
	let failNavigation: Error | null = null;
	const outcome = runRematch<string>({
		post: () => post,
		fresh: () => s.fresh,
		departed: () => s.departed,
		seed: (memberId) => {
			seeds.push(memberId);
			return 'prior-member';
		},
		restore: (prior, seeded) => restores.push({ prior, seeded }),
		navigate: (roomCode) => {
			if (failNavigation) return Promise.reject(failNavigation);
			navigations.push(roomCode);
			return Promise.resolve();
		},
		onError: (message) => errors.push(message)
	});
	return {
		state: s,
		outcome,
		seeds,
		restores,
		navigations,
		errors,
		resolvePost,
		rejectPost,
		setNavigationFailure: (err: Error) => {
			failNavigation = err;
		}
	};
}

describe('runRematch lifetime fencing', () => {
	test('happy path: seed → navigate, exactly once', async () => {
		const h = harness();
		h.resolvePost({ roomCode: 'REMAT1', memberId: 'm-next' });
		expect(await h.outcome).toBe('navigated');
		expect(h.seeds).toEqual(['m-next']);
		expect(h.navigations).toEqual(['REMAT1']);
		expect(h.restores).toEqual([]);
		expect(h.errors).toEqual([]);
	});

	test('UNMOUNT race: a response held past the component teardown seeds nothing, navigates nowhere, writes no error', async () => {
		const h = harness();
		h.state.departed = true; // component unmounted while the POST was in flight
		h.resolvePost({ roomCode: 'GHOSTB', memberId: 'm-ghost' });
		expect(await h.outcome).toBe('ignored');
		expect(h.seeds).toEqual([]);
		expect(h.navigations).toEqual([]);
		expect(h.errors).toEqual([]);
	});

	test('MAIN MENU race: the player explicitly navigated away — the late response must not goto room B over the /play route they chose', async () => {
		const h = harness();
		// Main Menu clicked (departed set) BEFORE the rematch response lands.
		h.state.departed = true;
		h.resolvePost({ roomCode: 'ROOMB1', memberId: 'm-b' });
		expect(await h.outcome).toBe('ignored');
		expect(h.navigations).toEqual([]); // the user stays on Main Menu
		expect(h.seeds).toEqual([]); // the global member store is untouched
	});

	test('a FAILURE landing after departure is equally silent (no error on a dead screen)', async () => {
		const h = harness();
		h.state.departed = true;
		h.rejectPost(new Error('rematch exploded'));
		expect(await h.outcome).toBe('ignored');
		expect(h.errors).toEqual([]);
	});

	test('IDENTITY/ROOM fence: a context that changed mid-flight neither navigates nor seeds — and writes no stale error over the NEW context', async () => {
		const h = harness();
		h.state.fresh = false; // account switched / different room now on screen
		h.resolvePost({ roomCode: 'WRONG1', memberId: 'm-wrong' });
		expect(await h.outcome).toBe('failed');
		expect(h.navigations).toEqual([]);
		expect(h.seeds).toEqual([]);
		// The screen now belongs to a different account/room: a message about the
		// OLD context would be noise over the new one — nothing is written.
		expect(h.errors).toEqual([]);
	});

	test('GOTO failure: the member seed rolls back and the error surfaces — room A is never rendered under room B’s member', async () => {
		const h = harness();
		h.setNavigationFailure(new Error('router exploded'));
		h.resolvePost({ roomCode: 'NAVFL1', memberId: 'm-nav' });
		expect(await h.outcome).toBe('failed');
		expect(h.seeds).toEqual(['m-nav']);
		expect(h.restores).toEqual([{ prior: 'prior-member', seeded: 'm-nav' }]);
		expect(h.errors).toEqual(['router exploded']);
	});
});

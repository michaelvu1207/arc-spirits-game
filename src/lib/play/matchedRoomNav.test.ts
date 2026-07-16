/**
 * Matched-room navigation fence (matchedRoomNav.ts) — the held-`goto` owner:
 * a matched navigation that takes seconds to load the room route must lose to
 * Back/Main-Menu, an identity change, unmount, or a newer attempt — never
 * commit over them — and must carry the e2e/ws harness params into the room.
 */
import { describe, expect, test } from 'vitest';
import { MatchedRoomNavigator, matchedRoomUrl } from './matchedRoomNav';

interface GotoCall {
	url: string;
	opts?: { replaceState?: boolean; noScroll?: boolean; keepFocus?: boolean };
	resolve: () => void;
	reject: (err: Error) => void;
}

function harness(location = { pathname: '/play', search: '?e2e' }) {
	const gotos: GotoCall[] = [];
	let activeMember: string | null = null;
	const restores: { prior: string | undefined; expected: string }[] = [];
	const nav = new MatchedRoomNavigator({
		goto(url, opts) {
			return new Promise<void>((resolve, reject) => {
				gotos.push({ url, opts, resolve, reject });
			});
		},
		currentLocation: () => ({ ...location }),
		seedMember(memberId) {
			const prior = activeMember ?? undefined;
			activeMember = memberId;
			return prior;
		},
		restoreMember(prior, expected) {
			const priorMember = prior as string | undefined;
			restores.push({ prior: priorMember, expected });
			if (activeMember === expected) activeMember = priorMember ?? null;
		}
	});
	return {
		nav,
		gotos,
		restores,
		get activeMember() {
			return activeMember;
		},
		set activeMember(v: string | null) {
			activeMember = v;
		}
	};
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('matchedRoomUrl', () => {
	test('carries ONLY the harness params (e2e, ws) into the room URL', () => {
		expect(matchedRoomUrl('ABC123', '?e2e&ws=ws%3A%2F%2F127.0.0.1%3A8811&foo=1&action=ranked')).toBe(
			'/play/ABC123?e2e=&ws=ws%3A%2F%2F127.0.0.1%3A8811'
		);
	});

	test('plain search → plain room URL', () => {
		expect(matchedRoomUrl('ABC123', '')).toBe('/play/ABC123');
		expect(matchedRoomUrl('ABC123', '?utm=x')).toBe('/play/ABC123');
	});
});

describe('MatchedRoomNavigator', () => {
	test('arrival: seeds the member, navigates with carried params, clears the hold', async () => {
		const h = harness();
		const done = h.nav.navigate('ROOM01', 'member-1');
		expect(h.activeMember).toBe('member-1');
		expect(h.nav.held).toEqual({ roomCode: 'ROOM01', memberId: 'member-1' });
		expect(h.gotos).toHaveLength(1);
		expect(h.gotos[0].url).toBe('/play/ROOM01?e2e=');
		h.gotos[0].resolve();
		await expect(done).resolves.toBe('arrived');
		expect(h.nav.held).toBeNull();
		expect(h.restores).toHaveLength(0);
	});

	test('back-out fence while the goto is HELD: rolls the seed back, supersedes with a same-URL replaceState navigation, and the held continuation is silent', async () => {
		const h = harness();
		const done = h.nav.navigate('ROOM01', 'member-1');
		expect(h.activeMember).toBe('member-1');

		expect(h.nav.fence()).toBe(true);
		// Seed rolled back exactly once, immediately (not when the goto settles).
		expect(h.restores).toEqual([{ prior: undefined, expected: 'member-1' }]);
		expect(h.activeMember).toBeNull();
		// The superseding navigation targets the CURRENT page (aborts the held load).
		expect(h.gotos).toHaveLength(2);
		expect(h.gotos[1].url).toBe('/play?e2e');
		expect(h.gotos[1].opts).toMatchObject({ replaceState: true });
		expect(h.nav.held).toBeNull();

		// The held goto now settles EITHER way — both are silent, no double-restore.
		h.gotos[0].reject(new Error('navigation aborted'));
		await expect(done).resolves.toBe('fenced');
		expect(h.restores).toHaveLength(1);
	});

	test('fenced goto that still RESOLVES (commit raced the fence) stays silent', async () => {
		const h = harness();
		const done = h.nav.navigate('ROOM01', 'member-1');
		h.nav.fence();
		h.gotos[0].resolve();
		await expect(done).resolves.toBe('fenced');
		expect(h.restores).toHaveLength(1);
	});

	test('unmount fence (supersede: false — another navigation already owns the router) issues NO extra goto', async () => {
		const h = harness();
		const done = h.nav.navigate('ROOM01', 'member-1');
		expect(h.nav.fence({ supersede: false })).toBe(true);
		expect(h.gotos).toHaveLength(1); // only the original room goto
		expect(h.activeMember).toBeNull();
		h.gotos[0].reject(new Error('aborted by the user navigation'));
		await expect(done).resolves.toBe('fenced');
	});

	test('a NEWER navigate supersedes the held one: the old continuation is silent and cannot clear the new hold', async () => {
		const h = harness();
		const first = h.nav.navigate('ROOM01', 'member-1');
		const second = h.nav.navigate('ROOM02', 'member-2');
		// The old goto settles late — silent, and the NEW hold survives it.
		h.gotos[0].resolve();
		await expect(first).resolves.toBe('fenced');
		expect(h.nav.held).toEqual({ roomCode: 'ROOM02', memberId: 'member-2' });
		h.gotos[1].resolve();
		await expect(second).resolves.toBe('arrived');
	});

	test('UNFENCED navigation failure: rolls the seed back and rethrows for the recovery UI', async () => {
		const h = harness();
		h.activeMember = 'prior-member';
		const done = h.nav.navigate('ROOM01', 'member-1');
		h.gotos[0].reject(new Error('route load failed'));
		await expect(done).rejects.toThrow('route load failed');
		expect(h.restores).toEqual([{ prior: 'prior-member', expected: 'member-1' }]);
		expect(h.activeMember).toBe('prior-member');
		expect(h.nav.held).toBeNull();
	});

	test('fence with nothing held: false, no rollback, no navigation', async () => {
		const h = harness();
		expect(h.nav.fence()).toBe(false);
		expect(h.gotos).toHaveLength(0);
		expect(h.restores).toHaveLength(0);
		await flush();
	});

	test('null memberId: navigates without touching the member seed', async () => {
		const h = harness({ pathname: '/play', search: '' });
		const done = h.nav.navigate('ROOM01', null);
		expect(h.gotos[0].url).toBe('/play/ROOM01');
		h.nav.fence();
		expect(h.restores).toHaveLength(0);
		h.gotos[0].reject(new Error('aborted'));
		await expect(done).resolves.toBe('fenced');
	});
});

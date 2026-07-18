/**
 * Account-identity trust model — adversarial regressions for the shared,
 * framework-free building blocks:
 *
 *  - wsTickets: one-use atomic consume, expiry, digest-only storage, format gate;
 *  - membership: canonical (session, user) uniqueness under duplicate + concurrent
 *    joins; bots exempt but wire-forbidden (policy layer);
 *  - roomAdmission: central visibility rules (browse/join/view);
 *  - roomLifecycle: legacy unowned-human rooms quarantine (security_upgrade);
 *  - httpGuards: CSRF / content-type / foreign-Origin cookie mutation.
 */
import { describe, expect, it } from 'vitest';
import { FakePlayDb } from './fakePlayDb';
import {
	createWsTicket,
	consumeWsTicket,
	digestWsTicket,
	isWsTicketValue,
	mintWsTicketValue,
	sweepWsTickets,
	WS_TICKETS_TABLE,
	WS_TICKET_TTL_MS
} from './wsTickets';
import { ensureRoomMembership } from './membership';
import { canJoinFromWire, canListPublicly, canViewRoom, roomVisibility } from './roomAdmission';
import { roomCloseReason } from '../roomLifecycle';
import { checkPlayApiRequest } from '../../server/httpGuards';

describe('WS tickets', () => {
	it('mints structurally-distinct values and stores ONLY the digest', async () => {
		const db = new FakePlayDb();
		const { ticket } = await createWsTicket(db, {
			sessionId: 's1',
			userId: 'u1',
			memberId: 'm1',
			role: 'member'
		});
		expect(isWsTicketValue(ticket)).toBe(true);
		const rows = db.rowsFor(WS_TICKETS_TABLE);
		expect(rows).toHaveLength(1);
		expect(JSON.stringify(rows[0])).not.toContain(ticket);
		expect(rows[0].digest).toBe(digestWsTicket(ticket));
	});

	it('consume is one-use: the second (replayed) consume fails', async () => {
		const db = new FakePlayDb();
		const { ticket } = await createWsTicket(db, {
			sessionId: 's1',
			userId: 'u1',
			memberId: 'm1',
			role: 'member'
		});
		const first = await consumeWsTicket(db, ticket);
		expect(first.ok).toBe(true);
		const replay = await consumeWsTicket(db, ticket);
		expect(replay.ok).toBe(false);
		if (!replay.ok) expect(replay.reason).toBe('not_found_or_replayed');
	});

	it('CONCURRENT replays admit exactly one winner (atomic conditional update)', async () => {
		const db = new FakePlayDb();
		const { ticket } = await createWsTicket(db, {
			sessionId: 's1',
			userId: 'u1',
			memberId: 'm1',
			role: 'member'
		});
		db.latencyMs = 2;
		const results = await Promise.all(Array.from({ length: 8 }, () => consumeWsTicket(db, ticket)));
		expect(results.filter((r) => r.ok)).toHaveLength(1);
	});

	it('an EXPIRED ticket fails even when unused (and is burned by the attempt)', async () => {
		const db = new FakePlayDb();
		const { ticket } = await createWsTicket(db, {
			sessionId: 's1',
			userId: 'u1',
			memberId: 'm1',
			role: 'member'
		});
		// The DATABASE's clock passes the lifetime — the process clock is irrelevant.
		db.dbClockOffsetMs = WS_TICKET_TTL_MS + 1;
		const result = await consumeWsTicket(db, ticket);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('expired');
		const retry = await consumeWsTicket(db, ticket);
		expect(retry.ok).toBe(false); // burned — expiry never becomes a replay window
	});

	it('MINT is database-clock authoritative: a fast app clock cannot stretch the lifetime, a slow one cannot mint dead on arrival', async () => {
		// The database runs an hour BEHIND the application (the app clock is fast).
		// The pre-fix mint wrote expires_at = app now + 30s — an effective 63-minute
		// ticket by database time. The DB mint fixes a 30-second lifetime from ITS
		// own clock no matter what the process believes.
		const fast = new FakePlayDb();
		fast.dbClockOffsetMs = -3_600_000;
		const minted = await createWsTicket(fast, {
			sessionId: 's1',
			userId: 'u1',
			memberId: 'm1',
			role: 'member'
		});
		const dbNow = Date.now() + fast.dbClockOffsetMs;
		expect(Date.parse(minted.expiresAt) - dbNow).toBeLessThanOrEqual(WS_TICKET_TTL_MS + 2000);
		expect(Date.parse(minted.expiresAt) - dbNow).toBeGreaterThan(WS_TICKET_TTL_MS - 2000);
		// The returned expiry IS the stored row's expiry — no second, app-computed value.
		expect(fast.rowsFor(WS_TICKETS_TABLE)[0].expires_at).toBe(minted.expiresAt);
		expect((await consumeWsTicket(fast, minted.ticket)).ok).toBe(true);

		// The database runs an hour AHEAD of the application (the app clock is slow).
		// The pre-fix mint produced expires_at = app now + 30s — already ~1h in the
		// database's past, dead on arrival. The DB mint keeps it consumable.
		const slow = new FakePlayDb();
		slow.dbClockOffsetMs = 3_600_000;
		const alive = await createWsTicket(slow, {
			sessionId: 's1',
			userId: 'u1',
			memberId: 'm1',
			role: 'member'
		});
		expect((await consumeWsTicket(slow, alive.ticket)).ok).toBe(true);
	});

	it('SWEEP is database-clock governed: a fast app clock cannot delete a ticket the database still honors', async () => {
		const db = new FakePlayDb();
		db.dbClockOffsetMs = -3_600_000; // app runs an hour ahead of the database
		const minted = await createWsTicket(db, {
			sessionId: 's1',
			userId: 'u1',
			memberId: 'm1',
			role: 'member'
		});
		// Pre-fix sweep deleted rows with expires_at < app now - 10min — which this
		// perfectly valid ticket satisfies from the fast process's point of view.
		await sweepWsTickets(db);
		expect(db.rowsFor(WS_TICKETS_TABLE)).toHaveLength(1);
		expect((await consumeWsTicket(db, minted.ticket)).ok).toBe(true);

		// A row the DATABASE considers long dead is removed.
		db.rowsFor(WS_TICKETS_TABLE).push({
			id: 'dead-row',
			session_id: 's1',
			user_id: 'u1',
			member_id: null,
			role: 'spectator',
			digest: digestWsTicket(mintWsTicketValue()),
			expires_at: new Date(Date.now() + db.dbClockOffsetMs - 11 * 60_000).toISOString(),
			consumed_at: null,
			created_at: new Date(Date.now() + db.dbClockOffsetMs - 12 * 60_000).toISOString()
		});
		await sweepWsTickets(db);
		expect(db.rowsFor(WS_TICKETS_TABLE).some((row) => row.id === 'dead-row')).toBe(false);
	});

	it('a store WITHOUT the mint function fails CLOSED — no application-timed insert fallback', async () => {
		const db = new FakePlayDb();
		const noRpc = { from: db.from.bind(db) } as unknown as FakePlayDb;
		await expect(
			createWsTicket(noRpc, { sessionId: 's1', userId: 'u1', memberId: 'm1', role: 'member' })
		).rejects.toThrow(/mint_ws_ticket/);
		db.failNextRpcCall('mint_ws_ticket', 'error');
		await expect(
			createWsTicket(db, { sessionId: 's1', userId: 'u1', memberId: 'm1', role: 'member' })
		).rejects.toThrow(/Failed to mint WS ticket/);
		expect(db.rowsFor(WS_TICKETS_TABLE)).toHaveLength(0); // nothing minted directly
	});

	it('format gate: UUIDs, junk and legacy-shaped credentials never reach a lookup', async () => {
		const db = new FakePlayDb();
		for (const forged of [
			'2f6a3c9e-1c1b-4c8e-9a51-51d7c8f2f000', // public member UUID
			'pms_' + 'a'.repeat(43), // retired room-secret shape
			'',
			null,
			42,
			'pwt_short'
		]) {
			const result = await consumeWsTicket(db, forged);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe('malformed');
		}
		expect(isWsTicketValue(mintWsTicketValue())).toBe(true);
	});

	it('binding fields (session/user/member/role) ride the row for the consumer to verify', async () => {
		const db = new FakePlayDb();
		const { ticket } = await createWsTicket(db, {
			sessionId: 's-room-A',
			userId: 'u-owner',
			memberId: 'm-owner',
			role: 'member'
		});
		const consumed = await consumeWsTicket(db, ticket);
		expect(consumed.ok).toBe(true);
		if (consumed.ok) {
			expect(consumed.ticket.session_id).toBe('s-room-A');
			expect(consumed.ticket.user_id).toBe('u-owner');
			expect(consumed.ticket.member_id).toBe('m-owner');
			expect(consumed.ticket.role).toBe('member');
		}
	});
});

describe('canonical membership', () => {
	it('duplicate joins by the same user converge on ONE membership', async () => {
		const db = new FakePlayDb();
		const first = await ensureRoomMembership(db, {
			sessionId: 's1',
			userId: 'u1',
			displayName: 'Player'
		});
		const second = await ensureRoomMembership(db, {
			sessionId: 's1',
			userId: 'u1',
			displayName: 'Player again'
		});
		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(second.memberId).toBe(first.memberId);
		expect(db.rowsFor('play_session_members')).toHaveLength(1);
	});

	it('CONCURRENT joins race to one row (unique-violation loser adopts the winner)', async () => {
		const db = new FakePlayDb();
		db.latencyMs = 2;
		const results = await Promise.all(
			Array.from({ length: 6 }, () =>
				ensureRoomMembership(db, { sessionId: 's1', userId: 'u1', displayName: 'P' })
			)
		);
		const ids = new Set(results.map((r) => r.memberId));
		expect(ids.size).toBe(1);
		expect(results.filter((r) => r.created)).toHaveLength(1);
		expect(
			db.rowsFor('play_session_members').filter((m) => m.user_id === 'u1' && !m.is_bot)
		).toHaveLength(1);
	});

	it('one user may hold memberships in DIFFERENT rooms', async () => {
		const db = new FakePlayDb();
		const a = await ensureRoomMembership(db, { sessionId: 's1', userId: 'u1', displayName: 'P' });
		const b = await ensureRoomMembership(db, { sessionId: 's2', userId: 'u1', displayName: 'P' });
		expect(a.memberId).not.toBe(b.memberId);
	});

	it('bots are disclosed rows, exempt from human uniqueness', async () => {
		const db = new FakePlayDb();
		const bot1 = await ensureRoomMembership(db, {
			sessionId: 's1',
			userId: 'u-bot',
			displayName: 'Mia',
			isBot: true,
			botProfile: 'neural'
		});
		const bot2 = await ensureRoomMembership(db, {
			sessionId: 's1',
			userId: null,
			displayName: 'Nyx',
			isBot: true
		});
		expect(bot1.created).toBe(true);
		expect(bot2.created).toBe(true);
		expect(db.rowsFor('play_session_members').every((m) => m.is_bot)).toBe(true);
	});

	it('a human membership WITHOUT a validated user is refused outright', async () => {
		const db = new FakePlayDb();
		await expect(
			ensureRoomMembership(db, { sessionId: 's1', userId: null, displayName: 'Ghost' })
		).rejects.toThrow(/validated user identity/);
	});
});

describe('central room admission', () => {
	const open = { status: 'lobby' as const };
	it('only PUBLIC casual rooms are browsable', () => {
		expect(canListPublicly({ mode: 'casual', visibility: 'public', ...open })).toBe(true);
		expect(canListPublicly({ mode: 'casual', visibility: 'private', ...open })).toBe(false);
		expect(canListPublicly({ mode: 'ranked', visibility: 'private', ...open })).toBe(false);
		expect(canListPublicly({ mode: 'ranked', visibility: 'public', ...open })).toBe(false);
	});

	it('private/ranked rooms never admit outsiders through generic join; members always recover', () => {
		const rematch = {
			mode: 'casual' as const,
			visibility: 'private' as const,
			status: 'lobby' as const
		};
		const rankedRoom = {
			mode: 'ranked' as const,
			visibility: 'private' as const,
			status: 'active' as const
		};
		expect(canJoinFromWire(rematch, false)).toBe(false);
		expect(canJoinFromWire(rankedRoom, false)).toBe(false);
		expect(canJoinFromWire(rematch, true)).toBe(true);
		expect(canJoinFromWire(rankedRoom, true)).toBe(true);
		expect(canJoinFromWire({ mode: 'casual', visibility: 'public', status: 'lobby' }, false)).toBe(
			true
		);
		expect(
			canJoinFromWire({ mode: 'casual', visibility: 'public', status: 'finished' }, false)
		).toBe(false);
	});

	it('private rooms are invisible (view/chat/postgame/spectate) to non-members', () => {
		const hidden = {
			mode: 'ranked' as const,
			visibility: 'private' as const,
			status: 'active' as const
		};
		expect(canViewRoom(hidden, false)).toBe(false);
		expect(canViewRoom(hidden, true)).toBe(true);
		expect(canViewRoom({ mode: 'casual', visibility: 'public', status: 'active' }, false)).toBe(
			true
		);
	});

	it('pre-migration rows normalize honestly: ranked ⇒ private, casual ⇒ public', () => {
		expect(roomVisibility({ mode: 'ranked' })).toBe('private');
		expect(roomVisibility({ mode: 'casual' })).toBe('public');
		expect(roomVisibility({ visibility: 'private', mode: 'casual' })).toBe('private');
	});
});

describe('legacy unowned-human quarantine (security_upgrade)', () => {
	const base = {
		createdAtMs: Date.now() - 1000,
		startedAtMs: null,
		humanLastSeenMs: [Date.now()]
	};
	it('an open room containing an unowned human membership closes for security upgrade', () => {
		expect(roomCloseReason({ status: 'lobby', ...base, hasUnownedHumans: true }, Date.now())).toBe(
			'security_upgrade'
		);
		expect(
			roomCloseReason(
				{ status: 'active', ...base, startedAtMs: Date.now() - 500, hasUnownedHumans: true },
				Date.now()
			)
		).toBe('security_upgrade');
	});
	it('terminal rooms and fully-owned rooms are untouched', () => {
		expect(
			roomCloseReason({ status: 'finished', ...base, hasUnownedHumans: true }, Date.now())
		).toBeNull();
		expect(
			roomCloseReason({ status: 'lobby', ...base, hasUnownedHumans: false }, Date.now())
		).toBeNull();
	});
});

describe('cookie-authenticated mutation guard (CSRF / content-type / Origin)', () => {
	const self = 'https://arcspirits.com';
	const trusted = new Set(['capacitor://localhost']);
	const base = { selfOrigin: self, trustedOrigins: trusted };

	it('reads pass untouched', () => {
		expect(
			checkPlayApiRequest({
				method: 'GET',
				origin: 'https://evil.example',
				contentType: null,
				...base
			}).ok
		).toBe(true);
	});

	it('a text/plain-smuggled JSON mutation is refused (415)', () => {
		const verdict = checkPlayApiRequest({
			method: 'POST',
			origin: null,
			contentType: 'text/plain',
			...base
		});
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.status).toBe(415);
	});

	it('a FOREIGN-Origin cookie mutation is refused — including a same-site sibling', () => {
		for (const origin of [
			'https://evil.example',
			'https://sibling.arcspirits.com', // same-site, different origin
			'http://arcspirits.com' // scheme downgrade
		]) {
			const verdict = checkPlayApiRequest({
				method: 'POST',
				origin,
				contentType: 'application/json',
				...base
			});
			expect(verdict.ok, origin).toBe(false);
			if (!verdict.ok) expect(verdict.status).toBe(403);
		}
	});

	it('same-origin, trusted-shell, and origin-less JSON mutations pass', () => {
		for (const origin of [self, 'capacitor://localhost', null]) {
			expect(
				checkPlayApiRequest({
					method: 'POST',
					origin,
					contentType: 'application/json; charset=utf-8',
					...base
				}).ok
			).toBe(true);
		}
	});
});

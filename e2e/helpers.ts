import { expect, type Page } from '@playwright/test';

type TestRoomView = {
	projection: {
		roomCode: string;
		revision: number;
		guardianPool: string[];
		round: number;
		phase: string;
		revealedDestinations: boolean;
	};
	member: {
		id: string | null;
	};
};

/**
 * POST a play API endpoint from inside a page's browser context, so the session-member
 * cookie the server sets (and re-reads) belongs to THAT player. Returns the parsed
 * RoomView. Throws with the status + body on a non-2xx so setup failures are legible.
 *
 * Why API and not the UI for setup: the room create/join/seat/guardian/start flow is
 * not what these specs exercise — the round LOOP is. Driving setup through the API is
 * far more robust than racing SvelteKit hydration on the Server Browser's create button
 * (a click landing pre-hydration silently no-ops), and `expectedRevision` is documented
 * as un-gated server-side (play is simultaneous), so no revision threading is needed.
 */
async function apiPost(
	page: Page,
	path: string,
	body: Record<string, unknown> = {}
): Promise<TestRoomView> {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const response = await page.context().request.post(path, { data: body });
		const text = await response.text();
		if (response.ok()) return JSON.parse(text);
		const retryableMemberFetch =
			response.status() >= 500 &&
			text.includes('Failed to load session member') &&
			text.includes('fetch failed') &&
			(path.includes('/commands') || path.includes('/claim-seat') || path.includes('/start'));
		const retryableServerFetch = response.status() >= 500;
		if ((retryableMemberFetch || retryableServerFetch) && attempt < 4) {
			await page.waitForTimeout(500 * (attempt + 1));
			continue;
		}
		throw new Error(`POST ${path} -> ${response.status()}: ${text.slice(0, 300)}`);
	}
	throw new Error(`POST ${path} failed after retries.`);
}

export async function expectPhase(page: Page, phase: string, timeout = 15_000): Promise<void> {
	await expect(async () => {
		const locators = phaseIndicatorLocator(page);
		const count = await locators.count();
		for (let i = 0; i < count; i += 1) {
			if ((await locators.nth(i).getAttribute('data-phase')) === phase) return;
		}
		const view = await getRoomView(page).catch(() => null);
		if (view?.projection.phase === phase) return;
		if (
			phase === 'navigation' &&
			(await page
				.getByTestId('main-scene-instruction')
				.filter({ hasText: 'Choose a Destination.' })
				.first()
				.isVisible()
				.catch(() => false))
		) {
			return;
		}
		throw new Error(`Phase ${phase} not visible yet.`);
	}).toPass({ timeout });
}

export async function expectRound(page: Page, round: number, timeout = 15_000): Promise<void> {
	await expect(async () => {
		const locators = phaseIndicatorLocator(page);
		const count = await locators.count();
		for (let i = 0; i < count; i += 1) {
			if ((await locators.nth(i).getAttribute('data-round')) === String(round)) return;
		}
		const view = await getRoomView(page).catch(() => null);
		if (view?.projection.round === round) return;
		throw new Error(`Round ${round} not visible yet.`);
	}).toPass({ timeout });
}

function phaseIndicatorLocator(page: Page) {
	return page.locator('[data-testid="phase-bar"], [data-testid="round-banner"]');
}

export async function currentPhase(page: Page): Promise<string | null> {
	const locators = phaseIndicatorLocator(page);
	const count = await locators.count();
	for (let i = 0; i < count; i += 1) {
		const value = await locators.nth(i).getAttribute('data-phase');
		if (value) return value;
	}
	return null;
}

export async function currentRound(page: Page): Promise<number> {
	const locators = phaseIndicatorLocator(page);
	const count = await locators.count();
	let value: string | null = null;
	for (let i = 0; i < count; i += 1) {
		value = await locators.nth(i).getAttribute('data-round');
		if (value) break;
	}
	return Number(value ?? 0);
}

export async function lockDestination(page: Page, location: string): Promise<void> {
	// Clicking a location now locks it in immediately (no separate confirm button).
	const target = page.getByTestId(`location-${location}`);
	await expect(target).toBeVisible();
	await expect(target).toBeEnabled();
	await target.click({ force: true });
}

/** End the player's current phase via the single "Pass turn" control. */
export async function passTurn(page: Page): Promise<void> {
	const target = page.getByTestId('pass-turn');
	await expect(target).toBeVisible();
	await expect(target).toBeEnabled();
	await target.click({ force: true });
}

function roomCodeFromPage(page: Page): string {
	const parts = new URL(page.url()).pathname.split('/').filter(Boolean);
	const code = parts.at(-1);
	if (!code || code === 'play') throw new Error(`Could not infer room code from ${page.url()}`);
	return code;
}

async function seedRoomMemberCookie(
	page: Page,
	roomCode: string,
	memberId: string | null
): Promise<void> {
	if (!memberId) throw new Error(`Missing member id for ${roomCode}`);
	await page.context().addCookies([
		{
			name: `arc_spirits_play_member_${roomCode.toUpperCase()}`,
			value: memberId,
			url: 'http://localhost:4173',
			httpOnly: true,
			sameSite: 'Lax',
			secure: false
		}
	]);
}

export async function runRoomCommand(
	page: Page,
	command: Record<string, unknown>
): Promise<TestRoomView> {
	const code = roomCodeFromPage(page);
	return apiPost(page, `/api/play/sessions/${code}/commands`, { command });
}

export async function getRoomView(page: Page): Promise<TestRoomView> {
	const code = roomCodeFromPage(page);
	const response = await page.context().request.get(`/api/play/sessions/${code}/view`);
	const text = await response.text();
	if (response.ok()) return JSON.parse(text);
	throw new Error(
		`GET /api/play/sessions/${code}/view -> ${response.status()}: ${text.slice(0, 300)}`
	);
}

async function expectRoomUiAttached(page: Page): Promise<void> {
	await expect(async () => {
		await getRoomView(page);
		const hasPhaseMarker = (await phaseIndicatorLocator(page).count()) > 0;
		const hasMainStage = await page
			.getByTestId('main-stage')
			.first()
			.isVisible()
			.catch(() => false);
		const hasNavigationText = await page
			.getByTestId('main-scene-instruction')
			.first()
			.isVisible()
			.catch(() => false);
		const hasRoundText = await page
			.getByText('Round')
			.first()
			.isVisible()
			.catch(() => false);
		if (!hasPhaseMarker && !hasMainStage && !hasNavigationText && !hasRoundText) {
			throw new Error('Room UI not attached yet.');
		}
	}).toPass({ timeout: 30_000 });
}

async function expectRoomUiAttachedWithReload(page: Page): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			await expectRoomUiAttached(page);
			return;
		} catch (error) {
			lastError = error;
			if (attempt < 2) {
				await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
			}
		}
	}
	throw lastError;
}

export async function reloadRoomPage(page: Page): Promise<Page> {
	const url = page.url();
	const context = page.context();
	await page.close().catch(() => {});
	const next = await context.newPage();
	await next.goto(url, { waitUntil: 'domcontentloaded' });
	await expectRoomUiAttachedWithReload(next);
	return next;
}

/**
 * If defeating the Arcane Abyss monster opened a reward selection, claim the first
 * available reward and dismiss whatever follow-up it produces. No-op when no menu
 * is shown (the monster survived) — keeps the combat flow robust whether or not the
 * player's dice land a kill.
 *
 * Reward cards are keyed by reward-track index (with gaps where unresolvable tokens
 * were dropped), so we select the first RENDERED card position-independently rather
 * than assuming `reward-0` exists. The picked reward may be a summon (opens a draw
 * tray → return it) or a resource/VP/rune token (shows a result card → continue).
 */
export async function claimMonsterRewardIfPresent(page: Page): Promise<void> {
	const menu = page.getByTestId('monster-reward-menu');
	if (!(await menu.isVisible().catch(() => false))) return;
	await page.getByTestId('reward-grid').locator('[data-testid^="reward-"]').first().click();
	await page.getByTestId('reward-claim').click();
	await expect(menu).toBeHidden();
	// A summon reward opens the draw tray (return the unchosen spirits); any other
	// reward shows a brief result card. Handle whichever appears so the seat can pass.
	const drawTray = page.getByTestId('draw-tray');
	const resultContinue = page.getByTestId('result-continue');
	if (await drawTray.isVisible().catch(() => false)) {
		await page.getByTestId('draw-discard').click();
	} else if (await resultContinue.isVisible().catch(() => false)) {
		await resultContinue.click();
	}
}

/**
 * Stand up a fresh 2-player game and land both clients in the active navigation phase.
 *
 * Setup runs through the API (see {@link apiPost}); each player's call executes in
 * their own browser context so the member cookie is scoped correctly. Then both pages
 * navigate into the room via the UI — which is where the specs take over and drive the
 * real round loop. Host takes Red, guest takes Blue, each with a distinct Guardian from
 * the room's pool; the host then starts the game.
 */
export async function setupTwoPlayerGame(host: Page, guest: Page): Promise<{ code: string }> {
	// Land on a same-origin page first so in-context fetch() + Set-Cookie work.
	await host.goto('/play');
	await guest.goto('/play');

	const created = await apiPost(host, '/api/play/sessions', { displayName: 'Host' });
	const code = created.projection.roomCode;
	const pool = created.projection.guardianPool;

	const joined = await apiPost(guest, `/api/play/sessions/${code}/join`, { displayName: 'Guest' });
	await seedRoomMemberCookie(host, code, created.member.id);
	await seedRoomMemberCookie(guest, code, joined.member.id);

	await apiPost(host, `/api/play/sessions/${code}/claim-seat`, { seatColor: 'Red' });
	await apiPost(host, `/api/play/sessions/${code}/commands`, {
		command: { type: 'selectGuardian', guardianName: pool[0] }
	});
	await apiPost(guest, `/api/play/sessions/${code}/claim-seat`, { seatColor: 'Blue' });
	await apiPost(guest, `/api/play/sessions/${code}/commands`, {
		command: { type: 'selectGuardian', guardianName: pool[1] }
	});

	await apiPost(host, `/api/play/sessions/${code}/commands`, {
		command: { type: 'setNavigationTimer', durationMs: null }
	});
	await apiPost(host, `/api/play/sessions/${code}/start`);

	// Hand off to the UI: load both players into the now-active game. `?e2e` skips the
	// ~240-image board-art preload (which otherwise saturates the network, starves the
	// presence poll, and gets the room reaped mid-load) — the board renders with
	// placeholder art, which is all the round-loop assertions need.
	await Promise.all([host.goto(`/play/${code}?e2e=1`), guest.goto(`/play/${code}?e2e=1`)]);
	await expectRoomUiAttachedWithReload(host);
	return { code };
}

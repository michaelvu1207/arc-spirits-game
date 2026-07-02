import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { setupTwoPlayerGame, expectPhase, getRoomView, runRoomCommand } from './helpers';

const PHONE_LANDSCAPE = { width: 932, height: 430 };
const EDGE_TOLERANCE = 2;
const VISIBLE_TARGET_TIMEOUT_MS = 45_000;
const TEAPOT_RUNE_ID = 'a6111d01-2c55-4b1f-854a-32887d92b8e1';
const INFILTRATOR_SPIRIT_ID = '40016186-6b98-4dbb-8364-b50d27e9f394';
const ABYSS_SUMMONER_SPIRIT_ID = 'e5dff9be-ac58-47bb-bd9d-69efb03dc393';
const LANTERN_FAIRY_SPIRIT_ID = 'c0d12557-4615-4c60-a93c-622e5fc70eae';

type Rect = {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
};

type LayoutSnapshot = {
	label: string;
	viewport: Rect;
	document: {
		clientWidth: number;
		clientHeight: number;
		scrollWidth: number;
		scrollHeight: number;
		bodyScrollWidth: number;
		bodyScrollHeight: number;
	};
	instruction: (Rect & { text: string }) | null;
	targets: { id: string; rect: Rect }[];
};

function rectsOverlap(a: Rect, b: Rect): boolean {
	return (
		a.left < b.right - EDGE_TOLERANCE &&
		a.right > b.left + EDGE_TOLERANCE &&
		a.top < b.bottom - EDGE_TOLERANCE &&
		a.bottom > b.top + EDGE_TOLERANCE
	);
}

function expectRectInsideViewport(rect: Rect, label: string): void {
	expect(rect.width, `${label} has measurable width`).toBeGreaterThan(0);
	expect(rect.height, `${label} has measurable height`).toBeGreaterThan(0);
	expect(rect.left, `${label} is clipped on the left`).toBeGreaterThanOrEqual(-EDGE_TOLERANCE);
	expect(rect.top, `${label} is clipped on the top`).toBeGreaterThanOrEqual(-EDGE_TOLERANCE);
	expect(rect.right, `${label} is clipped on the right`).toBeLessThanOrEqual(
		PHONE_LANDSCAPE.width + EDGE_TOLERANCE
	);
	expect(rect.bottom, `${label} is clipped on the bottom`).toBeLessThanOrEqual(
		PHONE_LANDSCAPE.height + EDGE_TOLERANCE
	);
}

async function hasVisibleTestId(page: Page, id: string): Promise<boolean> {
	return page.evaluate((id) => {
		const el = document.querySelector(`[data-testid="${CSS.escape(id)}"]`);
		if (!el) return false;
		const style = getComputedStyle(el);
		if (style.display === 'none' || style.visibility === 'hidden') return false;
		const rect = el.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	}, id);
}

async function waitForAnyVisible(page: Page, testIds: string[]): Promise<string> {
	await expect(async () => {
		for (const id of testIds) {
			if (await hasVisibleTestId(page, id)) return;
		}
		throw new Error(`None of these test ids are visible: ${testIds.join(', ')}`);
	}).toPass({ timeout: VISIBLE_TARGET_TIMEOUT_MS });
	for (const id of testIds) {
		if (await hasVisibleTestId(page, id)) return id;
	}
	throw new Error(`No visible target after wait: ${testIds.join(', ')}`);
}

async function waitForAllVisible(page: Page, testIds: string[]): Promise<void> {
	await expect
		.poll(
			async () => {
				const missing: string[] = [];
				for (const id of testIds) {
					if (!(await hasVisibleTestId(page, id))) missing.push(id);
				}
				return missing.join(', ');
			},
			{ timeout: VISIBLE_TARGET_TIMEOUT_MS, message: `Expected visible targets: ${testIds.join(', ')}` }
		)
		.toBe('');
}

async function refreshRoomPage(page: Page): Promise<void> {
	await page.reload({ waitUntil: 'domcontentloaded' });
	await expect(async () => {
		await getRoomView(page);
		if (!(await hasVisibleTestId(page, 'main-stage'))) {
			throw new Error('Main stage is not visible yet.');
		}
	}).toPass({ timeout: 30_000 });
}

async function forceUntilPhase(page: Page, phase: string, max = 3): Promise<void> {
	for (let i = 0; i < max; i += 1) {
		const view = await getRoomView(page);
		if (view.projection.phase === phase) return;
		await runRoomCommand(page, { type: 'forceAdvancePhase' });
		await refreshRoomPage(page);
	}
	await expectPhase(page, phase);
}

async function enterLocationPhase(
	host: Page,
	guest: Page,
	hostDestination: string,
	guestDestination = hostDestination
): Promise<void> {
	await runRoomCommand(host, { type: 'lockNavigation', destination: hostDestination });
	await runRoomCommand(guest, { type: 'lockNavigation', destination: guestDestination });
	await refreshRoomPage(host);
	await forceUntilPhase(host, 'location');
}

async function readLayout(page: Page, label: string, targetIds: string[]): Promise<LayoutSnapshot> {
	return page.evaluate(
		({ label, targetIds }) => {
			const rectFor = (el: Element) => {
				const r = el.getBoundingClientRect();
				return {
					left: r.left,
					top: r.top,
					right: r.right,
					bottom: r.bottom,
					width: r.width,
					height: r.height
				};
			};
			const instructionEl = document.querySelector('[data-testid="main-scene-instruction"]');
			const targets = targetIds.flatMap((id) => {
				const el = document.querySelector(`[data-testid="${CSS.escape(id)}"]`);
				if (!el) return [];
				const style = getComputedStyle(el);
				if (style.display === 'none' || style.visibility === 'hidden') return [];
				return [{ id, rect: rectFor(el) }];
			});
			const root = document.documentElement;
			const body = document.body;
			return {
				label,
				viewport: {
					left: 0,
					top: 0,
					right: window.innerWidth,
					bottom: window.innerHeight,
					width: window.innerWidth,
					height: window.innerHeight
				},
				document: {
					clientWidth: root.clientWidth,
					clientHeight: root.clientHeight,
					scrollWidth: root.scrollWidth,
					scrollHeight: root.scrollHeight,
					bodyScrollWidth: body.scrollWidth,
					bodyScrollHeight: body.scrollHeight
				},
				instruction: instructionEl
					? { ...rectFor(instructionEl), text: instructionEl.textContent?.trim() ?? '' }
					: null,
				targets
			};
		},
		{ label, targetIds }
	);
}

async function expectMobileLayoutClear(
	page: Page,
	label: string,
	targetIds: string[],
	opts: { instructionRequired?: boolean; allowInstructionOverlap?: true | string[] } = {}
): Promise<void> {
	await waitForAllVisible(page, targetIds);
	const snap = await readLayout(page, label, targetIds);
	const doc = snap.document;
	expect(doc.scrollWidth, `${label}: document has horizontal scroll`).toBeLessThanOrEqual(
		doc.clientWidth + EDGE_TOLERANCE
	);
	expect(doc.bodyScrollWidth, `${label}: body has horizontal scroll`).toBeLessThanOrEqual(
		doc.clientWidth + EDGE_TOLERANCE
	);
	expect(doc.scrollHeight, `${label}: document has vertical scroll`).toBeLessThanOrEqual(
		doc.clientHeight + EDGE_TOLERANCE
	);
	expect(doc.bodyScrollHeight, `${label}: body has vertical scroll`).toBeLessThanOrEqual(
		doc.clientHeight + EDGE_TOLERANCE
	);

	if (opts.instructionRequired ?? true) {
		expect(snap.instruction, `${label}: missing main instruction`).not.toBeNull();
		expect(snap.instruction?.text, `${label}: blank main instruction`).not.toBe('');
	}
	if (snap.instruction && snap.instruction.text) {
		expectRectInsideViewport(snap.instruction, `${label}: instruction`);
	}

	expect(snap.targets, `${label}: not every target rect was captured`).toHaveLength(targetIds.length);
	for (const target of snap.targets) {
		expectRectInsideViewport(target.rect, `${label}: ${target.id}`);
		const overlapAllowed =
			opts.allowInstructionOverlap === true ||
			(Array.isArray(opts.allowInstructionOverlap) &&
				opts.allowInstructionOverlap.includes(target.id));
		if (snap.instruction && snap.instruction.text && !overlapAllowed) {
			expect(
				rectsOverlap(snap.instruction, target.rect),
				`${label}: ${target.id} overlaps "${snap.instruction.text}"`
			).toBe(false);
		}
	}
}

async function createDebugAwakeningGame(
	page: Page,
	className: string,
	spiritId?: string
): Promise<{ code: string }> {
	await page.goto('/play');
	const response = await page.context().request.post('/api/play/debug', {
		data: { displayName: 'Layout Debug', className, spiritId }
	});
	const text = await response.text();
	expect(response.ok(), `debug room failed: ${text.slice(0, 300)}`).toBe(true);
	const view = JSON.parse(text) as { projection: { roomCode: string } };
	const code = view.projection.roomCode;
	await page.goto(`/play/${code}?e2e=1`);
	await expect(page.getByTestId('main-stage')).toBeVisible({ timeout: 30_000 });
	return { code };
}

async function makeHostEvilWithoutPendingDiscard(page: Page): Promise<void> {
	await runRoomCommand(page, { type: 'adjustStatus', amount: 3 });
	const view = (await getRoomView(page)) as {
		projection: { players?: Record<string, { spirits?: { slotIndex: number }[] }> };
	};
	const slotIndex = view.projection.players?.Red?.spirits?.[0]?.slotIndex;
	if (typeof slotIndex === 'number') {
		await runRoomCommand(page, { type: 'discardSpirit', slotIndex });
	}
}

async function finishGameWithHostVp(host: Page, guest: Page): Promise<void> {
	await enterLocationPhase(host, guest, 'Floral Patch', 'Cyber City');
	await runRoomCommand(host, { type: 'endLocationActions' });
	await runRoomCommand(guest, { type: 'endLocationActions' });
	await runRoomCommand(host, {
		type: 'debugGrant',
		grant: { kind: 'vp', amount: 30 }
	});
	await runRoomCommand(host, { type: 'commitBenefits' });
	await runRoomCommand(guest, { type: 'commitBenefits' });
	await runRoomCommand(host, { type: 'commitAwakening' });
	await runRoomCommand(guest, { type: 'commitAwakening' });
	await runRoomCommand(host, { type: 'commitCleanup' });
	await runRoomCommand(guest, { type: 'commitCleanup' });
	await host.reload({ waitUntil: 'domcontentloaded' });
	await expect(host.getByTestId('postgame')).toBeVisible({ timeout: 30_000 });
}

async function enterCleanupPhase(host: Page, guest: Page): Promise<void> {
	await enterLocationPhase(host, guest, 'Floral Patch', 'Cyber City');
	await runRoomCommand(host, { type: 'endLocationActions' });
	await runRoomCommand(guest, { type: 'endLocationActions' });
	await runRoomCommand(host, { type: 'commitBenefits' });
	await runRoomCommand(guest, { type: 'commitBenefits' });
	await runRoomCommand(host, { type: 'commitAwakening' });
	await runRoomCommand(guest, { type: 'commitAwakening' });
	await expect
		.poll(async () => (await getRoomView(host)).projection.phase, {
			timeout: 20_000,
			message: 'Expected room to reach cleanup before adding overflow runes'
		})
		.toBe('cleanup');
}

test.describe('2D play — iPhone landscape layout integrity', () => {
	test.setTimeout(300_000);

	let hostCtx: BrowserContext;
	let guestCtx: BrowserContext;
	let host: Page;
	let guest: Page;

	test.beforeEach(async ({ browser }) => {
		hostCtx = await browser.newContext({
			viewport: PHONE_LANDSCAPE,
			isMobile: true,
			hasTouch: true,
			deviceScaleFactor: 3
		});
		guestCtx = await browser.newContext({
			viewport: PHONE_LANDSCAPE,
			isMobile: true,
			hasTouch: true,
			deviceScaleFactor: 3
		});
		host = await hostCtx.newPage();
		guest = await guestCtx.newPage();
	});

	test.afterEach(async () => {
		await hostCtx.close();
		await guestCtx.close();
	});

	test('navigation, confirmed destination, and location actions stay clear', async () => {
		await setupTwoPlayerGame(host, guest);
		await refreshRoomPage(host);

		await expectMobileLayoutClear(
			host,
			'navigation carousel',
			['nav-carousel', 'leaderboard', 'rune-slots'],
			{ allowInstructionOverlap: ['leaderboard', 'rune-slots'] }
		);

		await runRoomCommand(host, { type: 'lockNavigation', destination: 'Floral Patch' });
		await refreshRoomPage(host);
		await expectMobileLayoutClear(host, 'confirmed destination', ['confirm-circle']);

		await runRoomCommand(guest, { type: 'lockNavigation', destination: 'Cyber City' });
		await refreshRoomPage(host);
		await forceUntilPhase(host, 'location');
		await expectMobileLayoutClear(
			host,
			'normal location actions',
			['interaction-grid', 'pass-turn', 'leaderboard'],
			{ allowInstructionOverlap: ['leaderboard'] }
		);

		await host.getByTestId('lb-row-Red').click({ force: true });
		await expect(host.getByTestId('composition-stage')).toBeVisible();
		await expect(host.getByTestId('pass-turn'), 'profile view must hide pass turn').toHaveCount(0);
		await expectMobileLayoutClear(
			host,
			'composition profile view',
			['composition-stage', 'scout-hexes', 'scout-dice-pool'],
			{ instructionRequired: false }
		);
	});

	test('arcane abyss action and combat surfaces stay clear', async () => {
		await setupTwoPlayerGame(host, guest);
		await refreshRoomPage(host);
		await runRoomCommand(host, {
			type: 'debugGrant',
			grant: { kind: 'attackDice', tier: 'arcane', amount: 8 }
		});
		await runRoomCommand(host, { type: 'lockNavigation', destination: 'Arcane Abyss' });
		await runRoomCommand(guest, { type: 'lockNavigation', destination: 'Arcane Abyss' });
		await runRoomCommand(host, { type: 'forceAdvancePhase' });
		await refreshRoomPage(host);

		await expectMobileLayoutClear(
			host,
			'arcane abyss action lane',
			['action-monsterCombat', 'interaction-grid', 'leaderboard'],
			{ allowInstructionOverlap: ['leaderboard'] }
		);

		await host.getByTestId('action-monsterCombat').click({ force: true });
		const combatTarget = await waitForAnyVisible(host, ['combat-overlay', 'monster-reward-menu']);
		await expectMobileLayoutClear(
			host,
			`arcane abyss ${combatTarget}`,
			combatTarget === 'combat-overlay' ? ['combat-overlay', 'combat-continue'] : [combatTarget]
		);

		if (combatTarget === 'combat-overlay') {
			await host.getByTestId('combat-continue').click({ force: true });
			await waitForAnyVisible(host, ['monster-reward-menu', 'interaction-grid', 'stage-waiting']);
		}
		if (await hasVisibleTestId(host, 'monster-reward-menu')) {
			await expectMobileLayoutClear(host, 'monster reward controls', [
				'monster-reward-menu',
				'reward-grid',
				'reward-pick-count',
				'reward-claim'
			]);
		}
	});

	test('start cutscene stays uncropped in iPhone landscape', async () => {
		const { code } = await setupTwoPlayerGame(host, guest);
		await host.goto(`/play/${code}?e2e=1&showStartCutscene=1`, { waitUntil: 'domcontentloaded' });

		await expectMobileLayoutClear(
			host,
			'start cutscene',
			['game-start-cutscene', 'start-spirits', 'start-title', 'start-hint'],
			{ instructionRequired: false, allowInstructionOverlap: true }
		);
	});

	test('encounter, profile view, and overlays stay bounded', async () => {
		await setupTwoPlayerGame(host, guest);
		await refreshRoomPage(host);
		await makeHostEvilWithoutPendingDiscard(host);
		await runRoomCommand(host, { type: 'lockNavigation', destination: 'Floral Patch' });
		await runRoomCommand(guest, { type: 'lockNavigation', destination: 'Floral Patch' });
		await refreshRoomPage(host);
		await forceUntilPhase(host, 'encounter');

		await expectMobileLayoutClear(host, 'encounter action prompt', [
			'encounter-targets',
			'encounter-attack',
			'encounter-hold'
		]);

		await host.getByTestId('toggle-info').click({ force: true });
		await expectMobileLayoutClear(host, 'info legend overlay', ['info-legend'], {
			instructionRequired: false,
			allowInstructionOverlap: true
		});
		await host.getByTestId('info-legend-close').click({ force: true });

		await host.getByTestId('toggle-settings').click({ force: true });
		await expectMobileLayoutClear(host, 'settings panel', ['settings-panel'], {
			instructionRequired: false,
			allowInstructionOverlap: true
		});
		await host.getByTestId('toggle-bags').click({ force: true });
		await expectMobileLayoutClear(host, 'bag viewer overlay', ['bag-viewer'], {
			instructionRequired: false,
			allowInstructionOverlap: true
		});
	});

	test('debug awakening offers stay below the instruction and inside the viewport', async () => {
		await createDebugAwakeningGame(host, 'Infiltrator');
		const view = await getRoomView(host);
		expect(view.projection.phase).toBe('awakening');

		await expectMobileLayoutClear(host, 'awakening offers', ['awakening-actions', 'awaken-offers']);
	});

	test('awakening discard picker stays in the main scene', async () => {
		await createDebugAwakeningGame(host, 'Fairy', LANTERN_FAIRY_SPIRIT_ID);
		await expectMobileLayoutClear(host, 'awakening offers before discard picker', [
			'awakening-actions',
			'awaken-offers'
		]);

		const offer = host.getByTestId('awaken-offers').locator('[data-testid^="awaken-"]').first();
		await expect(offer).toBeInViewport({ timeout: 5_000 });
		await offer.click({ force: true });
		await expectMobileLayoutClear(host, 'awakening discard picker', [
			'awakening-actions',
			'awaken-discard-pick',
			'awaken-discard-confirm'
		]);

		await host.getByTestId('discard-option-0').click({ force: true });
		await expect(host.getByTestId('awaken-discard-confirm')).toBeEnabled();
	});

	test('destination reveal and postgame overlays stay inside the viewport', async () => {
		const { code } = await setupTwoPlayerGame(host, guest);
		await runRoomCommand(host, { type: 'lockNavigation', destination: 'Floral Patch' });
		await runRoomCommand(guest, { type: 'lockNavigation', destination: 'Cyber City' });
		await runRoomCommand(host, { type: 'forceAdvancePhase' });
		await host.goto(`/play/${code}?e2e=1&showDestinationReveal=1`, {
			waitUntil: 'domcontentloaded'
		});
		await expectMobileLayoutClear(
			host,
			'destination reveal overlay',
			['destination-reveal', 'destination-reveal-panel', 'destination-reveal-grid'],
			{
				instructionRequired: false,
				allowInstructionOverlap: true
			}
		);

		await setupTwoPlayerGame(host, guest);
		await finishGameWithHostVp(host, guest);
		await expectMobileLayoutClear(
			host,
			'postgame overlay',
			['postgame', 'postgame-grid', 'postgame-board', 'postgame-spotlight', 'postgame-menu'],
			{
				instructionRequired: false,
				allowInstructionOverlap: true
			}
		);
	});

	test('ability decision cards stay below the instruction and inside the viewport', async () => {
		await setupTwoPlayerGame(host, guest);
		await refreshRoomPage(host);
		await runRoomCommand(host, {
			type: 'debugGrant',
			grant: { kind: 'spirit', spiritId: ABYSS_SUMMONER_SPIRIT_ID, faceDown: false }
		});
		await enterLocationPhase(host, guest, 'Floral Patch', 'Cyber City');

		await expectMobileLayoutClear(host, 'ability decision cards', ['decision-cards']);
	});

	test('infiltrator action and swap panel stay below the instruction and inside the viewport', async () => {
		await setupTwoPlayerGame(host, guest);
		await refreshRoomPage(host);
		await runRoomCommand(host, {
			type: 'debugGrant',
			grant: { kind: 'spirit', spiritId: INFILTRATOR_SPIRIT_ID, faceDown: false }
		});
		await runRoomCommand(host, {
			type: 'debugGrant',
			grant: { kind: 'attackDice', tier: 'basic', amount: 1 }
		});
		await runRoomCommand(guest, {
			type: 'debugGrant',
			grant: { kind: 'attackDice', tier: 'basic', amount: 1 }
		});
		await enterLocationPhase(host, guest, 'Floral Patch');

		await expectMobileLayoutClear(host, 'infiltrator action entry', [
			'infiltrator-open',
			'interaction-grid'
		]);
		await host.getByTestId('infiltrator-open').click({ force: true });
		await expectMobileLayoutClear(host, 'infiltrator swap panel', [
			'infiltrator-swap',
			'infil-confirm'
		]);
	});

	test('summon and resolved interaction panels stay clear', async () => {
		await setupTwoPlayerGame(host, guest);
		await refreshRoomPage(host);
		await enterLocationPhase(host, guest, 'Tidal Cove');

		await host.getByTestId('interaction-0').click({ force: true });
		await expectMobileLayoutClear(host, 'summon draw tray', ['draw-tray']);

		await setupTwoPlayerGame(host, guest);
		await refreshRoomPage(host);
		await enterLocationPhase(host, guest, 'Floral Patch');
		await host.getByTestId('interaction-0').click({ force: true });
		await expectMobileLayoutClear(host, 'resolved location interaction card', [
			'interaction-grid',
			'interaction-0'
		]);
	});

	test('augment placement and corruption discard panels stay clear', async () => {
		await setupTwoPlayerGame(host, guest);
		await refreshRoomPage(host);
		await runRoomCommand(host, {
			type: 'debugGrant',
			grant: { kind: 'augment', amount: 2 }
		});
		await enterLocationPhase(host, guest, 'Floral Patch');
		await expectMobileLayoutClear(host, 'augment placement', [
			'augment-placement',
			'augment-icons'
		]);

		await setupTwoPlayerGame(host, guest);
		await refreshRoomPage(host);
		await enterLocationPhase(host, guest, 'Floral Patch');
		await runRoomCommand(host, { type: 'adjustStatus', amount: 1 });
		await refreshRoomPage(host);
		await expectMobileLayoutClear(host, 'corruption discard', [
			'corruption-discard',
			'corruption-discard-hexes'
		]);
	});

	test('cleanup rune discard panel stays clear', async () => {
		await setupTwoPlayerGame(host, guest);
		await enterCleanupPhase(host, guest);
		for (let i = 0; i < 6; i += 1) {
			await runRoomCommand(host, {
				type: 'debugGrant',
				grant: { kind: 'rune', runeId: TEAPOT_RUNE_ID }
			});
		}
		await refreshRoomPage(host);
		await expectMobileLayoutClear(host, 'cleanup rune discard', ['rune-discard']);
	});
});

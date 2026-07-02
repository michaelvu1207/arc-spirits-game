<script lang="ts">
	import type { Snippet } from 'svelte';
	import HexGrid from '$lib/components/HexGrid.svelte';
	import { buildSpiritAugmentRow } from '$lib/gameViewer/spiritAugments';
	import { STORAGE_BASE_URL } from '$lib/supabase';
	import type {
		BagsData,
		CustomDiceAsset,
		GuardianAsset,
		HexSpiritAsset,
		IconPoolEntry,
		MonsterAsset,
		PlayerSnapshot,
		MatAsset
	} from '$lib/types';

	interface Props {
		playerSnapshots: PlayerSnapshot[];
		// Previous round's snapshots for diffing "discarded this turn".
		prevPlayerSnapshots?: PlayerSnapshot[];
		spiritAssets: Map<string, HexSpiritAsset>;
		matAssets: Map<string, MatAsset>;
		statusIcons: Map<string, IconPoolEntry>; // key: normalized status token
		guardianAssets: Map<string, GuardianAsset>;
		customDiceAssets?: Map<string, CustomDiceAsset>;
		monsterAssets?: Map<string, MonsterAsset>;
		bags?: BagsData | null;
		initialSelectedPlayerColor?: string | null;
		onPlayerSelect?: (playerColor: string | null) => void;
		// Per-player admin tag editor snippet. Rendered inline inside each player
		// row when admin mode is on; absent for non-admins.
		playerAdmin?: Snippet<[PlayerSnapshot]>;
	}

	let {
		playerSnapshots,
		prevPlayerSnapshots = [],
		spiritAssets,
		matAssets,
		statusIcons,
		guardianAssets,
		customDiceAssets = new Map<string, CustomDiceAsset>(),
		monsterAssets = new Map<string, MonsterAsset>(),
		bags = null,
		initialSelectedPlayerColor = null,
		onPlayerSelect,
		playerAdmin
	}: Props = $props();

	// Top of the Monsters V2 deck. TTS Container.getObjects() is bottom-to-top,
	// so the next-to-draw card is the LAST element of contents. Falls back to
	// the legacy `bags.monsters` key for snapshots predating the rename.
	const currentMonster = $derived(() => {
		const monsterBag = bags?.monstersV2 ?? bags?.monsters;
		const contents = monsterBag?.contents;
		const top = contents && contents.length > 0 ? contents[contents.length - 1] : null;
		if (!top) return null;

		const byId = top.id ? monsterAssets.get(top.id) : null;
		const byName = !byId
			? Array.from(monsterAssets.values()).find(
					(m) => m.name?.toLowerCase() === top.name?.toLowerCase()
				) ?? null
			: null;
		const asset = byId ?? byName ?? null;

		const imagePath = asset?.card_image_path ?? null;
		return {
			name: asset?.name ?? top.name ?? 'Unknown Monster',
			imageUrl: imagePath
				? imagePath.startsWith('http')
					? imagePath
					: `${STORAGE_BASE_URL}/${imagePath}`
				: null,
			remaining: monsterBag?.count ?? 0
		};
	});

	let selectedPlayerColor = $state<string | null>(null);
	let didUserSelectPlayerColor = $state(false);

	const sortedPlayers = $derived(() =>
		[...playerSnapshots].sort((a, b) => {
			const byVp = b.victoryPoints - a.victoryPoints;
			if (byVp !== 0) return byVp;
			return a.playerColor.localeCompare(b.playerColor);
		})
	);

	$effect(() => {
		if (sortedPlayers().length === 0) {
			selectedPlayerColor = null;
			didUserSelectPlayerColor = false;
			return;
		}

		if (!didUserSelectPlayerColor) {
			const desired = initialSelectedPlayerColor?.trim().toLowerCase() ?? null;
			if (desired) {
				const match =
					playerSnapshots.find((p) => p.playerColor.toLowerCase() === desired) ??
					playerSnapshots.find((p) => (p.ttsUsername ?? '').trim().toLowerCase() === desired) ??
					null;

				if (match && selectedPlayerColor !== match.playerColor) {
					selectedPlayerColor = match.playerColor;
					return;
				}
			}
		}

		if (selectedPlayerColor && playerSnapshots.some((p) => p.playerColor === selectedPlayerColor)) {
			return;
		}

		selectedPlayerColor = sortedPlayers()[0].playerColor;
	});

	$effect(() => {
		onPlayerSelect?.(selectedPlayerColor);
	});

	const selectedPlayer = $derived(
		() =>
			playerSnapshots.find((p) => p.playerColor === selectedPlayerColor) ??
			sortedPlayers()[0] ??
			null
	);

	function getStorageUrl(path: string | null): string | null {
		if (!path) return null;
		return path.startsWith('http') ? path : `${STORAGE_BASE_URL}/${path}`;
	}

	const spiritImageMap = $derived(() => {
		const map = new Map<string, string>();
		for (const [id, asset] of spiritAssets) {
			const imagePath = asset.game_print_image_path || asset.art_raw_image_path;
			if (imagePath) {
				const url = imagePath.startsWith('http') ? imagePath : `${STORAGE_BASE_URL}/${imagePath}`;
				map.set(id, url);
			}
		}
		return map;
	});

	const guardianIconMap = $derived(() => {
		const map = new Map<string, string>();
		for (const [name, asset] of guardianAssets) {
			if (asset.icon_image_path) {
				const url = asset.icon_image_path.startsWith('http')
					? asset.icon_image_path
					: `${STORAGE_BASE_URL}/${asset.icon_image_path}`;
				map.set(name, url);
			}
		}
		return map;
	});

	const statusIconMap = $derived(() => {
		const map = new Map<string, string>();
		for (const [key, icon] of statusIcons) {
			const url = getStorageUrl(icon.file_path);
			if (url) map.set(key, url);
		}
		return map;
	});

	function statusIconUrl(token: string | null): string | null {
		if (!token) return null;
		return statusIconMap().get(token.toLowerCase()) ?? null;
	}

	type DicePoolEntry = {
		diceId: string;
		count: number;
		name: string;
		firstFaceUrl: string | null;
		avgFace: number | null;
	};

	function faceNumericValue(rewardValue: string | null | undefined): number | null {
		if (typeof rewardValue !== 'string') return null;
		const n = Number.parseFloat(rewardValue.trim());
		return Number.isFinite(n) ? n : null;
	}

	function isAttackDie(asset: CustomDiceAsset | undefined): boolean {
		return !!asset && asset.dice_type === 'attack';
	}

	function buildDicePool(player: PlayerSnapshot | null): DicePoolEntry[] {
		if (!player) return [];

		return (player.dice ?? [])
			.filter((entry) => entry && entry.diceId && entry.count > 0)
			.map((entry) => {
				const asset = customDiceAssets.get(entry.diceId);
				const sides = (asset?.sides ?? []).slice().sort((a, b) => a.side_number - b.side_number);
				const firstFace = sides[0] ?? null;
				const numericFaces = sides
					.map((s) => faceNumericValue(s.reward_value))
					.filter((v): v is number => v !== null);
				const avgFace =
					numericFaces.length > 0
						? numericFaces.reduce((sum, v) => sum + v, 0) / numericFaces.length
						: null;

				return {
					diceId: entry.diceId,
					count: entry.count,
					name: asset?.name ?? entry.diceId,
					firstFaceUrl: getStorageUrl(firstFace?.image_path ?? asset?.background_image_path ?? null),
					avgFace: isAttackDie(asset) ? avgFace : null
				};
			})
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	// Sum of (count × avg face value) across attack dice. Null when no attack
	// dice are configured so the UI can render a dash instead of "0".
	function expectedAttackFor(player: PlayerSnapshot | null): number | null {
		const pool = buildDicePool(player);
		let total = 0;
		let contributors = 0;
		for (const entry of pool) {
			if (entry.avgFace == null) continue;
			total += entry.count * entry.avgFace;
			contributors += entry.count;
		}
		return contributors > 0 ? total : null;
	}

	const playerDicePool = $derived(() => buildDicePool(selectedPlayer()));
	const playerSpiritAugments = $derived(() =>
		buildSpiritAugmentRow(selectedPlayer(), matAssets, getStorageUrl)
	);

	function spiritAugmentCountFor(player: PlayerSnapshot | null): number {
		return buildSpiritAugmentRow(player, matAssets, getStorageUrl).length;
	}

	function formatExpected(value: number | null): string {
		// No dice configured → 0 (not a dash) so the player card always shows
		// a stable AVG number alongside VP / BAR.
		if (value == null) return '0';
		return value.toFixed(2).replace(/\.?0+$/, '');
	}

	// Per-player accent color used for the row border, status sticker, and
	// any other inline highlights. Falls back to a neutral mist for unknowns.
	const PLAYER_ACCENT: Record<string, string> = {
		Red: '#e05858',
		Blue: '#4d8bf0',
		Orange: '#f0913a',
		Green: '#4cba6a',
		Purple: '#a070e0',
		Yellow: '#e6c547',
		White: '#dcdcdc',
		Pink: '#ff6fbf',
		Teal: '#2fc7c7',
		Brown: '#b07a4e'
	};

	function playerAccent(color: string): string {
		return PLAYER_ACCENT[color] ?? 'var(--color-fog)';
	}

	const STATUS_ACCENT: Record<string, string> = {
		appear: '#4cba6a',
		pure: '#4cba6a',
		purified: '#4cba6a',
		tainted: '#e6c547',
		corrupt: '#a070e0',
		fallen: '#e05858'
	};

	function statusAccent(token: string | null): string {
		if (!token) return 'var(--color-fog)';
		return STATUS_ACCENT[token.toLowerCase()] ?? 'var(--color-fog)';
	}

	function dieRepeats(count: number): number[] {
		const cap = Math.min(Math.max(0, Math.floor(count)), 24);
		return Array.from({ length: cap }, (_, i) => i);
	}

	// Spirits drawn this turn — surfaced as a 2-column grid of portraits next
	// to the hex grid so the user can see at-a-glance what came out of the bag
	// this round without opening the bags panel.
	type SpiritEntry = { key: string; name: string; imageUrl: string | null };

	const handDrawnSpirits = $derived((): SpiritEntry[] => {
		const player = selectedPlayer();
		if (!player) return [];
		const images = spiritImageMap();
		return (player.handDraws ?? []).map((draw, i) => {
			const id = typeof draw.id === 'string' ? draw.id : null;
			const name =
				typeof draw.name === 'string' && draw.name.trim()
					? draw.name
					: id
						? (spiritAssets.get(id)?.name ?? 'Drawn spirit')
						: 'Drawn spirit';
			return {
				key: `${draw.guid ?? id ?? 'draw'}-${i}`,
				name,
				imageUrl: id ? (images.get(id) ?? null) : null
			};
		});
	});

	// "Discarded this turn" = spirits that were on the player's mat last round
	// but are not on the mat now. Identified by spirit id when available,
	// falling back to name. Skipped when there is no previous-round data.
	const discardedSpirits = $derived((): SpiritEntry[] => {
		const player = selectedPlayer();
		if (!player) return [];
		const prev = prevPlayerSnapshots.find((p) => p.playerColor === player.playerColor);
		if (!prev) return [];

		const currentKeys = new Set<string>();
		for (const s of player.spirits ?? []) {
			if (s.id) currentKeys.add(`id:${s.id}`);
			if (s.name) currentKeys.add(`nm:${s.name.toLowerCase()}`);
		}

		const images = spiritImageMap();
		const out: SpiritEntry[] = [];
		const seen = new Set<string>();

		for (const s of prev.spirits ?? []) {
			const idKey = s.id ? `id:${s.id}` : null;
			const nmKey = s.name ? `nm:${s.name.toLowerCase()}` : null;
			const stillOnBoard = (idKey && currentKeys.has(idKey)) || (nmKey && currentKeys.has(nmKey));
			if (stillOnBoard) continue;

			const dedupeKey = idKey ?? nmKey ?? `slot-${s.slotIndex}`;
			if (seen.has(dedupeKey)) continue;
			seen.add(dedupeKey);

			out.push({
				key: dedupeKey,
				name: s.name ?? 'Discarded spirit',
				imageUrl: s.id ? (images.get(s.id) ?? null) : null
			});
		}
		return out;
	});
</script>

<div class="viewer-root">
	<!-- ── Left column ────────────────────────────────────────────── -->
	<aside class="viewer-side">
		<!-- Monster section -->
		<section class="side-section">
			<header class="section-head">
				<span class="section-eyebrow">Now Fighting</span>
				{#if currentMonster()}
					<span class="section-meta">{currentMonster()?.remaining ?? 0} left</span>
				{/if}
			</header>
			<div class="monster-frame">
				{#if currentMonster()?.imageUrl}
					{@const m = currentMonster()}
					<img
						class="monster-image"
						src={m?.imageUrl ?? ''}
						alt={m?.name ?? 'Monster'}
						loading="lazy"
						decoding="async"
					/>
				{:else}
					<div class="monster-empty">No monster card</div>
				{/if}
			</div>
		</section>

		<!-- Players section -->
		<section class="side-section">
			<header class="section-head">
				<span class="section-eyebrow">Players</span>
				<span class="section-meta">{sortedPlayers().length}</span>
			</header>
			<div class="player-list">
				{#if sortedPlayers().length === 0}
					<div class="player-empty">Waiting for players…</div>
				{:else}
					{#each sortedPlayers() as player (player.playerColor)}
						{@const isSelected = selectedPlayerColor === player.playerColor}
						{@const accent = playerAccent(player.playerColor)}
								{@const guardianIconUrl = guardianIconMap().get(player.selectedCharacter) ?? null}
								{@const sIcon = statusIconUrl(player.statusToken)}
								{@const max = player.maxTokens ?? 4}
								{@const augmentCount = spiritAugmentCountFor(player)}
								<button
									type="button"
							class="player-row"
							class:selected={isSelected}
							style="--accent: {accent}"
							onclick={() => {
								didUserSelectPlayerColor = true;
								selectedPlayerColor = player.playerColor;
							}}
							aria-current={isSelected ? 'true' : undefined}
						>
							<div class="avatar">
								{#if guardianIconUrl}
									<img src={guardianIconUrl} alt={player.selectedCharacter} loading="lazy" decoding="async" />
								{:else}
									<span class="avatar-fallback">{player.selectedCharacter.slice(0, 1).toUpperCase()}</span>
								{/if}
							</div>

							<div class="row-body">
								<div class="row-top">
									<span class="player-name" title={player.ttsUsername ?? player.playerColor}>
										{player.ttsUsername ?? player.playerColor}
									</span>
									{#if player.statusToken}
										<span
											class="status-sticker"
											style="--status-accent: {statusAccent(player.statusToken)}"
											title={`${player.statusToken} (lvl ${player.statusLevel})`}
										>
											{#if sIcon}
												<img src={sIcon} alt="" loading="lazy" decoding="async" />
											{/if}
											<span class="status-label">{player.statusToken}</span>
											<span class="status-level">{player.statusLevel}</span>
										</span>
									{/if}
								</div>

								<div class="row-stats">
									<span class="stat" data-kind="vp" title="Victory Points">
										<span class="stat-num">{player.victoryPoints}</span>
										<span class="stat-unit">VP</span>
									</span>
									<span class="stat-sep" aria-hidden="true"></span>
									<span class="stat" data-kind="bar" title="Barrier / Max">
										<span class="stat-num">{player.barrier}</span><span class="stat-slash">/</span><span class="stat-max">{max}</span>
										<span class="stat-unit">BAR</span>
									</span>
									<span class="stat-sep" aria-hidden="true"></span>
									<span class="stat" data-kind="avg" title="Avg expected attack damage per roll">
										<span class="stat-num">{formatExpected(expectedAttackFor(player))}</span>
										<span class="stat-unit">AVG</span>
									</span>
									<span class="stat-sep" aria-hidden="true"></span>
									<span class="stat" data-kind="aug" title="Spirit Augments">
										<span class="stat-num">{augmentCount}</span>
										<span class="stat-unit">AUG</span>
									</span>
								</div>

								{#if playerAdmin}
									<div class="row-admin">
										{@render playerAdmin(player)}
									</div>
								{/if}
							</div>
						</button>
					{/each}
				{/if}
			</div>
		</section>
	</aside>

	<!-- ── Right side: composition top, dice pool bottom row ── -->
	<section class="viewer-main">
		{#if selectedPlayer()}
			{@const player = selectedPlayer()}
			<!-- Composition (hex + drawn / discarded) -->
			<div class="pane pane-comp">
				<header class="pane-head">
					<span class="section-eyebrow">Composition</span>
				</header>
				<div class="pane-body comp-body">
					<div class="hex-shell">
						<HexGrid spirits={player.spirits} spiritAssets={spiritImageMap()} />
					</div>

					{#if handDrawnSpirits().length > 0 || discardedSpirits().length > 0}
						<aside class="spirit-cols" aria-label="Spirits added or discarded this turn">
							{#if handDrawnSpirits().length > 0}
								<div class="spirit-col">
									<span class="spirit-col-eyebrow drawn-eb">+ Added</span>
									<div class="spirit-grid">
										{#each handDrawnSpirits() as d (d.key)}
											<div class="spirit-img drawn" title={`+ ${d.name}`}>
												{#if d.imageUrl}
													<img src={d.imageUrl} alt={d.name} loading="lazy" decoding="async" />
												{:else}
													<span class="spirit-fallback">{d.name.slice(0, 1)}</span>
												{/if}
												<span class="spirit-badge drawn-badge" aria-hidden="true">+</span>
											</div>
										{/each}
									</div>
								</div>
							{/if}

							{#if discardedSpirits().length > 0}
								<div class="spirit-col">
									<span class="spirit-col-eyebrow discarded-eb">− Discarded</span>
									<div class="spirit-grid">
										{#each discardedSpirits() as d (d.key)}
											<div class="spirit-img discarded" title={`− ${d.name}`}>
												{#if d.imageUrl}
													<img src={d.imageUrl} alt={d.name} loading="lazy" decoding="async" />
												{:else}
													<span class="spirit-fallback">{d.name.slice(0, 1)}</span>
												{/if}
												<span class="spirit-badge discarded-badge" aria-hidden="true">×</span>
											</div>
										{/each}
									</div>
								</div>
							{/if}
						</aside>
					{/if}
				</div>
			</div>

			<!-- Spirit augments — compact row above dice pool -->
			<div class="pane pane-augments">
				<header class="pane-head">
					<span class="section-eyebrow">Spirit Augments</span>
				</header>
				<div class="pane-body augment-body">
					{#if playerSpiritAugments().length === 0}
						<div class="augment-empty">No spirit augments.</div>
					{:else}
						<div class="augment-row">
							{#each playerSpiritAugments() as augment (augment.key)}
								<div class="augment-token" title={`${augment.name} · ${augment.location}`}>
									{#if augment.imageUrl}
										<img src={augment.imageUrl} alt={augment.name} loading="lazy" decoding="async" />
									{:else}
										<span class="augment-fallback">{augment.name.slice(0, 1)}</span>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</div>
			</div>

			<!-- Dice pool — bottom row, full width -->
			<div class="pane pane-dice">
				<header class="pane-head">
					<span class="section-eyebrow">Dice Pool</span>
				</header>
				<div class="pane-body dice-body">
						{#if playerDicePool().length === 0}
							<div class="dice-empty">No attack dice</div>
					{:else}
						<div class="dice-row">
							{#each playerDicePool() as die (die.diceId)}
								{#each dieRepeats(die.count) as i (`${die.diceId}-${i}`)}
									<div
										class="die-img"
										title={`${die.name}${die.avgFace != null ? ` · avg ${die.avgFace.toFixed(2).replace(/\.?0+$/, '')}` : ''}`}
									>
										{#if die.firstFaceUrl}
											<img src={die.firstFaceUrl} alt="" loading="lazy" decoding="async" />
										{:else}
											<span class="die-fallback">{die.name.slice(0, 1)}</span>
										{/if}
									</div>
								{/each}
							{/each}
						</div>
					{/if}
				</div>
			</div>
		{:else}
			<div class="empty-main">No player data for this round yet.</div>
		{/if}
	</section>
</div>

<style>
	/* =============================================================
	   Tokens (component-local) — keep magic numbers tidy
	   ============================================================= */
	.viewer-root {
		--vw-pad: 1.25rem;
		--vw-gap: 0;
		--vw-side-w: 22rem;
		--vw-rule: rgba(255, 255, 255, 0.08);
		--vw-rule-strong: rgba(255, 255, 255, 0.14);
		--vw-row-bg: transparent;
		--vw-row-bg-hover: rgba(255, 255, 255, 0.04);
		--vw-row-bg-selected: rgba(255, 255, 255, 0.07);
		--vw-text: var(--color-bone, #f0eada);
		--vw-mute: var(--color-fog, #8d8aa1);
		--vw-whisper: var(--color-whisper, #6a6680);
	}

	/* =============================================================
	   Layout — flat panels separated by dividers, no rounded cards
	   ============================================================= */
	.viewer-root {
		display: flex;
		flex-direction: column;
		min-width: 0;
		overflow: hidden;
		/* Lock to viewport — no page scrolling. Offset (~140px) covers the
		   site topbar + the round/summary bar that sit above us. */
		height: calc(100vh - 140px);
	}
	@media (min-width: 1024px) {
		.viewer-root {
			flex-direction: row;
			align-items: stretch;
		}
	}

	.viewer-side {
		display: flex;
		flex-direction: column;
		gap: 0;
		flex-shrink: 0;
		width: 100%;
		min-height: 0;
		overflow: hidden;
		/* Solid dark surface — same family as the topbar / nav. Edge-to-edge,
		   separated from the right area only by a vertical divider. */
		background: rgba(8, 4, 18, 0.98);
		border-bottom: 1px solid var(--vw-rule-strong);
	}
	@media (min-width: 1024px) {
		.viewer-side {
			width: 28.6rem;
			align-self: stretch;
			border-bottom: 0;
			border-right: 1px solid var(--vw-rule-strong);
		}
	}

	/* Internal sections inside the sidebar — separated by a thin rule
	   instead of being separate cards. */
	.side-section {
		display: flex;
		flex-direction: column;
		padding: 1rem 1.1rem;
		min-height: 0;
	}
	.side-section + .side-section {
		border-top: 1px solid var(--vw-rule);
		flex: 1 1 auto;
		min-height: 0;
		overflow: hidden;
	}

	.viewer-main {
		flex: 1;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 0;
		align-self: stretch;
		overflow: hidden;
		/* Translucent — page background bleeds through. No rounded card. */
		background: rgba(255, 255, 255, 0.02);
	}

	/* A "pane" is one of the stretchable rows inside the right side
	   (composition on top, dice pool on the bottom). Each pane has its own
	   header strip plus a body that fills the remaining vertical space. */
	.pane {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	.pane-comp {
		flex: 1 1 auto;
		min-height: 0;
		padding: 1rem 1.25rem;
		overflow: hidden;
	}
	.pane-dice {
		flex: 0 0 auto;
		width: 100%;
		border-top: 1px solid var(--vw-rule-strong);
		padding: 0.75rem 1.25rem 1rem;
		background: rgba(0, 0, 0, 0.18);
	}
	.pane-augments {
		flex: 0 0 auto;
		width: 100%;
		border-top: 1px solid var(--vw-rule-strong);
		padding: 0.65rem 1.25rem 0.75rem;
		background: rgba(0, 0, 0, 0.12);
	}
	.pane-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		padding-bottom: 0.5rem;
		margin-bottom: 0.75rem;
		border-bottom: 1px solid var(--vw-rule);
	}
	.pane-dice .pane-head {
		border-bottom: 0;
		padding-bottom: 0.4rem;
		margin-bottom: 0.4rem;
	}
	.pane-augments .pane-head {
		border-bottom: 0;
		padding-bottom: 0.35rem;
		margin-bottom: 0.35rem;
	}
	.pane-body {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
	}

	/* =============================================================
	   Section header — uppercase eyebrow with a thin underline.
	   Used as a consistent visual rhythm across both columns.
	   ============================================================= */
	.section-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		padding-bottom: 0.5rem;
		margin-bottom: 0.75rem;
		border-bottom: 1px solid var(--vw-rule);
	}
	.section-head.sm {
		padding-bottom: 0.35rem;
		margin-bottom: 0.5rem;
	}
	.section-eyebrow {
		font-family: var(--font-display);
		font-size: 0.9rem;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--brand-magenta-soft, #ff7fd9);
		line-height: 1;
	}
	.section-meta {
		font-family: var(--font-display);
		font-size: 0.85rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--vw-whisper);
		font-variant-numeric: tabular-nums;
	}

	/* =============================================================
	   Monster card frame
	   ============================================================= */
	.monster-frame {
		width: 100%;
		display: flex;
		justify-content: center;
		padding: 0.25rem 0;
	}
	.monster-image {
		width: 100%;
		max-width: 22rem;
		height: auto;
		object-fit: contain;
		display: block;
		border-radius: 10px;
	}
	.monster-empty {
		font-family: var(--font-display);
		font-size: 0.7rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--vw-whisper);
		padding: 1.5rem;
		text-align: center;
		width: 100%;
		border: 1px dashed var(--vw-rule);
		border-radius: 8px;
	}

	/* =============================================================
	   Player list
	   ============================================================= */
	.player-list {
		display: flex;
		flex-direction: column;
		gap: 0;
		min-width: 0;
		flex: 1 1 auto;
		min-height: 0;
		overflow: hidden;
	}
	.player-empty {
		font-size: 0.8rem;
		color: var(--vw-whisper);
		padding: 1rem;
		text-align: center;
	}

		.player-row {
			display: flex;
			align-items: center;
			gap: 1.2rem;
			min-height: 7.4rem;
			padding: 1rem 1rem;
			text-align: left;
			background: var(--vw-row-bg);
		border: 0;
		border-left: 4px solid var(--accent, transparent);
		border-bottom: 1px solid var(--vw-rule);
		cursor: pointer;
		transition: background 140ms ease;
		width: 100%;
		min-width: 0;
		font: inherit;
		color: inherit;
	}
	.player-row:last-child {
		border-bottom: 0;
	}
	.player-row:hover {
		background: var(--vw-row-bg-hover);
	}
	.player-row.selected {
		background: var(--vw-row-bg-selected);
		border-left-width: 5px;
	}

	.avatar {
		width: 4.5rem;
		height: 4.5rem;
		flex-shrink: 0;
		border-radius: 50%;
		overflow: hidden;
		background: var(--color-crypt, #1a1029);
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: 0 0 0 1px var(--vw-rule);
	}
	.avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.avatar-fallback {
		font-family: var(--font-display);
		font-size: 2rem;
		color: var(--vw-text);
	}

	.row-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.row-top {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		min-width: 0;
	}
	.player-name {
		font-family: var(--font-display);
		font-size: 1.7rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--vw-text);
		line-height: 1;
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
		.status-sticker {
			display: inline-flex;
			align-items: center;
			gap: 6px;
		padding: 4px 10px;
		border-radius: 999px;
			font-size: 0.78rem;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			background: var(--status-accent, var(--vw-mute));
			color: var(--color-void, #0c0518);
			font-weight: 700;
		flex-shrink: 0;
		max-width: 60%;
		line-height: 1;
	}
	.status-sticker img {
		width: 16px;
		height: 16px;
		object-fit: contain;
	}
	.status-label {
		max-width: 7rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.status-level {
		opacity: 0.8;
		font-variant-numeric: tabular-nums;
	}
	/* Stats row — VP · BAR · AVG · AUG with thin dividers between groups */
	.row-stats {
		display: flex;
		align-items: baseline;
		gap: 0.65rem;
	}
	.stat {
		display: inline-flex;
		align-items: baseline;
		gap: 4px;
	}
	.stat-sep {
		display: inline-block;
		width: 1px;
		height: 1.1em;
		background: var(--vw-rule);
		align-self: center;
	}
	.stat-num {
		font-family: var(--font-display);
		font-size: 2.1rem;
		line-height: 1;
		color: var(--vw-text);
		font-variant-numeric: tabular-nums;
	}
	.stat[data-kind='vp'] .stat-num {
		color: var(--brand-amber, #ffba3d);
	}
	.stat[data-kind='bar'] .stat-num {
		color: var(--brand-cyan, #5cdfff);
	}
	.stat[data-kind='avg'] .stat-num {
		color: var(--brand-magenta-soft, #ff7fd9);
	}
	.stat[data-kind='aug'] .stat-num {
		color: var(--brand-violet-soft, #b995ff);
	}
	.stat-slash {
		color: var(--vw-whisper);
		font-size: 1.2rem;
	}
	.stat-max {
		font-family: var(--font-display);
		font-size: 1.5rem;
		color: var(--vw-mute);
		font-variant-numeric: tabular-nums;
	}
	.stat-unit {
		font-family: var(--font-display);
		font-size: 0.7rem;
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: var(--vw-whisper);
		margin-left: 4px;
	}

	/* =============================================================
	   Composition pane: hex grid centered, spirit cols (drawn / discarded)
	   on the right
	   ============================================================= */
	.comp-body {
		display: flex;
		flex-direction: row;
		align-items: stretch;
		justify-content: center;
		gap: 1rem;
		width: 100%;
		min-width: 0;
		min-height: 0;
		flex: 1 1 auto;
	}
	.hex-shell {
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		/* The SVG scales `xMidYMid meet` so it fills whichever dimension is
		   the binding constraint while preserving the 7-hex aspect ratio. */
	}
	.spirit-cols {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		width: 16rem;
		flex-shrink: 0;
		min-height: 0;
		overflow: hidden;
	}
	.spirit-col {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.spirit-col-eyebrow {
		font-family: var(--font-display);
		font-size: 0.85rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		line-height: 1;
	}
	.drawn-eb {
		color: #5cdfb0;
	}
	.discarded-eb {
		color: #ff7a8a;
	}
	.spirit-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}
	.spirit-img {
		position: relative;
		aspect-ratio: 1 / 1;
		border-radius: 6px;
		overflow: hidden;
		background: var(--color-crypt, #1a1029);
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.spirit-img img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.spirit-fallback {
		font-family: var(--font-display);
		font-size: 0.95rem;
		color: var(--vw-text);
	}
	.spirit-img.drawn {
		box-shadow: 0 0 0 2px #5cdfb0;
	}
	.spirit-img.discarded {
		box-shadow: 0 0 0 2px #ff7a8a;
	}
	.spirit-img.discarded img {
		opacity: 0.55;
		filter: grayscale(0.4);
	}
	.spirit-badge {
		position: absolute;
		top: 4px;
		right: 4px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 22px;
		height: 22px;
		padding: 0 5px;
		font-family: var(--font-display);
		font-size: 1rem;
		line-height: 1;
		border-radius: 4px;
		color: var(--color-void, #0c0518);
		font-weight: 800;
	}
	.drawn-badge {
		background: #5cdfb0;
	}
	.discarded-badge {
		background: #ff7a8a;
	}

	/* =============================================================
	   Spirit augment pane: horizontal row above the dice pool
	   ============================================================= */
	.augment-body {
		flex: 0 0 auto;
		min-height: 0;
	}
	.augment-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		justify-content: flex-start;
		align-content: flex-start;
		width: 100%;
		padding: 0.15rem 0;
	}
	.augment-empty {
		font-size: 0.75rem;
		color: var(--vw-whisper);
		padding: 0.35rem 0.5rem;
	}
	.augment-token {
		width: 3rem;
		height: 3rem;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		border-radius: 6px;
		background: var(--color-crypt, #1a1029);
		box-shadow: 0 0 0 1px rgba(255, 127, 217, 0.35);
		overflow: hidden;
	}
	.augment-token img {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}
	.augment-fallback {
		font-family: var(--font-display);
		font-size: 1.15rem;
		color: var(--vw-text);
	}

	/* =============================================================
	   Dice pane: horizontal row at the bottom of the right side
	   ============================================================= */
	.dice-body {
		flex: 0 0 auto;
		min-height: 0;
	}
	.dice-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		justify-content: flex-start;
		align-content: flex-start;
		width: 100%;
		padding: 0.25rem 0;
	}
	.dice-empty {
		font-size: 0.75rem;
		color: var(--vw-whisper);
		padding: 0.5rem;
	}
	.die-img {
		width: 3.5rem;
		height: 3.5rem;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.die-img img {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}
	.die-fallback {
		font-family: var(--font-display);
		font-size: 1.4rem;
		color: var(--vw-text);
		background: var(--color-crypt, #1a1029);
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
	}

	/* =============================================================
	   Inline player-row admin tag block (rendered via `playerAdmin` snippet)
	   ============================================================= */
	.row-admin {
		margin-top: 4px;
		padding-top: 8px;
		border-top: 1px dashed var(--vw-rule);
	}
	:global(.row-admin .admin-warn) {
		font-size: 0.75rem;
		color: #ffcb6b;
		background: rgba(255, 203, 107, 0.08);
		border: 1px solid rgba(255, 203, 107, 0.25);
		padding: 6px 8px;
		border-radius: 6px;
	}
	:global(.row-admin .admin-error) {
		font-size: 0.75rem;
		color: #ff8a8a;
		background: rgba(255, 138, 138, 0.08);
		border: 1px solid rgba(255, 138, 138, 0.25);
		padding: 6px 8px;
		border-radius: 6px;
	}
	:global(.row-admin .admin-empty) {
		font-size: 0.8rem;
		color: var(--vw-whisper);
		padding: 0.5rem;
	}
	:global(.row-admin .admin-stack) {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}
	:global(.row-admin .admin-card) {
		background: var(--vw-row-bg);
		border: 1px solid var(--vw-rule);
		border-radius: 8px;
		padding: 0.6rem 0.7rem;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	:global(.row-admin .admin-card-head) {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
	}
	:global(.row-admin .admin-card-name) {
		font-family: var(--font-display);
		font-size: 0.95rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--vw-text);
	}
	:global(.row-admin .admin-card-meta) {
		font-family: var(--font-display);
		font-size: 0.6rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--vw-whisper);
	}
	:global(.row-admin .admin-tags) {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	:global(.row-admin .tag-pill) {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 3px 8px;
		font-size: 0.7rem;
		color: var(--vw-text);
		background: rgba(255, 127, 217, 0.1);
		border: 1px solid rgba(255, 127, 217, 0.3);
		border-radius: 999px;
		cursor: pointer;
		font: inherit;
		font-size: 0.7rem;
		line-height: 1;
		transition: border-color 140ms, background 140ms;
	}
	:global(.row-admin .tag-pill:hover) {
		border-color: #ff8a8a;
		background: rgba(255, 138, 138, 0.12);
	}
	:global(.row-admin .tag-pill-label) {
		max-width: 8rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	:global(.row-admin .tag-pill-x) {
		opacity: 0.6;
	}
	:global(.row-admin .admin-add) {
		display: flex;
		gap: 4px;
		align-items: stretch;
	}
	:global(.row-admin .admin-input) {
		flex: 1;
		min-width: 0;
		padding: 5px 8px;
		font-size: 0.78rem;
		color: var(--vw-text);
		background: var(--color-void, #0c0518);
		border: 1px solid var(--vw-rule);
		border-radius: 6px;
		font: inherit;
		font-size: 0.78rem;
	}
	:global(.row-admin .admin-input:focus) {
		outline: none;
		border-color: var(--brand-magenta-soft, #ff7fd9);
	}
	:global(.row-admin .admin-add-btn) {
		padding: 0 10px;
		font-family: var(--font-display);
		font-size: 1rem;
		color: var(--color-void, #0c0518);
		background: var(--brand-magenta-soft, #ff7fd9);
		border: 0;
		border-radius: 6px;
		cursor: pointer;
		line-height: 1;
		min-width: 28px;
	}
	:global(.row-admin .admin-add-btn:disabled),
	:global(.row-admin .admin-input:disabled) {
		opacity: 0.5;
		cursor: not-allowed;
	}
	:global(.row-admin .admin-footer-link) {
		font-family: var(--font-display);
		font-size: 0.7rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--brand-magenta-soft, #ff7fd9);
		text-decoration: none;
		padding: 0.25rem 0.5rem;
		align-self: flex-end;
	}
	:global(.row-admin .admin-footer-link:hover) {
		color: var(--vw-text);
	}

	.empty-main {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.85rem;
		color: var(--vw-mute);
		padding: 4rem;
	}

	.tabular-nums {
		font-variant-numeric: tabular-nums;
	}
</style>

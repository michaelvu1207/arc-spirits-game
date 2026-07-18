<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import GameIcon from '$lib/components/GameIcon.svelte';
	import MenuShell from '$lib/components/play2d/MenuShell.svelte';
	import TraitTracker from '$lib/components/play2d/TraitTracker.svelte';
	import HexGrid from '$lib/components/HexGrid.svelte';
	import { loadAssets, getAssetState, getSpiritAsset } from '$lib/stores/assetStore.svelte';
	import { playMenuSfx } from '$lib/stores/menuAudio.svelte';
	import { bagForSpiritCost, SPIRIT_WORLD_BAG, ARCANE_ABYSS_BAG } from '$lib/play/bags';
	import { BUNDLED_SPIRIT_CATALOG } from '$lib/play/bundledSpiritCatalog';
	import type { ResolvedSpiritAsset } from '$lib/types';
	import type { PlaySpirit, PlayerProjection } from '$lib/play/types';

	const assets = getAssetState();
	const TEAM_SIZE = 7;

	let restored = $state(false);
	let search = $state('');
	let originFilter = $state(''); // origin id, '' = all
	let sourceFilter = $state<'all' | 'spiritWorld' | 'arcaneAbyss'>('all');
	let teamName = $state('New Team');
	/** board[i] = a spirit id, or null for an empty slot. Duplicates are allowed. */
	let board = $state<(string | null)[]>(Array(TEAM_SIZE).fill(null));

	const LS_KEY = 'arc-comp-builder';

	const loadError = $derived(assets.error);

	onMount(() => {
		// Match the play menu's immersive full-screen (hides global chrome, locks scroll).
		document.documentElement.classList.add('immersive-play');
		document.body.classList.add('immersive-play');
		restore();
		restored = true;
		void loadAssets();
		return () => {
			document.documentElement.classList.remove('immersive-play');
			document.body.classList.remove('immersive-play');
		};
	});

	function retryLoad() {
		void loadAssets();
	}

	function persist() {
		if (browser) localStorage.setItem(LS_KEY, JSON.stringify({ teamName, board }));
	}
	function restore() {
		if (!browser) return;
		try {
			const raw = localStorage.getItem(LS_KEY);
			if (!raw) return;
			const data = JSON.parse(raw) as { teamName?: string; board?: (string | null)[] };
			if (Array.isArray(data.board)) {
				const next = Array(TEAM_SIZE).fill(null) as (string | null)[];
				for (let i = 0; i < TEAM_SIZE; i += 1) next[i] = data.board[i] ?? null;
				board = next;
			}
			if (typeof data.teamName === 'string') teamName = data.teamName;
		} catch {
			/* ignore corrupt saves */
		}
	}
	// Autosave once the saved build has been restored (so we don't clobber it first).
	$effect(() => {
		if (!restored) return;
		void teamName;
		void board;
		persist();
	});

	// ── Spirit catalog (left) ─────────────────────────────────────────────────
	const liveCatalog = $derived.by((): ResolvedSpiritAsset[] => {
		const list: ResolvedSpiritAsset[] = [];
		for (const id of assets.spiritAssets.keys()) {
			const resolved = getSpiritAsset(id);
			if (resolved) list.push(resolved);
		}
		list.sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name));
		return list;
	});
	const catalog = $derived(liveCatalog.length > 0 ? liveCatalog : BUNDLED_SPIRIT_CATALOG);
	const usingBundled = $derived(liveCatalog.length === 0);
	const catalogById = $derived(new Map(catalog.map((spirit) => [spirit.id, spirit])));
	const originOptions = $derived.by(() => {
		const byId = new Map<string, { id: string; name: string }>();
		for (const spirit of catalog) {
			for (const origin of spirit.traits.origins)
				byId.set(origin.id, { id: origin.id, name: origin.name });
		}
		const out = [...byId.values()];
		out.sort((a, b) => a.name.localeCompare(b.name));
		return out;
	});
	const filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return catalog.filter((s) => {
			if (q && !s.name.toLowerCase().includes(q)) return false;
			if (originFilter && !s.traits.origins.some((o) => o.id === originFilter)) return false;
			if (sourceFilter !== 'all') {
				const bag = bagForSpiritCost(s.cost);
				if (sourceFilter === 'spiritWorld' && bag !== SPIRIT_WORLD_BAG) return false;
				if (sourceFilter === 'arcaneAbyss' && bag !== ARCANE_ABYSS_BAG) return false;
			}
			return true;
		});
	});

	const placedCount = $derived(board.filter((x) => x != null).length);

	// ── Synthetic player → fed to the game's TraitTracker + HexGrid (right) ────
	// Convert each placed spirit's resolved class/origin lists into the engine's
	// Record<name, count> shape (a spirit carrying a class twice counts twice).
	const boardSpirits = $derived.by((): PlaySpirit[] => {
		const out: PlaySpirit[] = [];
		board.forEach((id, i) => {
			if (!id) return;
			const r = catalogById.get(id);
			if (!r) return;
			const classes: Record<string, number> = {};
			for (const c of r.traits.classes) classes[c.name] = (classes[c.name] ?? 0) + 1;
			const origins: Record<string, number> = {};
			for (const o of r.traits.origins) origins[o.name] = (origins[o.name] ?? 0) + 1;
			out.push({
				slotIndex: i + 1,
				id: r.id,
				name: r.name,
				cost: r.cost,
				classes,
				origins,
				isFaceDown: false
			});
		});
		return out;
	});
	// TraitTracker only reads `player.spirits`, so a spirits-only object is sufficient.
	const traitPlayer = $derived({ spirits: boardSpirits } as unknown as PlayerProjection);
	const spiritImages = $derived.by(() => {
		const m = new Map<string, string>();
		for (const id of board) {
			if (!id || m.has(id)) continue;
			const url = catalogById.get(id)?.imageUrl;
			if (url) m.set(id, url);
		}
		return m;
	});

	// ── Placement (drag from catalog, or tap) + removal (tap a placed hex) ─────
	let dragSpirit = $state<string | null>(null);
	let boardOver = $state(false);

	function startDragCatalog(id: string, e: DragEvent) {
		dragSpirit = id;
		e.dataTransfer?.setData('text/plain', id);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
	}
	function endDrag() {
		dragSpirit = null;
		boardOver = false;
	}
	function onBoardDrop() {
		if (dragSpirit) placeFirstEmpty(dragSpirit);
		endDrag();
	}
	function placeFirstEmpty(id: string) {
		const idx = board.findIndex((x) => x == null);
		if (idx === -1) return; // full
		const next = [...board];
		next[idx] = id;
		board = next;
		playMenuSfx('ui-click');
	}
	function removeBySlot(slotIndex: number) {
		const index = slotIndex - 1;
		if (index < 0 || index >= board.length || board[index] == null) return;
		const next = [...board];
		next[index] = null;
		board = next;
		playMenuSfx('ui-back');
	}
	function clearAll() {
		board = Array(TEAM_SIZE).fill(null);
		playMenuSfx('ui-back');
	}

	const hover = () => playMenuSfx('ui-hover', { volume: 0.45 });
</script>

<svelte:head>
	<title>Composition Builder | Arc Spirits</title>
</svelte:head>

<MenuShell showBrand={false}>
	<div class="builder" data-testid="builder-root" data-restored={restored}>
		<!-- ── Header ──────────────────────────────────────────────── -->
		<header class="bx-head">
			<a class="back" href="/play" onpointerenter={hover} onclick={() => playMenuSfx('ui-back')}>
				<GameIcon name="back" /> Back
			</a>
			<div class="title-block">
				<span class="eyebrow"><GameIcon name="builder" size={15} /> Composition Builder</span>
				<h1>Forge a Team</h1>
			</div>
			<div class="head-tools">
				<input
					class="team-name"
					bind:value={teamName}
					maxlength="40"
					placeholder="Team name"
					spellcheck="false"
					aria-label="Team name"
				/>
				<span class="count" data-testid="builder-team-count" class:full={placedCount === TEAM_SIZE}
					>{placedCount}/{TEAM_SIZE}</span
				>
				<button class="clear" type="button" onpointerenter={hover} onclick={clearAll}
					><GameIcon name="clear" size={16} /> Clear</button
				>
			</div>
		</header>

		<div class="bx-grid">
			<!-- ── Spirit catalog (browsable) ───────────────────────── -->
			<section class="catalog panel" aria-label="All spirits">
				<div class="cat-head">
					<label class="search-shell">
						<GameIcon name="search" size={16} />
						<input
							class="search"
							bind:value={search}
							placeholder="Search spirits…"
							spellcheck="false"
							aria-label="Search spirits"
						/>
					</label>
					<label class="filter-shell">
						<GameIcon name="origin" size={15} />
						<select class="filter" bind:value={originFilter} aria-label="Filter by origin">
							<option value="">All origins</option>
							{#each originOptions as o (o.id)}
								<option value={o.id}>{o.name}</option>
							{/each}
						</select>
					</label>
					<label class="filter-shell">
						<GameIcon name="portal" size={15} />
						<select class="filter" bind:value={sourceFilter} aria-label="Filter by source">
							<option value="all">All sources</option>
							<option value="spiritWorld">Spirit World</option>
							<option value="arcaneAbyss">Arcane Abyss</option>
						</select>
					</label>
				</div>
				{#if usingBundled}
					<div class="roster-note" data-testid="builder-bundled-roster">
						<GameIcon name={loadError ? 'warning' : 'refresh'} size={16} />
						<span
							>{loadError
								? 'Using the bundled roster; live card art is unavailable.'
								: 'Bundled roster ready while live card art syncs.'}</span
						>
						{#if loadError}<button class="retry" type="button" onclick={retryLoad}
								><GameIcon name="refresh" size={14} /> Retry</button
							>{/if}
					</div>
				{/if}
				{#if catalog.length === 0}
					<div class="loading">No spirits found.</div>
				{:else}
					<div class="cat-scroll" data-testid="builder-catalog">
						<div class="cat-grid">
							{#each filtered as spirit (spirit.id)}
								<button
									class="spirit-card"
									type="button"
									draggable="true"
									title={spirit.name}
									ondragstart={(e) => startDragCatalog(spirit.id, e)}
									ondragend={endDrag}
									onclick={() => placeFirstEmpty(spirit.id)}
									onpointerenter={hover}
								>
									{#if spirit.imageUrl}
										<img
											class="card-art"
											src={spirit.imageUrl}
											alt={spirit.name}
											loading="lazy"
											draggable="false"
										/>
									{:else}
										<span class="ph"
											><GameIcon name="spirit" size={28} /><b>{spirit.name}</b><small
												>{spirit.cost} Arc</small
											></span
										>
									{/if}
								</button>
							{/each}
						</div>
					</div>
				{/if}
			</section>

			<!-- ── Synergies: the game's TraitTracker ───────────────── -->
			<aside class="trait-panel" aria-label="Synergies">
				<div class="panel-kicker"><GameIcon name="synergy" size={16} /> Synergies</div>
				<div class="trait-host">
					<TraitTracker player={traitPlayer} {assets} />
				</div>
			</aside>

			<!-- ── Board: the game's seven-hex arrangement ──────────── -->
			<section
				class="board-panel"
				class:drag-over={boardOver}
				aria-label="Team board"
				ondragover={(e) => {
					e.preventDefault();
					boardOver = true;
				}}
				ondragleave={() => (boardOver = false)}
				ondrop={onBoardDrop}
			>
				<div class="panel-kicker"><GameIcon name="board" size={16} /> Formation</div>
				<div class="board-host">
					<HexGrid
						spirits={boardSpirits}
						spiritAssets={spiritImages}
						discardMode
						onDiscard={removeBySlot}
					/>
				</div>
				<p class="board-hint">
					<GameIcon name="info" size={15} /> Drag a spirit onto the board — or tap one to add it. Tap
					a placed spirit to remove it.
				</p>
			</section>
		</div>
	</div>
</MenuShell>

<style>
	.builder {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		padding: 28px 32px 22px;
		gap: 14px;
	}

	/* ── Header ── */
	.bx-head {
		display: flex;
		align-items: center;
		gap: 22px;
		flex-wrap: wrap;
		/* keep the right-side tools clear of the MenuShell mute button (top-right). */
		padding-right: 52px;
	}
	.back {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-display);
		font-size: 0.78rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--color-parchment, #d8cfee);
		text-decoration: none;
		padding: 8px 14px;
		min-height: 44px;
		border: 1px solid var(--color-mist, #2e1d52);
		border-radius: 999px;
		background: rgba(10, 7, 24, 0.5);
		backdrop-filter: blur(8px);
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
		transition:
			border-color 160ms ease,
			color 160ms ease;
	}
	@media (hover: hover) and (pointer: fine) {
		.back:hover {
			border-color: var(--brand-magenta, #ff2bc7);
			color: var(--brand-magenta-soft, #ff5dd1);
		}
	}
	.back:focus-visible {
		border-color: var(--brand-magenta, #ff2bc7);
		color: var(--brand-magenta-soft, #ff5dd1);
		outline: 2px solid var(--brand-magenta, #ff2bc7);
		outline-offset: 2px;
	}
	.title-block {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-right: auto;
	}
	.eyebrow {
		font-family: var(--font-display);
		font-size: 0.68rem;
		letter-spacing: 0.32em;
		text-transform: uppercase;
		color: var(--brand-cyan, #5cdfff);
	}
	.title-block h1 {
		margin: 0;
		font-family: var(--font-display);
		font-size: clamp(1.6rem, 3vw, 2.4rem);
		line-height: 1;
		letter-spacing: 0.02em;
		color: var(--color-bone, #f5f0ff);
	}
	.head-tools {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.team-name {
		background: rgba(10, 7, 24, 0.6);
		border: 1px solid var(--color-mist, #2e1d52);
		border-radius: 8px;
		padding: 9px 14px;
		color: var(--color-bone, #f5f0ff);
		font-family: var(--font-display);
		font-size: 0.95rem;
		letter-spacing: 0.04em;
		min-width: 200px;
	}
	.team-name:focus {
		outline: none;
		border-color: var(--brand-magenta, #ff2bc7);
	}
	.count {
		font-family: var(--font-display);
		font-size: 1.3rem;
		font-variant-numeric: tabular-nums;
		color: var(--color-fog, #9a93b0);
		min-width: 3ch;
		text-align: center;
	}
	.count.full {
		color: var(--brand-amber, #ffba3d);
		text-shadow: 0 0 12px rgba(255, 186, 61, 0.5);
	}
	.clear {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-family: var(--font-display);
		font-size: 0.72rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--color-parchment, #d8cfee);
		background: rgba(10, 7, 24, 0.5);
		border: 1px solid var(--color-mist, #2e1d52);
		border-radius: 999px;
		padding: 9px 16px;
		min-height: 44px;
		cursor: pointer;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
		transition:
			border-color 160ms ease,
			color 160ms ease;
	}
	@media (hover: hover) and (pointer: fine) {
		.clear:hover {
			border-color: var(--brand-magenta, #ff2bc7);
			color: var(--brand-magenta-soft, #ff5dd1);
		}
	}
	.clear:focus-visible {
		border-color: var(--brand-magenta, #ff2bc7);
		color: var(--brand-magenta-soft, #ff5dd1);
		outline: 2px solid var(--brand-magenta, #ff2bc7);
		outline-offset: 2px;
	}

	/* ── 3-column body: catalog | synergies | board ── */
	.bx-grid {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: minmax(300px, 1.1fr) minmax(220px, 280px) minmax(340px, 1.2fr);
		gap: 18px;
	}
	.panel {
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: rgba(8, 5, 18, 0.55);
		border: 1px solid var(--color-mist, #2e1d52);
		border-radius: 14px;
		backdrop-filter: blur(10px);
		overflow: hidden;
	}

	/* ── Catalog ── */
	.cat-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		padding: 12px 14px;
		border-bottom: 1px solid var(--color-mist, #2e1d52);
	}
	.search-shell,
	.filter-shell {
		display: flex;
		align-items: center;
		gap: 7px;
		color: var(--color-fog, #9a93b0);
	}
	.search-shell {
		flex: 1 1 100%;
	}
	.filter-shell {
		flex: 1 1 0;
		min-width: 0;
	}
	.search {
		flex: 1;
		min-width: 0;
		background: rgba(0, 0, 0, 0.35);
		border: 1px solid var(--color-mist, #2e1d52);
		border-radius: 8px;
		padding: 8px 12px;
		color: var(--color-bone, #f5f0ff);
		font-size: 0.88rem;
	}
	.search:focus {
		outline: none;
		border-color: var(--brand-cyan, #5cdfff);
	}
	.filter {
		flex: 1;
		min-width: 0;
		background: rgba(0, 0, 0, 0.35);
		border: 1px solid var(--color-mist, #2e1d52);
		border-radius: 8px;
		padding: 7px 10px;
		color: var(--color-bone, #f5f0ff);
		font-size: 0.82rem;
		cursor: pointer;
	}
	.filter:focus {
		outline: none;
		border-color: var(--brand-cyan, #5cdfff);
	}
	.filter option {
		background: var(--color-void, #0c0518);
		color: var(--color-bone, #f5f0ff);
	}
	.roster-note {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 14px;
		border-bottom: 1px solid var(--color-mist, #2e1d52);
		color: var(--color-fog, #9a93b0);
		font-size: 0.72rem;
		line-height: 1.3;
	}
	.roster-note span {
		flex: 1;
	}
	.loading {
		padding: 40px 16px;
		text-align: center;
		color: var(--color-fog, #9a93b0);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
	}
	.retry {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-display);
		font-size: 0.72rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--color-bone, #f5f0ff);
		background: rgba(255, 43, 199, 0.15);
		border: 1px solid var(--brand-magenta, #ff2bc7);
		border-radius: 999px;
		padding: 8px 18px;
		cursor: pointer;
	}
	@media (hover: hover) and (pointer: fine) {
		.retry:hover {
			background: rgba(255, 43, 199, 0.3);
		}
	}
	.cat-scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 14px;
		scrollbar-width: thin;
		scrollbar-color: var(--brand-magenta, #ff2bc7) transparent;
	}
	.cat-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 12px;
	}
	/* No card box behind each spirit — just the print art on the background. */
	.spirit-card {
		position: relative;
		padding: 0;
		background: transparent;
		border: 0;
		outline: none;
		border-radius: 8px;
		overflow: hidden;
		cursor: grab;
		color: inherit;
		line-height: 0;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
		transition:
			transform 160ms ease,
			filter 160ms ease;
	}
	.spirit-card:focus {
		outline: none;
	}
	.spirit-card:focus-visible {
		outline: 2px solid var(--brand-cyan, #5cdfff);
		outline-offset: 2px;
	}
	.spirit-card:active {
		cursor: grabbing;
	}
	@media (hover: hover) and (pointer: fine) {
		.spirit-card:hover {
			transform: translateY(-2px) scale(1.03);
			filter: drop-shadow(0 6px 16px rgba(255, 43, 199, 0.35));
		}
	}
	/* The print art already carries the spirit's name, cost and trait icons —
	   show it whole (no crop, no overlays). */
	.card-art {
		width: 100%;
		height: auto;
		display: block;
	}
	.ph {
		display: grid;
		place-items: center;
		align-content: center;
		gap: 8px;
		aspect-ratio: 3 / 4;
		font-family: var(--font-display);
		font-size: 0.9rem;
		line-height: 1.2;
		text-align: center;
		padding: 12px;
		color: var(--color-fog, #9a93b0);
		background:
			radial-gradient(circle at 50% 35%, rgba(92, 223, 255, 0.12), transparent 35%),
			linear-gradient(160deg, rgba(123, 29, 255, 0.13), rgba(8, 5, 18, 0.8));
		border: 1px solid var(--color-mist, #2e1d52);
		border-radius: 8px;
		line-height: 1.1;
	}
	.ph b {
		font-size: 0.82rem;
		line-height: 1.15;
		color: var(--color-bone, #f5f0ff);
	}
	.ph small {
		font-family: var(--font-body);
		font-size: 0.68rem;
		color: var(--brand-cyan, #5cdfff);
	}

	/* ── Synergies (TraitTracker host) — sits on the background, no panel box ── */
	.trait-panel {
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	.panel-kicker {
		display: flex;
		align-items: center;
		gap: 7px;
		align-self: stretch;
		padding: 8px 10px;
		font-family: var(--font-display);
		font-size: 0.66rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--brand-cyan, #5cdfff);
	}
	.trait-host {
		flex: 1;
		min-height: 0;
		display: flex;
	}
	/* TraitTracker fills its host (it manages its own internal scroll + zoom). */
	.trait-host :global(.traits) {
		width: 100%;
	}

	/* ── Board (HexGrid host) ── */
	.board-panel {
		display: flex;
		flex-direction: column;
		min-height: 0;
		align-items: center;
		justify-content: center;
		padding: 18px;
		gap: 14px;
		border-radius: 14px;
		transition: box-shadow 140ms ease;
	}
	.board-panel.drag-over {
		box-shadow: inset 0 0 50px rgba(92, 223, 255, 0.18);
	}
	.board-host {
		flex: 1;
		min-height: 0;
		width: 100%;
		display: grid;
		place-items: center;
	}
	.board-host :global(.hex-grid) {
		width: 100%;
		height: 100%;
		max-height: 62vh;
	}
	.board-hint {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		margin: 0;
		font-size: 0.78rem;
		color: var(--color-fog, #9a93b0);
		text-align: center;
		max-width: 38ch;
	}

	/* ── Responsive ── */
	@media (max-width: 1080px) {
		.bx-grid {
			grid-template-columns: 1fr 1fr;
			grid-template-rows: auto auto;
		}
		.board-panel {
			grid-column: 1 / -1;
			grid-row: 1;
			min-height: 320px;
		}
		.catalog {
			grid-column: 1;
			grid-row: 2;
		}
		.trait-panel {
			grid-column: 2;
			grid-row: 2;
		}
	}
	@media (max-width: 680px) {
		.builder {
			padding: 24px 16px 18px;
		}
		.bx-grid {
			grid-template-columns: 1fr;
			grid-template-rows: none;
		}
		.board-panel,
		.catalog,
		.trait-panel {
			grid-column: 1;
		}
		.title-block {
			margin-right: 0;
		}
	}

	@media (max-width: 430px) {
		.builder {
			padding: 16px 10px 12px;
			padding-bottom: calc(12px + env(safe-area-inset-bottom));
			gap: 10px;
		}
		.bx-head {
			gap: 10px;
			padding-right: 48px; /* keep clear of mute button */
		}
		.head-tools {
			flex-wrap: wrap;
			gap: 8px;
		}
		.team-name {
			min-width: 0;
			width: 100%;
		}
		.title-block h1 {
			font-size: clamp(1.3rem, 6vw, 1.6rem);
		}
		.cat-grid {
			grid-template-columns: repeat(2, 1fr);
			gap: 8px;
		}
		.board-host :global(.hex-grid) {
			max-height: 48vh;
			max-height: 48dvh;
		}
		.board-hint {
			font-size: 0.7rem;
		}
		.filter {
			font-size: 0.76rem;
			padding: 6px 8px;
		}
	}

	/* Builder as a drafting table of cut shapes, not dashboard panels. */
	.builder {
		position: relative;
		background: rgba(5, 3, 16, 0.45);
		overflow: hidden;
	}
	.builder::before {
		content: '';
		position: absolute;
		right: -12vw;
		top: 16vh;
		width: 56vw;
		height: 32vh;
		background: #087b91;
		opacity: 0.12;
		clip-path: polygon(18% 0, 100% 28%, 78% 100%, 0 70%);
		pointer-events: none;
	}
	.bx-head,
	.bx-grid {
		position: relative;
		z-index: 1;
	}
	.back,
	.clear,
	.retry {
		border: 0;
		border-radius: 0;
		background: #28115b;
		backdrop-filter: none;
		clip-path: polygon(0 0, 90% 0, 100% 50%, 90% 100%, 0 100%);
	}
	.back:hover,
	.clear:hover,
	.retry:hover {
		background: #24d4ff;
		color: #080311;
	}
	.title-block h1 {
		font-size: clamp(2.1rem, 4.6vw, 4.4rem);
		text-transform: uppercase;
		text-shadow: none;
	}
	.team-name,
	.search,
	.filter {
		border: 0;
		border-bottom: 3px solid #24d4ff;
		border-radius: 0;
		background: #100824;
	}
	.panel {
		border: 0;
		border-radius: 0;
		background: #100725;
		backdrop-filter: none;
		clip-path: polygon(0 0, 96% 0, 100% 5%, 100% 100%, 0 100%);
	}
	.cat-head {
		border: 0;
		background: #43178f;
		clip-path: polygon(0 0, 100% 0, 95% 100%, 0 100%);
	}
	.roster-note {
		border: 0;
		background: #1a0c3d;
	}
	.spirit-card {
		border-radius: 0;
		background: #2f1464;
		clip-path: polygon(18% 0, 82% 0, 100% 14%, 91% 100%, 9% 100%, 0 14%);
	}
	.spirit-card:hover {
		transform: none;
		filter: brightness(1.16);
	}
	.card-art {
		clip-path: inherit;
	}
	.ph {
		border: 0;
		border-radius: 0;
		background: #2f1464;
		clip-path: inherit;
	}
	.trait-panel {
		background: transparent;
		clip-path: none;
	}
	.panel-kicker {
		background: #d515aa;
		color: #fff;
		clip-path: polygon(0 0, 94% 0, 100% 50%, 94% 100%, 0 100%);
	}
	.board-panel {
		border-radius: 0;
		background: transparent;
		clip-path: none;
	}
</style>

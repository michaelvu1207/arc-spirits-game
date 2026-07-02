<script lang="ts">
	import type { getAssetState } from '$lib/stores/assetStore.svelte';
	import type { PlayerProjection } from '$lib/play/types';
	import type { ClassTrait, ClassBreakpoint, EffectEntry } from '$lib/types';
	import { augmentContributions } from '$lib/play/augments';
	import { storageUrl } from './helpers';

	interface Props {
		player: PlayerProjection | null;
		assets: ReturnType<typeof getAssetState>;
	}

	let { player, assets }: Props = $props();

	// Highlight palette.
	const SPECIAL_ORANGE = '#ff9636';
	const COMMON_GRAY = '#6b7280';
	const COMMON_GOLD = '#ffce45';

	const classByName = $derived.by(() => {
		const map = new Map<string, ClassTrait>();
		for (const cls of assets.classTraits.values()) map.set(cls.name, cls);
		return map;
	});
	function classThresholds(asset: ClassTrait | undefined): number[] {
		const raw = asset?.effect_schema ?? [];
		const nums = raw
			.map((b) => (typeof b.count === 'number' ? b.count : Number.parseInt(String(b.count), 10)))
			.filter((n) => Number.isFinite(n) && n > 0);
		return Array.from(new Set(nums)).sort((a, b) => a - b);
	}
	// Special classes (the "special" and "human" class_types) are always single-breakpoint.
	function isSpecialClass(asset: ClassTrait | undefined): boolean {
		return (
			asset?.is_special === true || asset?.class_type === 'special' || asset?.class_type === 'human'
		);
	}

	// Gray → gold ramp for common classes based on how many breakpoints are met.
	function commonColor(thresholds: number[], count: number): string {
		if (thresholds.length === 0) return COMMON_GRAY;
		const met = thresholds.filter((t) => t <= count).length;
		const pct = Math.round((met / thresholds.length) * 100);
		return `color-mix(in srgb, ${COMMON_GOLD} ${pct}%, ${COMMON_GRAY})`;
	}

	// ── Detail-popup helpers (mirrors the Classes & Origins codex page) ──────
	function bpColorClass(color?: string): string {
		return `bp-${color ?? 'bronze'}`;
	}
	function bpDescription(bp: ClassBreakpoint): string {
		const parts: string[] = [];
		for (const e of (bp.effects ?? []) as EffectEntry[]) {
			const d = (e?.description ?? '').trim();
			if (d) parts.push(d);
		}
		if (parts.length > 0) return parts.join(' ');
		return (bp.description ?? '').trim();
	}

	type DetailBp = { key: string; count: number | string; colorClass: string; desc: string };

	function classDetailBps(asset: ClassTrait | undefined): DetailBp[] {
		const list = (asset?.effect_schema ?? []) as ClassBreakpoint[];
		return list
			.slice()
			.sort((a, b) => {
				const an = typeof a.count === 'number' ? a.count : Number(a.count) || 99;
				const bn = typeof b.count === 'number' ? b.count : Number(b.count) || 99;
				return an - bn;
			})
			.map((bp, i) => ({
				key: `${i}:${String(bp.count)}:${bp.color ?? ''}`,
				count: bp.count,
				colorClass: bpColorClass(bp.color),
				desc: bpDescription(bp)
			}));
	}
	type TraitRow = {
		key: string;
		name: string;
		count: number;
		icon: string | null;
		color: string;
		thresholds: number[]; // shown as pips (common classes only)
		kindLabel: string;
		description: string | null;
		footer: string | null;
		detailBps: DetailBp[];
		/** Dormant (carried by a face-down spirit) — rendered dimmed with a "+" badge. */
		dormant?: boolean;
		/** For dormant class rows: the count this trait would reach once awakened. */
		projected?: number;
	};

	type Groups = {
		// Active right now: class traits from awakened spirits.
		awakened: { specials: TraitRow[]; commons: TraitRow[] };
		// Dormant: class traits carried by face-down spirits, surfaced so the player
		// can see what awakening will unlock.
		unawakened: { specials: TraitRow[]; commons: TraitRow[] };
	};

	const groups = $derived.by((): Groups => {
		const awakened = { specials: [] as TraitRow[], commons: [] as TraitRow[] };
		const unawakened = { specials: [] as TraitRow[], commons: [] as TraitRow[] };
		if (!player) return { awakened, unawakened };

		// Class counts split by awakening state: awakened spirits contribute active
		// traits; face-down spirits' classes are dormant until they awaken.
		const awakeCounts: Record<string, number> = {};
		const dormantCounts: Record<string, number> = {};
		for (const spirit of player.spirits) {
			const bucket = spirit.isFaceDown ? dormantCounts : awakeCounts;
			for (const [cls, n] of Object.entries(spirit.classes ?? {})) {
				bucket[cls] = (bucket[cls] ?? 0) + (typeof n === 'number' ? n : 1);
			}
		}
		// Placed spirit augments add their class too, following the host spirit's
		// awaken state (active when face-up, dormant when face-down).
		for (const { className, awake } of augmentContributions(player)) {
			const bucket = awake ? awakeCounts : dormantCounts;
			bucket[className] = (bucket[className] ?? 0) + 1;
		}

		function pushClass(
			name: string,
			count: number,
			specials: TraitRow[],
			commons: TraitRow[],
			dormant: boolean
		) {
			const asset = classByName.get(name);
			const detailBps = classDetailBps(asset);
			// Only surface a projected total when awakening would ADD to an already
			// active count; otherwise the dimmed band + "+N" badge already says it all.
			const activeNow = awakeCounts[name] ?? 0;
			const projected = dormant && activeNow > 0 ? count + activeNow : undefined;
			const base = {
				name,
				count,
				icon: storageUrl(asset?.icon_png ?? null),
				description: asset?.description ?? null,
				footer: asset?.footer ?? null,
				detailBps,
				dormant,
				projected
			};
			if (isSpecialClass(asset)) {
				specials.push({
					...base,
					key: `${dormant ? 'ds' : 's'}:${name}`,
					color: SPECIAL_ORANGE,
					thresholds: [],
					kindLabel: 'Special'
				});
			} else {
				const thresholds = classThresholds(asset);
				commons.push({
					...base,
					key: `${dormant ? 'dc' : 'c'}:${name}`,
					color: dormant ? COMMON_GRAY : commonColor(thresholds, count),
					thresholds,
					kindLabel: 'Common'
				});
			}
		}

		for (const [name, count] of Object.entries(awakeCounts)) {
			pushClass(name, count, awakened.specials, awakened.commons, false);
		}
		for (const [name, count] of Object.entries(dormantCounts)) {
			pushClass(name, count, unawakened.specials, unawakened.commons, true);
		}

		const byCount = (a: TraitRow, b: TraitRow) => b.count - a.count || a.name.localeCompare(b.name);
		awakened.specials.sort(byCount);
		awakened.commons.sort(byCount);
		unawakened.specials.sort(byCount);
		unawakened.commons.sort(byCount);
		return { awakened, unawakened };
	});

	const hasAwakened = $derived(
		groups.awakened.specials.length > 0 || groups.awakened.commons.length > 0
	);
	const hasUnawakened = $derived(
		groups.unawakened.specials.length > 0 || groups.unawakened.commons.length > 0
	);
	const isEmpty = $derived(!hasAwakened && !hasUnawakened);

	// ── Hover/tap detail popup ───────────────────────────────────────────────
	let detail = $state<TraitRow | null>(null);
	let anchor = $state<DOMRect | null>(null);
	let tipEl = $state<HTMLDivElement | null>(null);
	let tipPos = $state({ left: 0, top: 0 });
	let placed = $state(false);
	// Touch devices use the same floating detail surface as desktop, opened by tap
	// instead of hover. Keeping details out of the list prevents the HUD from resizing.
	let isCoarse = $state(false);
	$effect(() => {
		if (typeof window === 'undefined') return;
		const mq = window.matchMedia('(pointer: coarse)');
		const sync = () => (isCoarse = mq.matches);
		sync();
		mq.addEventListener('change', sync);
		return () => mq.removeEventListener('change', sync);
	});

	function showTip(event: MouseEvent | PointerEvent, row: TraitRow) {
		anchor = (event.currentTarget as HTMLElement).getBoundingClientRect();
		detail = row;
		placed = false;
	}
	function hideTip() {
		detail = null;
		anchor = null;
		placed = false;
	}
	// Touch: tap toggles the floating detail card. Fine pointers use hover instead.
	function handleTap(event: MouseEvent | PointerEvent, row: TraitRow) {
		if (!isCoarse) return; // fine-pointer handled by onpointerenter/leave
		event.stopPropagation();
		if (detail?.key === row.key) hideTip();
		else showTip(event, row);
	}
	// Keyboard Enter/Space: toggle the floating detail on every pointer mode.
	function handleKey(event: KeyboardEvent, row: TraitRow) {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		if (detail?.key === row.key) {
			hideTip();
		} else {
			showTip(event as unknown as MouseEvent, row);
		}
	}

	// Move the popup to <body> so it escapes the float's clipping / transformed
	// containing block, letting position:fixed resolve against the viewport.
	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return {
			destroy() {
				node.remove();
			}
		};
	}

	$effect(() => {
		if (!detail || !anchor || !tipEl) return;
		const gap = 12;
		const margin = 8;
		const tw = tipEl.offsetWidth;
		const th = tipEl.offsetHeight;
		let left = anchor.right + gap;
		if (left + tw > window.innerWidth - margin) {
			left = anchor.left - tw - gap; // flip to the left if it would overflow
		}
		let top = anchor.top + anchor.height / 2 - th / 2; // vertically center on the row
		if (isCoarse && window.innerWidth > window.innerHeight) {
			// On phone landscape, keep the card over the stage side of the HUD and
			// aligned with the tapped row instead of growing the trait list inline.
			left = Math.max(anchor.right + gap, margin);
			if (left + tw > window.innerWidth - margin) left = window.innerWidth - tw - margin;
			top = anchor.top;
		}
		top = Math.max(margin, Math.min(top, window.innerHeight - th - margin));
		tipPos = { left, top };
		placed = true;
	});
</script>

{#snippet traitRow(row: TraitRow, showPips: boolean)}
	{@const expanded = isCoarse && detail?.key === row.key}
	<div
		class="trait"
		class:expanded
		style="--c: {row.color}"
		role="button"
		tabindex="0"
		aria-expanded={isCoarse ? expanded : undefined}
		aria-label={row.dormant
			? `${row.name}, ${row.count} dormant${row.projected != null ? `, reaches ${row.projected} once awakened` : ', activates once awakened'}`
			: `${row.name}, ${row.count}`}
		onpointerenter={(e) => {
			if (!isCoarse) showTip(e, row);
		}}
		onpointerleave={() => {
			if (!isCoarse) hideTip();
		}}
		onclick={(e) => handleTap(e, row)}
		onkeydown={(e) => handleKey(e, row)}
		onfocus={(e) => {
			if (!isCoarse) showTip(e as unknown as MouseEvent, row);
		}}
		onblur={() => {
			if (!isCoarse) hideTip();
		}}
	>
		<div class="emblem">
			{#if row.icon}
				<img src={row.icon} alt={row.name} loading="lazy" />
			{:else}
				<span>{row.name.slice(0, 1)}</span>
			{/if}
			<span class="count">{row.dormant ? '+' : ''}{row.count}</span>
		</div>
		<div class="body">
			<span class="name">{row.name}</span>
			{#if row.dormant && row.projected != null}
				<span class="projected" title="Reaches {row.projected} once awakened"
					>→ {row.projected}</span
				>
			{:else if showPips && row.thresholds.length > 0}
				<div class="pips">
					{#each row.thresholds as t (t)}
						<span class="pip" class:hit={row.count >= t}>{t}</span>
					{/each}
				</div>
			{/if}
		</div>
		<!-- Touch affordance: a chevron that rotates when the floating detail is open. -->
		{#if isCoarse}
			<span class="chev" aria-hidden="true">▸</span>
		{/if}
	</div>
{/snippet}

{#snippet section(rows: TraitRow[], showPips: boolean)}
	{#if rows.length > 0}
		<section class="group">
			<div class="list">
				{#each rows as row (row.key)}
					{@render traitRow(row, showPips)}
				{/each}
			</div>
		</section>
	{/if}
{/snippet}

<aside class="traits">
	{#if isEmpty}
		<div class="empty">Summon spirits to build traits.</div>
	{:else}
		{#if hasAwakened}
			<div class="state awakened">
				<span class="state-label">Awakened</span>
				{@render section(groups.awakened.specials, false)}
				{@render section(groups.awakened.commons, true)}
			</div>
		{/if}

		{#if hasUnawakened}
			<div class="state unawakened">
				<span class="state-label">Unawakened</span>
				{@render section(groups.unawakened.specials, false)}
				{@render section(groups.unawakened.commons, false)}
			</div>
		{/if}
	{/if}
</aside>

{#if detail}
	{#if isCoarse}
		<button
			type="button"
			class="tip-backdrop"
			aria-label="Close trait details"
			use:portal
			onclick={hideTip}
		></button>
	{/if}
	<div
		class="tip"
		class:placed
		class:touch={isCoarse}
		use:portal
		bind:this={tipEl}
		style="left: {tipPos.left}px; top: {tipPos.top}px;"
		style:--c={detail.color}
	>
		<header class="tip-head">
			<div class="tip-emblem">
				{#if detail.icon}
					<img src={detail.icon} alt={detail.name} />
				{:else}
					<span>{detail.name.slice(0, 1)}</span>
				{/if}
			</div>
			<div class="tip-title">
				<span class="tip-name">{detail.name}</span>
				<span class="tip-kind">{detail.kindLabel}</span>
			</div>
			{#if isCoarse}
				<button type="button" class="tip-close" aria-label="Close trait details" onclick={hideTip}
					>×</button
				>
			{/if}
		</header>

		{#if detail.description}
			<p class="tip-desc">{detail.description}</p>
		{/if}

		{#if detail.detailBps.length > 0}
			<div class="bp-list">
				{#each detail.detailBps as bp (bp.key)}
					<div class="bp-row">
						<span class="bp-count {bp.colorClass}">{bp.count}</span>
						{#if bp.desc}<div class="bp-desc">{bp.desc}</div>{/if}
					</div>
				{/each}
			</div>
		{/if}

		{#if detail.footer}
			<p class="tip-footer">{detail.footer}</p>
		{/if}
	</div>
{/if}

<style>
	.traits {
		/* Render the trait list at full size. (Previously shrunk with zoom: 0.53,
		   which made every label read ~half-size — far too small.) The column it
		   lives in is fixed-width and scrolls, so full-size content just scrolls. */
		display: flex;
		flex-direction: column;
		min-height: 0;
		height: 100%;
		overflow-y: auto;
		scrollbar-width: none; /* hide the styled magenta scrollbar (parity with the leaderboard) */
		padding: 0.5rem 0.75rem 0.75rem;
		gap: var(--trait-section-gap, 0.85rem);
	}
	.traits::-webkit-scrollbar {
		width: 0;
		height: 0;
	}
	/* Awakened (active) vs Unawakened (dormant) bands. */
	.state {
		display: flex;
		flex-direction: column;
		gap: var(--trait-section-gap, 0.85rem);
	}
	.state-label {
		font-family: var(--font-display);
		font-size: var(--trait-state-size, 1.18rem);
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: #fff;
		padding-bottom: 3px;
		border-bottom: 1px solid color-mix(in srgb, var(--brand-cyan, #5cdfff) 35%, transparent);
	}
	.state.unawakened {
		margin-top: 0.35rem;
		padding-top: var(--trait-section-gap, 0.85rem);
		border-top: 1px dashed rgba(255, 255, 255, 0.16);
		opacity: 0.74;
	}
	.state.unawakened .state-label {
		color: var(--color-fog, #9a93b0);
		border-bottom-color: rgba(255, 255, 255, 0.14);
	}
	/* Dim & desaturate dormant emblems so they read as "not yet active". */
	.state.unawakened .emblem img {
		/* White silhouette, but faded to read as dormant. */
		filter: brightness(0) invert(1);
		opacity: 0.4;
	}
	.group {
		display: flex;
		flex-direction: column;
		gap: var(--trait-list-gap, 6px);
	}
	.list {
		display: flex;
		flex-direction: column;
		gap: var(--trait-list-gap, 6px);
	}
	.empty {
		color: var(--color-whisper, #6a6680);
		font-size: 1.17rem;
		padding: 0.75rem;
	}
	.trait {
		display: flex;
		align-items: center;
		gap: var(--trait-gap, 0.82rem);
		padding: var(--trait-row-pad, 8px 9px);
		border-radius: 6px;
		background: color-mix(in srgb, var(--c) 14%, transparent);
		border-left: 4px solid var(--c);
		/* Re-enable hit testing (the float container is click-through). */
		pointer-events: auto;
		cursor: default;
	}
	.trait:focus-visible {
		outline: 2px solid var(--c);
		outline-offset: 2px;
	}
	.emblem {
		position: relative;
		width: var(--trait-icon, 45px);
		height: var(--trait-icon, 45px);
		flex-shrink: 0;
		display: grid;
		place-items: center;
		border-radius: 9px;
		background: rgba(0, 0, 0, 0.35);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 50%, transparent);
	}
	.emblem img {
		width: calc(var(--trait-icon, 45px) * 0.73);
		height: calc(var(--trait-icon, 45px) * 0.73);
		object-fit: contain;
		/* Class icons read as a flat white silhouette. */
		filter: brightness(0) invert(1);
	}
	.emblem span:not(.count) {
		font-family: var(--font-display);
		color: var(--c);
	}
	.count {
		position: absolute;
		right: -6px;
		bottom: -6px;
		min-width: var(--trait-count-size, 22px);
		height: var(--trait-count-size, 22px);
		padding: 0 4px;
		border-radius: 12px;
		background: var(--c);
		color: var(--color-void, #0c0518);
		font-family: var(--font-display);
		font-size: var(--trait-count-font, 0.93rem);
		display: grid;
		place-items: center;
		font-variant-numeric: tabular-nums;
	}
	.body {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.name {
		font-family: var(--font-display);
		font-size: var(--trait-name-size, 1.17rem);
		letter-spacing: 0.03em;
		text-transform: uppercase;
		color: #fff;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.projected {
		font-family: var(--font-display);
		font-size: 0.92rem;
		letter-spacing: 0.04em;
		color: var(--brand-cyan, #5cdfff);
		opacity: 0.9;
	}
	.pips {
		display: flex;
		gap: 4px;
	}
	.pip {
		font-size: var(--trait-pip-font, 0.84rem);
		min-width: var(--trait-pip-size, 20px);
		height: var(--trait-pip-size, 20px);
		padding: 0 3px;
		display: grid;
		place-items: center;
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.06);
		color: var(--color-whisper, #6a6680);
		font-variant-numeric: tabular-nums;
	}
	.pip.hit {
		background: color-mix(in srgb, var(--c) 35%, transparent);
		color: #fff;
	}

	/* ── Detail popup (portaled to <body>) ───────────────────────────────── */
	.tip-backdrop {
		position: fixed;
		inset: 0;
		z-index: 999;
		padding: 0;
		border: 0;
		background: transparent;
		touch-action: none;
		-webkit-tap-highlight-color: transparent;
	}
	.tip {
		position: fixed;
		z-index: 1000;
		width: 320px;
		max-height: 82vh;
		overflow-y: auto;
		padding: 14px;
		border-radius: 10px;
		background: rgba(10, 6, 20, 0.97);
		border: 1px solid color-mix(in srgb, var(--c) 60%, transparent);
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
		backdrop-filter: blur(10px);
		pointer-events: none;
		opacity: 0;
		transition: opacity 90ms ease;
	}
	.tip.touch {
		width: min(420px, calc(100vw - 200px));
		max-height: calc(100dvh - 16px);
		pointer-events: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
	}
	.tip.placed {
		opacity: 1;
	}
	.tip-head {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 10px;
	}
	.tip-emblem {
		position: relative;
		width: 44px;
		height: 44px;
		flex-shrink: 0;
		display: grid;
		place-items: center;
		border-radius: 8px;
		background: rgba(0, 0, 0, 0.4);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 55%, transparent);
	}
	.tip-emblem img {
		width: 34px;
		height: 34px;
		object-fit: contain;
		filter: brightness(0) invert(1);
	}
	.tip-emblem span {
		font-family: var(--font-display);
		color: var(--c);
	}
	.tip-title {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		flex: 1 1 auto;
	}
	.tip-name {
		font-family: var(--font-display);
		font-size: 1.15rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: #fff;
	}
	.tip-kind {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: var(--c);
	}
	.tip-close {
		flex: 0 0 auto;
		display: grid;
		place-items: center;
		width: 34px;
		height: 34px;
		margin-left: auto;
		border: 1px solid color-mix(in srgb, var(--c) 40%, transparent);
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.06);
		color: #fff;
		font: inherit;
		font-family: var(--font-display);
		font-size: 1.05rem;
		line-height: 1;
		cursor: pointer;
		touch-action: manipulation;
	}
	.tip-desc {
		font-size: 0.9rem;
		line-height: 1.5;
		color: var(--color-parchment, #d8d2e8);
		margin: 0 0 12px;
	}
	.bp-list {
		display: flex;
		flex-direction: column;
		gap: 9px;
		margin-bottom: 10px;
	}
	.bp-row {
		display: grid;
		grid-template-columns: 32px 1fr;
		gap: 12px;
		align-items: flex-start;
	}
	.bp-count {
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		font-family: var(--font-display);
		font-size: 0.9rem;
		color: var(--color-void, #0c0518);
		font-variant-numeric: tabular-nums;
		clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
		flex: none;
	}
	.bp-bronze {
		background: linear-gradient(135deg, #c08560, #8b5a3c);
		color: #fff;
	}
	.bp-silver {
		background: linear-gradient(135deg, #e6e6f0, #9090a0);
		color: #1a0f2e;
	}
	.bp-gold {
		background: linear-gradient(135deg, #ffd56a, #c89028);
		color: #1a0f2e;
	}
	.bp-prismatic {
		background: linear-gradient(135deg, #ff7fd9, #5a2bff, #5cdfff);
		color: #fff;
	}
	.bp-desc {
		font-size: 0.84rem;
		line-height: 1.5;
		color: var(--color-bone, #efeaf7);
		padding-top: 4px;
	}
	.tip-footer {
		font-style: italic;
		font-size: 0.8rem;
		line-height: 1.45;
		color: var(--color-fog, #9a93b0);
		margin: 0;
	}

	/* ── Touch hardening & mobile font-size floor ───────────────────────────── */
	.trait {
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
	}

	/* On touch: make tapped row visually active (since hover doesn't stick). */
	@media (pointer: coarse) {
		.trait:active {
			background: color-mix(in srgb, var(--c) 22%, transparent);
		}
		/* Enlarge emblem hit area to ≥44px (it's already 45px, but add padding for safety). */
		.trait {
			min-height: 44px;
			cursor: pointer;
		}
	}

	/* ── Touch affordance for the floating detail card ─────────────────────── */
	.chev {
		margin-left: auto;
		flex-shrink: 0;
		align-self: center;
		color: var(--c);
		font-size: 0.9rem;
		opacity: 0.65;
		transition:
			transform 160ms ease,
			opacity 160ms ease;
	}
	.trait.expanded .chev {
		transform: rotate(90deg);
		opacity: 1;
	}
	/* The row reads as selected while its floating detail card is open. */
	.trait.expanded {
		background: color-mix(in srgb, var(--c) 22%, transparent);
	}

	/* Raise clamp() minimums so text is readable at 360px. */
	@media (max-width: 600px) {
		.state-label {
			font-size: clamp(0.9rem, 3.5vw, 1.18rem);
		}
		.name {
			font-size: clamp(0.85rem, 3.2vw, 1.17rem);
		}
		.projected {
			font-size: clamp(0.8rem, 2.8vw, 0.92rem);
		}
		.tip.touch {
			width: min(420px, calc(100vw - 190px));
		}
	}
	@media (pointer: coarse) and (orientation: portrait) {
		.tip.touch {
			left: 8px !important;
			top: auto !important;
			right: 8px;
			bottom: calc(8px + env(safe-area-inset-bottom, 0px));
			width: auto;
			max-height: min(58vh, 420px);
		}
	}
</style>

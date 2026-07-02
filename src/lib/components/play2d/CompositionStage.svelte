<script lang="ts">
	import type { getAssetState } from '$lib/stores/assetStore.svelte';
	import type {
		DiceTier,
		PlayerProjection,
		PrivatePlayerState,
		SeatColor,
		SpectatorProjection
	} from '$lib/play/types';
	import { DICE_TIER_ORDER, MAX_ATTACK_DICE, STATUS_LADDER } from '$lib/play/types';
	import type { ClassTrait } from '$lib/types';
	import { seatAccent, statusAccent, storageUrl, spiritBackImageUrl, augmentIconForClass } from './helpers';
	import { WILDCARD_MAT_IDS } from '$lib/play/awakenConditions';
	import { expectedAttack } from '$lib/play/combat';
	import HexGrid from '$lib/components/HexGrid.svelte';

	interface Props {
		room: SpectatorProjection;
		viewedSeat: SeatColor;
		mySeat: SeatColor | null;
		assets: ReturnType<typeof getAssetState>;
		spiritImages?: Map<string, string>;
		/** Discard one of YOUR spirits back to its bag (own seat only). */
		onDiscardSpirit?: (slotIndex: number) => void;
		/** Permanently attach one of YOUR unplaced augments onto a spirit (own seat only). */
		onPlaceAugment?: (augmentIndex: number, augmentRuneId: string, spiritSlotIndex: number) => void;
		busy?: boolean;
	}

	let {
		room,
		viewedSeat,
		mySeat,
		assets,
		spiritImages = new Map(),
		onDiscardSpirit,
		onPlaceAugment,
		busy = false
	}: Props = $props();

	const player = $derived<PlayerProjection | null>(room.players[viewedSeat] ?? null);
	const accent = $derived(seatAccent(viewedSeat));
	const isMe = $derived(viewedSeat === mySeat);

	// Player-level readouts surfaced in the profile header: corruption status (token name,
	// falling back to the ladder label) and the combat initiative accrued this fight.
	const statusLabel = $derived(player?.statusToken ?? STATUS_LADDER[player?.statusLevel ?? 0] ?? 'Pure');
	const statusColor = $derived(statusAccent(statusLabel));
	const initiative = $derived(Math.max(0, player?.initiative ?? 0));

	// ── Combat readout ──────────────────────────────────────────────────────────
	// The scouted player's attack-dice pool and the expected total damage of a roll —
	// dice-tier averages + the flat Spirit Animal bonus (see expectedAttack). Shared
	// with the leaderboard so the two readouts always show the same number.
	const attackDice = $derived(player?.attackDice ?? []);
	const avgAttack = $derived(player ? expectedAttack(player as unknown as PrivatePlayerState) : 0);

	// The four attack tiers map 1:1 to the "… Attack" custom dice, so we borrow each
	// die's rendered art for the pool row. Matched by name — the engine's dice are
	// tiers, not custom_dice ids, so there's no foreign key to follow.
	const TIER_DIE_NAME: Record<DiceTier, string> = {
		basic: 'Basic Attack',
		enchanted: 'Enchanted Attack',
		exalted: 'Exalted Attack',
		arcane: 'Arcane Attack'
	};
	const TIER_LABEL: Record<DiceTier, string> = {
		basic: 'Basic',
		enchanted: 'Enchanted',
		exalted: 'Exalted',
		arcane: 'Arcane'
	};
	function tierDieImage(tier: DiceTier): string | null {
		const want = TIER_DIE_NAME[tier].toLowerCase();
		for (const die of assets.customDiceAssets.values()) {
			if (die.name.toLowerCase() !== want) continue;
			const firstFace = die.sides
				?.slice()
				.sort((a, b) => a.side_number - b.side_number)[0];
			return storageUrl(
				firstFace?.image_path ?? die.background_image_path ?? die.exported_template_path
			);
		}
		return null;
	}
	// Every attack die as its OWN icon (no ×N grouping), sorted weakest → strongest.
	// The pool is engine-capped at 10. Drives the compact dice grid in the bottom bar.
	const diceList = $derived.by(() => {
		const rank = (t: DiceTier) => DICE_TIER_ORDER.indexOf(t);
		return attackDice
			.map((die) => ({
				instanceId: die.instanceId,
				tier: die.tier,
				label: TIER_LABEL[die.tier],
				imageUrl: tierDieImage(die.tier)
			}))
			.sort((a, b) => rank(a.tier) - rank(b.tier));
	});
	const diceSlots = $derived(
		Array.from({ length: MAX_ATTACK_DICE }, (_, i) => diceList[i] ?? null)
	);

	// ── Spirit inspection ───────────────────────────────────────────────────────
	// Clicking a hex opens that spirit's detail card. Re-clicking the same hex (or
	// switching to another viewed player) closes it.
	let selectedSlot = $state<number | null>(null);
	$effect(() => {
		// Reset the selection whenever we switch to a different player's board.
		void viewedSeat;
		selectedSlot = null;
	});
	$effect(() => {
		// Self-heal: if the selected slot is no longer occupied (discarded, replaced,
		// reshuffled), drop the selection so the card can't silently re-open on a
		// different spirit that later reuses the same slot index.
		if (selectedSlot != null && !player?.spirits.some((s) => s.slotIndex === selectedSlot)) {
			selectedSlot = null;
		}
	});

	const selectedSpirit = $derived(
		selectedSlot != null ? (player?.spirits.find((s) => s.slotIndex === selectedSlot) ?? null) : null
	);
	const selectedAsset = $derived(
		selectedSpirit ? (assets.spiritAssets.get(selectedSpirit.id) ?? null) : null
	);
	// Resolved class traits (name + description) for the selected spirit's classes.
	const selectedClasses = $derived.by(() => {
		const out: ClassTrait[] = [];
		for (const id of selectedAsset?.traits.class_ids ?? []) {
			const cls = assets.classTraits.get(id);
			if (cls) out.push(cls);
		}
		return out;
	});
	// Awakening requirement, ready to render: free text, or a list of rune chips.
	const awakenView = $derived.by(() => {
		const a = selectedAsset?.awaken_condition;
		if (!a) return null;
		if (a.type === 'text') return { kind: 'text' as const, text: a.text };
		// rune_cost: a UUID repeated N times means "N of that rune" — collapse to counts.
		const counts = new Map<string, number>();
		for (const id of a.rune_ids) counts.set(id, (counts.get(id) ?? 0) + 1);
		const runes = [...counts.entries()].map(([id, count]) => {
			// The two wildcard cost-matchers aren't real rune records, so a direct lookup
			// would mislabel them — name them explicitly.
			if (id === WILDCARD_MAT_IDS.anyRune)
				return { id, count, name: 'Any Rune', icon: null, wildcard: true };
			if (id === WILDCARD_MAT_IDS.anyRelic)
				return { id, count, name: 'Any Relic', icon: null, wildcard: true };
			const asset = assets.matAssets.get(id);
			return {
				id,
				count,
				name: asset?.name ?? 'Special',
				icon: storageUrl(asset?.icon_path ?? null),
				wildcard: false
			};
		});
		return { kind: 'rune_cost' as const, runes };
	});

	function discardSelected() {
		if (selectedSpirit) onDiscardSpirit?.(selectedSpirit.slotIndex);
		selectedSlot = null;
	}

	// ── Augments ──────────────────────────────────────────────────────────────
	// Placed Spirit Augment badges (the class-linked augment token icon), keyed by the
	// host spirit slot. Only class-linked attachments are Spirit Augments.
	const augmentsBySlot = $derived.by(() => {
		const map = new Map<number, { runeId: string; name: string; icon: string | null }[]>();
		for (const att of player?.spiritAugmentAttachments ?? []) {
			const className = typeof att.className === 'string' ? att.className : null;
			if (!className) continue; // not a Spirit Augment
			const entry = {
				runeId: att.runeId,
				name: `${className} Augment`,
				icon: augmentIconForClass(assets, className)
			};
			const arr = map.get(att.spiritSlotIndex) ?? [];
			arr.push(entry);
			map.set(att.spiritSlotIndex, arr);
		}
		return map;
	});
	// Unawakened (face-down) spirits show their back face on the hex board, keyed by slot.
	const backImageBySlot = $derived.by(() => {
		const map = new Map<number, string>();
		for (const s of player?.spirits ?? []) {
			if (s.isFaceDown) map.set(s.slotIndex, spiritBackImageUrl(s.id));
		}
		return map;
	});
	// My unplaced augments — the draggable "to place" pouch (own seat only).
	const myAugments = $derived(isMe ? (player?.unplacedAugments ?? []) : []);
	// Augment placement is handled in the main scene; this scout view only shows
	// placed-augment badges.
</script>

<div class="composition" style="--accent: {accent}" data-testid="composition-stage" data-seat={viewedSeat}>
	<div class="board-area">
		{#if isMe && myAugments.length > 0}
			<div class="augment-tray" data-testid="augment-tray">
				<span class="aug-tray-label">
					{myAugments.length} Spirit Augment{myAugments.length === 1 ? '' : 's'} to place — use the main scene.
				</span>
			</div>
		{/if}

		<div class="hex-wrap" data-testid="scout-hexes">
			<HexGrid
				spirits={player?.spirits ?? []}
				spiritAssets={spiritImages}
				{backImageBySlot}
				{augmentsBySlot}
				selectable={true}
				{selectedSlot}
				onSelect={(slot) => (selectedSlot = selectedSlot === slot ? null : slot)}
			/>
		</div>
	</div>

	<!-- Bottom info slot: a spirit's details when a hex is selected, otherwise the
	     player's Dice Pool. Selecting a spirit swaps this same area instead of
	     floating a card — keeps the layout streamlined under the board. -->
	<div class="info-slot">
		{#if selectedSpirit}
		<aside class="detail-card" data-testid="spirit-detail-card">
			<header class="dc-head">
				<span class="dc-name">{selectedSpirit.name}</span>
				{#if selectedSpirit.isFaceDown}<span class="dc-tag">Unawakened</span>{/if}
				<button
					type="button"
					class="dc-close"
					data-testid="spirit-detail-close"
					aria-label="Close spirit details"
					onclick={() => (selectedSlot = null)}
				>✕</button>
			</header>

			<div class="dc-body">
				{#if selectedClasses.length > 0}
					<section class="dc-section">
						<span class="dc-label">{selectedClasses.length > 1 ? 'Classes' : 'Class'}</span>
						{#each selectedClasses as cls (cls.id)}
							<div class="dc-class">
								<span class="dc-class-name" style="--c: {cls.color || 'var(--brand-cyan, #5cdfff)'}">{cls.name}</span>
								{#if cls.description}<p class="dc-desc">{cls.description}</p>{/if}
							</div>
						{/each}
					</section>
				{/if}

				{#if awakenView}
					<section class="dc-section">
						<span class="dc-label">Awakens with</span>
						{#if awakenView.kind === 'text'}
							<p class="dc-desc">{awakenView.text}</p>
						{:else if awakenView.runes.length > 0}
							<div class="dc-runes">
								{#each awakenView.runes as r (r.id)}
									<span class="dc-rune" class:wild={r.wildcard} title={r.count > 1 ? `${r.name} ×${r.count}` : r.name}>
										{#if r.wildcard}
											<span class="dc-rune-wild" aria-hidden="true">✦</span>
											<span class="dc-rune-label">{r.name}</span>
										{:else if r.icon}
											<img src={r.icon} alt={r.name} />
										{:else}
											<span class="dc-rune-fb">{r.name.slice(0, 1)}</span>
										{/if}
										{#if r.count > 1}<span class="dc-rune-x">×{r.count}</span>{/if}
									</span>
								{/each}
							</div>
						{:else}
							<p class="dc-desc muted">No requirement.</p>
						{/if}
					</section>
				{/if}
			</div>

			{#if isMe}
				<button
					type="button"
					class="dc-discard"
					data-testid="spirit-detail-discard"
					disabled={busy}
					onclick={discardSelected}
				>
					<span aria-hidden="true">🗑</span> Discard
				</button>
			{/if}
		</aside>
		{:else}
			<section
				class="dice-pool"
				data-testid="scout-dice-pool"
				title="Attack dice and the average total damage of a roll"
			>
				<div class="dp-row" data-testid="scout-combat-stats">
					<div class="dp-dice-grid" aria-label="Attack dice">
						{#each diceSlots as d, i (d?.instanceId ?? `empty-${i}`)}
							<span
								class="dp-die"
								class:empty={!d}
								data-testid={d ? `scout-die-${d.tier}` : undefined}
								title={d ? `${d.label} Attack` : 'Empty attack die slot'}
								aria-hidden={!d}
							>
								{#if d}
									{#if d.imageUrl}
										<img src={d.imageUrl} alt={`${d.label} die`} loading="lazy" decoding="async" />
									{:else}
										<span class="dp-die-fb">{d.label.slice(0, 1)}</span>
									{/if}
								{/if}
							</span>
						{/each}
					</div>
					<span class="dp-avg">
						<span class="dp-avg-val" data-testid="scout-avg-attack">{avgAttack.toFixed(1)}</span>
						<span class="dp-avg-label">avg attack</span>
					</span>
					<span class="dp-stat">
						<span class="dp-stat-val" data-testid="profile-initiative">{initiative}</span>
						<span class="dp-stat-label">initiative</span>
					</span>
					<span class="dp-stat status" style="--s: {statusColor}">
						<span class="dp-stat-val" data-testid="profile-status">{statusLabel}</span>
						<span class="dp-stat-label">status</span>
					</span>
				</div>
			</section>
		{/if}
	</div>
</div>

<style>
	/* Fills the map-layer slot. The board centers; a spirit detail card appears beside
	   it on landscape (row) and below it on portrait/narrow screens (column). */
	.composition {
		position: relative;
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		min-height: 0;
		padding: 0.5rem;
		animation: fade 140ms ease both;
	}

	/* Initiative + Status sit in the dice-pool readout row, sharing the same value-over-label
	   shape (and the row's thin white dividers) as the average-attack cell beside them. */
	.dp-stat {
		display: inline-flex;
		flex-direction: column;
		align-items: center;
		gap: 0.12rem;
		padding: 0.1rem 0.62rem;
	}
	.dp-stat-val {
		font-family: var(--font-display);
		font-size: clamp(1.1rem, 3.6vh, 1.5rem);
		font-weight: 700;
		line-height: 1;
		color: #fff;
		text-transform: uppercase;
	}
	.dp-stat-label {
		font-size: clamp(0.58rem, 1.9vh, 0.8rem);
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--color-fog, #9a93b0);
	}
	/* Status reads in its alignment colour (green Pure → red Fallen). */
	.dp-stat.status .dp-stat-val {
		color: var(--s);
		text-shadow: 0 0 10px color-mix(in srgb, var(--s) 50%, transparent);
	}

	/* ── Dice Pool: flat in-line strip — attack-dice icons + the pool's average ──
	   rolled damage. No card chrome; thin white dividers separate each component. */
	.dice-pool {
		flex: 0 0 auto;
		max-width: 100%;
		display: flex;
		flex-direction: row;
		align-items: center;
		justify-content: center;
		font-variant-numeric: tabular-nums;
	}
	.dp-row {
		display: flex;
		flex-wrap: nowrap;
		align-items: center;
		justify-content: center;
		max-width: 100%;
		overflow: hidden;
	}
	/* Thin white divider between every die and before the average readout. */
	.dp-row > * + * {
		border-left: 1px solid rgba(255, 255, 255, 0.28);
	}
	.dp-dice-grid {
		--dp-die-size: clamp(1.35rem, 5.4vh, 2rem);
		display: grid;
		grid-template-rows: repeat(2, var(--dp-die-size));
		grid-template-columns: repeat(5, var(--dp-die-size));
		gap: 0.08rem 0.16rem;
		align-items: center;
		justify-content: center;
		padding: 0.08rem 0.5rem 0.08rem 0;
		min-width: calc((var(--dp-die-size) * 5) + (0.16rem * 4));
	}
	.dp-die {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 0;
		min-height: 0;
	}
	.dp-die.empty {
		border-radius: 6px;
		background: rgba(8, 5, 16, 0.42);
		box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
	}
	.dp-die img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		display: block;
	}
	.dp-die-fb {
		width: 100%;
		height: 100%;
		display: grid;
		place-items: center;
		border-radius: 6px;
		background: rgba(0, 0, 0, 0.35);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 50%, transparent);
		font-family: var(--font-display);
		font-size: clamp(0.72rem, 2.4vh, 1rem);
		color: #fff;
	}
	.dp-avg {
		display: inline-flex;
		flex-direction: column;
		align-items: center;
		gap: 0.12rem;
		padding: 0.1rem 0.62rem;
	}
	.dp-avg-val {
		font-family: var(--font-display);
		font-size: clamp(1.1rem, 3.6vh, 1.5rem);
		font-weight: 700;
		line-height: 1;
		color: #fff;
	}
	.dp-avg-label {
		font-size: clamp(0.58rem, 1.9vh, 0.8rem);
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--color-fog, #9a93b0);
	}

	.board-area {
		position: relative;
		flex: 1 1 auto;
		min-height: 0;
		width: 100%;
		display: grid;
		place-items: center;
		/* Become a size container so the board can size itself to the largest
		   square that fits this box (both width AND height) — see .hex-wrap. */
		container-type: size;
	}
	.hex-wrap {
		position: relative;
		/* Largest square that fits the board-area in BOTH dimensions, capped by a
		   viewport-relative ceiling. Using cqw/cqh (not just width + max-height)
		   means the square actually shrinks its width to honor the available
		   height, so it never spills into the stats below on short viewports. */
		width: min(100cqw, 100cqh, clamp(300px, 82vmin, 720px));
		aspect-ratio: 1;
		display: grid;
		place-items: center;
	}
	.hex-wrap :global(.hex-grid) {
		width: 100%;
		height: 100%;
	}

	/* ── Bottom info slot: holds either the Dice Pool or a selected spirit's
	   details, directly under the board. Bounded height so a long detail scrolls
	   rather than shoving the board off-screen. ─────────────────────────────── */
	.info-slot {
		flex: 0 0 auto;
		width: min(560px, 98%);
		max-height: 40%;
		min-height: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: flex-start;
	}
	.info-slot > .dice-pool {
		width: 100%;
	}

	/* ── Spirit detail card (now in-flow inside the info slot) ───────────────── */
	.detail-card {
		flex: 0 1 auto;
		width: 100%;
		max-height: 100%;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem 1.1rem;
		border-radius: 14px;
		border: 1px solid color-mix(in srgb, var(--accent) 50%, transparent);
		border-top: 3px solid var(--accent);
		background: linear-gradient(180deg, rgba(18, 10, 38, 0.98), rgba(8, 5, 16, 0.99));
		box-shadow: 0 18px 60px rgba(0, 0, 0, 0.6);
		animation: card-in 180ms cubic-bezier(0.22, 1.2, 0.36, 1) both;
	}
	.dc-head {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-shrink: 0;
	}
	.dc-name {
		font-family: var(--font-display);
		font-size: 1.4rem;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: #fff;
		line-height: 1.05;
		flex: 1;
		min-width: 0;
	}
	.dc-tag {
		flex-shrink: 0;
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		padding: 3px 8px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-fog, #8d8aa1) 28%, transparent);
		color: var(--color-parchment, #e7e0cf);
	}
	.dc-close {
		flex-shrink: 0;
		width: 28px;
		height: 28px;
		display: grid;
		place-items: center;
		border-radius: 6px;
		border: 1px solid var(--color-mist, #3a2670);
		background: rgba(10, 7, 20, 0.6);
		color: var(--color-fog, #8d8aa1);
		font-size: 0.85rem;
		line-height: 1;
		cursor: pointer;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		transition: border-color 140ms ease, color 140ms ease;
	}
	@media (hover: hover) and (pointer: fine) {
		.dc-close:hover {
			border-color: var(--color-blood, #e05858);
			color: var(--color-blood, #e05858);
		}
	}
	.dc-close:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.dc-body {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		min-height: 0;
	}
	.dc-section {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.dc-label {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--brand-cyan, #5cdfff);
	}
	.dc-class {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.dc-class-name {
		font-family: var(--font-display);
		font-size: 1.05rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--c);
	}
	.dc-desc {
		margin: 0;
		font-size: 0.95rem;
		line-height: 1.45;
		color: var(--color-parchment, #e7e0cf);
	}
	.dc-desc.muted {
		color: var(--color-whisper, #6a6680);
	}
	.dc-runes {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.dc-rune {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 8px 4px 4px;
		border-radius: 999px;
		background: rgba(47, 199, 199, 0.1);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--brand-teal, #2fc7c7) 55%, transparent);
	}
	.dc-rune img {
		width: 26px;
		height: 26px;
		object-fit: contain;
	}
	.dc-rune-fb {
		width: 26px;
		height: 26px;
		display: grid;
		place-items: center;
		border-radius: 50%;
		background: #140a24;
		font-family: var(--font-display);
		color: var(--brand-teal, #2fc7c7);
	}
	/* Wildcard awaken costs ("Any Rune" / "Any Relic") are labelled chips, not icons. */
	.dc-rune.wild {
		padding: 4px 10px;
		background: rgba(157, 77, 255, 0.12);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--brand-violet, #9d4dff) 55%, transparent);
	}
	.dc-rune-wild {
		font-size: 1rem;
		line-height: 1;
		color: var(--brand-violet, #c89bff);
	}
	.dc-rune-label {
		font-family: var(--font-display);
		font-size: 0.82rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--color-parchment, #e7e0cf);
	}
	.dc-rune-x {
		font-family: var(--font-display);
		font-variant-numeric: tabular-nums;
		font-size: 0.9rem;
		color: #fff;
	}
	.dc-discard {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 9px 14px;
		border-radius: 8px;
		border: 1px solid color-mix(in srgb, var(--color-blood, #e05858) 55%, transparent);
		background: color-mix(in srgb, var(--color-blood, #e05858) 12%, transparent);
		color: var(--color-blood, #ff8585);
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		cursor: pointer;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		transition: border-color 140ms ease, background 140ms ease, color 140ms ease;
	}
	.dc-discard:not(:disabled):hover {
		border-color: var(--color-blood, #e05858);
		background: color-mix(in srgb, var(--color-blood, #e05858) 22%, transparent);
		color: #fff;
	}
	.dc-discard:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.dc-discard:focus-visible {
		outline: 2px solid var(--color-blood, #e05858);
		outline-offset: 2px;
	}

	/* ── Augment "to place" tray — floated above the hex board (own seat only) ── */
	.augment-tray {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		z-index: 2;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
	}
	.aug-tray-label {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: #d6b24a;
	}

	@keyframes fade {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@keyframes card-in {
		from {
			opacity: 0;
			transform: translateY(8px) scale(0.98);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.composition,
		.detail-card {
			animation: none;
		}
	}

	/* ── Wide screens: keep the board + info stacked (board on top, info below),
	   just bound the column width and centre it in the gutter the side floats
	   (trait list + leaderboard) leave. ── */
	@media (min-width: 1200px) and (orientation: landscape) {
		.composition {
			width: 100%;
			max-width: min(1040px, 100%);
			margin: 0 auto;
		}
	}
</style>

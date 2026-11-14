<script lang="ts">
	/**
	 * One Arcane Abyss monster card: a tarot-shaped card (3:5) with two faces.
	 * Back = the difficulty deck's art. Front = the printed card (art, Health = Barrier,
	 * Damage, name and kill rewards baked in, see `monsterCardFace`) with the live state
	 * on top; while that image loads, or when the card has none or it no longer matches
	 * the game, the front is drawn from live data (name, Barrier, Hits, rewards).
	 * `faceUp` flips it in 3D. The card sizes to its parent's width, and its type scales
	 * with that width (container query units), so the same component serves the hand,
	 * the decks, the reveal and the combat screen.
	 */
	import type { MonsterState } from '$lib/play/types';
	import { buildMonsterRewards } from '$lib/play/monsterRewards';
	import { originalImageUrl } from '$lib/storageImages';
	import { getAssetState } from '$lib/stores/assetStore.svelte';
	import {
		displayName,
		MONSTER_DIFFICULTY_COLOR,
		MONSTER_NUMERAL,
		monsterBackUrl,
		monsterCatalogCardPath,
		rewardTokenIconUrl,
		type MonsterDifficulty
	} from './helpers';
	import { monsterCardFace } from './monsterCardFace';

	interface Props {
		/** Front-face data. Without a card only the back can show. */
		card?: MonsterState | null;
		/** Deck of the back face. Defaults to the card's own difficulty. */
		difficulty?: MonsterDifficulty;
		/** Show the front. Changing it flips the card. */
		faceUp?: boolean;
		/** Show the deck numeral on the back. */
		backNumeral?: boolean;
		/** Grey the card out and stamp it "Defeated". */
		defeated?: boolean;
	}

	let { card = null, difficulty, faceUp = true, backNumeral = true, defeated = false }: Props =
		$props();

	const assets = getAssetState();
	const deck = $derived<MonsterDifficulty>(difficulty ?? card?.difficulty ?? 1);
	const color = $derived(MONSTER_DIFFICULTY_COLOR[deck]);
	const showFront = $derived(faceUp && !!card);
	const damaged = $derived(!!card && card.hp < card.maxHp);

	// ── The printed face ──────────────────────────────────────────────────────
	const face = $derived(
		card
			? monsterCardFace(
					{ id: card.id, barrier: card.maxHp, damage: card.damage, rewardTrack: card.rewardTrack },
					monsterCatalogCardPath(assets, card)
				)
			: null
	);
	/** Keyed by URL, so a new card never inherits the old card's load state. */
	let loadedUrl = $state<string | null>(null);
	let failedUrl = $state<string | null>(null);
	const printed = $derived(!!face && loadedUrl === face.url);
	function onFaceLoad(url: string) {
		loadedUrl = url;
	}
	function onFaceError(event: Event, url: string) {
		const img = event.currentTarget as HTMLImageElement;
		// The page-wide fallback (installImageFallback) swaps a resized storage URL to its
		// original before this runs: give the original one try, then draw the card.
		if (originalImageUrl(url) && img.src !== url && !img.dataset.retried) {
			img.dataset.retried = '1';
			return;
		}
		failedUrl = url;
	}

	const rewards = $derived(
		card
			? buildMonsterRewards(card.rewardTrack).map((option) => ({
					index: option.index,
					label: option.label,
					url: rewardTokenIconUrl(assets, option.token)
				}))
			: []
	);
	const name = $derived(card ? displayName(card.name) : '');
	/** The label describes what shows: the printed card can carry another name than the
	 *  database row (Michael's card names; the rows are not renamed). */
	const shownName = $derived(printed && face?.printed ? face.printed.name : name);
	const label = $derived(
		card && showFront
			? `${shownName}: Barrier ${damaged ? `${card.hp} of ${card.maxHp}` : card.maxHp}, hits for ${card.damage}${
					rewards.length ? `. Rewards: ${rewards.map((r) => r.label).join(', ')}` : ''
				}`
			: `Difficulty ${MONSTER_NUMERAL[deck]} monster card, face down`
	);
</script>

<div
	class="mc"
	class:up={showFront}
	class:defeated
	style="--c: {color}"
	role="img"
	aria-label={label}
	data-difficulty={deck}
>
	<div class="flip">
		<div class="face back" aria-hidden="true">
			<img src={monsterBackUrl(deck)} alt="" draggable="false" />
			{#if backNumeral}<span class="back-numeral">{MONSTER_NUMERAL[deck]}</span>{/if}
		</div>
		<div class="face front" class:printed aria-hidden="true">
			{#if card}
				{#if face && failedUrl !== face.url}
					{@const url = face.url}
					<!-- Loads while the drawn face shows; replaces it once it is in. -->
					<span class="print" data-testid="monster-card-print">
						<img
							src={url}
							alt=""
							draggable="false"
							decoding="async"
							onload={() => onFaceLoad(url)}
							onerror={(event) => onFaceError(event, url)}
						/>
						{#if damaged && !defeated}
							<!-- Damage stays on the card: the Barrier left covers the printed Health. -->
							<span class="barrier-left" data-testid="monster-card-barrier-left">
								<b>{card.hp}</b><s>{card.maxHp}</s>
							</span>
						{/if}
					</span>
				{/if}
				{#if !printed}
					<div class="art">
						<span class="numeral">{MONSTER_NUMERAL[deck]}</span>
					</div>
					<div class="band">{name}</div>
					<div class="stats">
						<span class="stat barrier" class:hurt={damaged}>
							<span class="k">Barrier</span>
							<span class="v">{damaged ? `${card.hp}/${card.maxHp}` : card.maxHp}</span>
						</span>
						<span class="stat hits">
							<span class="k">Hits</span>
							<span class="v">{card.damage}</span>
						</span>
					</div>
					{#if rewards.length > 0}
						<div class="rewards">
							{#each rewards as reward (reward.index)}
								{#if reward.url}
									<img src={reward.url} alt="" title={reward.label} draggable="false" />
								{:else}
									<span class="rw-text">{reward.label}</span>
								{/if}
							{/each}
						</div>
					{/if}
				{/if}
				{#if defeated}<span class="stamp">Defeated</span>{/if}
			{/if}
		</div>
	</div>
</div>

<style>
	.mc {
		--c: #5cdfff;
		position: relative;
		width: 100%;
		aspect-ratio: 3 / 5;
		container-type: inline-size;
		perspective: 900px;
		color: #fff;
		text-align: center;
		user-select: none;
		-webkit-user-select: none;
	}
	.flip {
		position: absolute;
		inset: 0;
		transform-style: preserve-3d;
		transform: rotateY(180deg);
		transition: transform 620ms cubic-bezier(0.3, 0.7, 0.2, 1);
	}
	.mc.up .flip {
		transform: rotateY(0deg);
	}
	.face {
		position: absolute;
		inset: 0;
		border-radius: 6cqi;
		backface-visibility: hidden;
		-webkit-backface-visibility: hidden;
	}
	.face.back {
		transform: rotateY(180deg);
		filter: drop-shadow(0 4cqi 7cqi rgba(0, 0, 0, 0.55));
	}
	.face.back img {
		display: block;
		width: 100%;
		height: 100%;
		/* The art is 2:3; the card is 3:5. A slight vertical stretch keeps the whole
		   gold frame (cover would crop its sides). */
		object-fit: fill;
		pointer-events: none;
	}
	.back-numeral {
		position: absolute;
		left: 0;
		right: 0;
		top: 50%;
		transform: translateY(-50%);
		font-family: var(--font-display);
		font-size: 30cqi;
		line-height: 1;
		letter-spacing: 0.04em;
		color: var(--c);
		text-shadow:
			0 0 3cqi #000,
			0 0 10cqi color-mix(in srgb, var(--c) 80%, transparent);
	}

	/* ── Front ─────────────────────────────────────────────────────────────── */
	.face.front {
		display: grid;
		grid-template-rows: minmax(0, 1fr) auto auto auto;
		overflow: hidden;
		background:
			radial-gradient(ellipse at 50% 22%, color-mix(in srgb, var(--c) 26%, transparent), transparent 60%),
			linear-gradient(170deg, #2a1552, #120a2c 60%, #0b0618);
		box-shadow:
			0 0 0 max(1.5px, 1.4cqi) var(--c),
			0 0 9cqi color-mix(in srgb, var(--c) 50%, transparent),
			0 6cqi 12cqi rgba(0, 0, 0, 0.6);
	}
	.art {
		position: relative;
		display: grid;
		place-items: center;
		min-height: 0;
		margin: 4cqi 4cqi 0;
		border-radius: 4cqi;
		overflow: hidden;
		background: radial-gradient(circle at 50% 45%, color-mix(in srgb, var(--c) 42%, transparent), transparent 68%);
	}
	.numeral {
		font-family: var(--font-display);
		font-size: 34cqi;
		line-height: 1;
		color: var(--c);
		text-shadow: 0 0 8cqi var(--c);
	}
	.band {
		padding: 3cqi 4cqi 2cqi;
		font-family: var(--font-display);
		font-size: 10.5cqi;
		line-height: 1.05;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		overflow: hidden;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		text-shadow: 0 1cqi 3cqi #000;
	}
	.stats {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 2.5cqi;
		padding: 0 4cqi;
	}
	.stat {
		display: grid;
		gap: 0.5cqi;
		padding: 1.5cqi 1cqi 2cqi;
		border-radius: 3cqi;
		background: rgba(255, 255, 255, 0.07);
		min-width: 0;
	}
	.k {
		font-size: max(7px, 6.5cqi);
		font-weight: 800;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: rgba(244, 241, 255, 0.68);
		line-height: 1.1;
	}
	.v {
		font-family: var(--font-display);
		font-size: 15cqi;
		line-height: 1;
		font-variant-numeric: tabular-nums;
	}
	.barrier .v {
		color: #9fd8ff;
	}
	/* Damage stays on the card: the Barrier reads hurt until the card is defeated. */
	.barrier.hurt {
		background: rgba(255, 90, 90, 0.16);
		box-shadow: inset 0 0 0 1px rgba(255, 110, 110, 0.45);
	}
	.barrier.hurt .v {
		color: #ff8a8a;
	}
	.hits .v {
		color: #ffc46b;
	}
	.rewards {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		align-items: center;
		gap: 1.5cqi;
		padding: 3cqi 3cqi 4.5cqi;
	}
	.rewards img {
		width: 15cqi;
		height: 15cqi;
		object-fit: contain;
		filter: drop-shadow(0 1cqi 2cqi rgba(0, 0, 0, 0.6));
		pointer-events: none;
	}
	.rw-text {
		font-size: max(7px, 6.5cqi);
		font-weight: 800;
		color: var(--brand-amber, #ffba3d);
	}

	/* ── Printed front: the exported card (825 × 1425) at full card height ─── */
	.face.front.printed {
		overflow: visible;
		background: none;
		box-shadow: none;
	}
	.print {
		position: absolute;
		top: 0;
		left: 50%;
		height: 100%;
		/* A little narrower than the 3:5 card; centred, the back still frames it. */
		aspect-ratio: 825 / 1425;
		transform: translateX(-50%);
		opacity: 0;
		pointer-events: none;
	}
	.face.front.printed .print {
		opacity: 1;
	}
	.print img {
		display: block;
		width: 100%;
		height: 100%;
		filter: drop-shadow(0 3cqi 6cqi rgba(0, 0, 0, 0.55))
			drop-shadow(0 0 2.5cqi color-mix(in srgb, var(--c) 45%, transparent));
	}
	/* Barrier left, over the printed Health number (plate: x 6–20 %, y 6.7–12.6 %; label above it). */
	.barrier-left {
		position: absolute;
		left: 5.3%;
		top: 6.8%;
		width: 15.6%;
		height: 6.5%;
		display: grid;
		place-items: center;
		border-radius: 1.6cqi;
		background: linear-gradient(180deg, #8c2234, #4d0f1c);
		box-shadow:
			0 0 0 0.5cqi #ff8a8a,
			0 0 3cqi rgba(255, 90, 90, 0.75);
	}
	.barrier-left b {
		font-family: var(--font-display);
		font-weight: 400;
		font-size: 10cqi;
		line-height: 1;
		color: #fff1e6;
		text-shadow: 0 0.5cqi 0 #2a0610;
		font-variant-numeric: tabular-nums;
	}
	/* The printed value, struck ("was 8"), below the plate so the HEALTH label stays clear. */
	.barrier-left s {
		position: absolute;
		right: -3.5cqi;
		bottom: -3.4cqi;
		padding: 0.2cqi 1.1cqi;
		border-radius: 999px;
		background: #1b1226;
		box-shadow: 0 0 0 0.35cqi rgba(255, 138, 138, 0.8);
		font-size: max(7px, 4.6cqi);
		font-weight: 800;
		line-height: 1.15;
		color: rgba(255, 241, 230, 0.8);
		text-decoration-thickness: 0.45cqi;
		text-decoration-color: #ff8a8a;
	}

	.mc.defeated .face.front > :not(.stamp) {
		filter: grayscale(0.85) brightness(0.6);
	}
	.stamp {
		position: absolute;
		left: 50%;
		top: 42%;
		transform: translate(-50%, -50%) rotate(-14deg);
		padding: 1.5cqi 5cqi;
		border: max(2px, 1.6cqi) solid var(--brand-amber, #ffba3d);
		border-radius: 3cqi;
		font-family: var(--font-display);
		font-size: 12cqi;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--brand-amber, #ffba3d);
		background: rgba(10, 4, 24, 0.7);
		box-shadow: 0 0 8cqi rgba(255, 186, 61, 0.45);
	}
	@media (prefers-reduced-motion: reduce) {
		.flip {
			transition: none;
		}
	}
</style>

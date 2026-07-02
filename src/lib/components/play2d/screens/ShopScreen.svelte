<script lang="ts">
	import { onMount } from 'svelte';
	import { SHOP_ITEMS, type CosmeticItem, type CosmeticKind } from '$lib/cosmetics/progression';
	import RankEmblem from '$lib/components/play2d/RankEmblem.svelte';
	import ScreenScaffold from './ScreenScaffold.svelte';
	import { getAssetState, loadAssets } from '$lib/stores/assetStore.svelte';
	import { STORAGE_BASE_URL } from '$lib/supabase';
	import { buyItem, equipItem, getCosmeticsState, loadCosmetics } from '$lib/stores/cosmetics.svelte';
	import { playMenuSfx } from '$lib/stores/menuAudio.svelte';

	type Category = 'all' | CosmeticKind;

	const assets = getAssetState();
	const cosmetics = getCosmeticsState();

	let category = $state<Category>('all');
	let selectedId = $state(SHOP_ITEMS[0]?.id ?? '');
	let message = $state<string | null>(null);

	const categories: { id: Category; label: string }[] = [
		{ id: 'all', label: 'Vault' },
		{ id: 'border', label: 'Borders' },
		{ id: 'guardianSkin', label: 'Skins' },
		{ id: 'banner', label: 'Banners' }
	];

	const filtered = $derived(
		SHOP_ITEMS.filter((item) => category === 'all' || item.kind === category)
	);
	const selected = $derived(
		filtered.find((item) => item.id === selectedId) ?? filtered[0] ?? SHOP_ITEMS[0]!
	);
	const owned = $derived(cosmetics.progression.ownedItemIds.includes(selected.id));
	const equipped = $derived(isEquipped(selected));
	const nextRank = $derived(cosmetics.nextRank);
	const rankProgress = $derived.by(() => {
		const current = cosmetics.rank;
		const next = cosmetics.nextRank;
		if (!next) return 100;
		const span = Math.max(1, next.minXp - current.minXp);
		return Math.max(0, Math.min(100, ((cosmetics.progression.rankXp - current.minXp) / span) * 100));
	});

	onMount(() => {
		loadCosmetics();
		void loadAssets();
	});

	function isEquipped(item: CosmeticItem): boolean {
		if (item.kind === 'border') return cosmetics.progression.equippedBorderId === item.id;
		if (item.kind === 'banner') return cosmetics.progression.equippedBannerId === item.id;
		return Object.values(cosmetics.progression.equippedGuardianSkinIds).includes(item.id);
	}

	function previewGuardian(item: CosmeticItem): string | null {
		if (item.kind !== 'guardianSkin') return null;
		const target = item.targetGuardian === 'Any Guardian' ? null : item.targetGuardian;
		const guardian =
			(target ? assets.guardianAssets.get(target) : null) ??
			assets.guardianAssets.values().next().value ??
			null;
		if (!guardian?.icon_image_path) return null;
		return guardian.icon_image_path.startsWith('http')
			? guardian.icon_image_path
			: `${STORAGE_BASE_URL}/${guardian.icon_image_path}`;
	}

	function chooseCategory(id: Category) {
		category = id;
		const first = SHOP_ITEMS.find((item) => id === 'all' || item.kind === id);
		if (first) selectedId = first.id;
		message = null;
		playMenuSfx('ui-click');
	}

	function chooseItem(id: string) {
		selectedId = id;
		message = null;
		playMenuSfx('ui-hover', { volume: 0.35 });
	}

	function buySelected() {
		const result = buyItem(selected.id);
		message = result.ok ? `${result.item.name} added to your vault.` : result.message;
		playMenuSfx(result.ok ? 'ui-click' : 'ui-back');
	}

	function equipSelected() {
		const result = equipItem(selected.id);
		message = result.ok ? `${result.item.shortName} equipped.` : result.message;
		playMenuSfx(result.ok ? 'ui-click' : 'ui-back');
	}

	function rarityLabel(item: CosmeticItem): string {
		return item.rarity.toUpperCase();
	}
</script>

<ScreenScaffold
	eyebrow="03 · Storefront"
	title="Abyss Market"
	subtitle="Spend match-earned Abyss Credits on borders, guardian treatments, and result banners."
>
	<div class="shop" data-testid="cosmetics-shop">
		<header class="wallet" aria-label="Wallet">
			<div class="credit">
				<img src="/cosmetics/abyss-credit.png" alt="" />
				<div>
					<span class="credit-value">{cosmetics.progression.credits}</span>
					<span class="credit-label">Abyss Credits</span>
				</div>
			</div>
			<div class="rankline">
				<RankEmblem rankId={cosmetics.rank.id} label="{cosmetics.rank.name} rank" />
				<div class="rankcopy">
					<span>{cosmetics.rank.name}</span>
					<small>{nextRank ? `${nextRank.name} at ${nextRank.minXp} XP` : 'Top rank'}</small>
				</div>
				<span class="track" aria-label="Rank progress"><span style="width: {rankProgress}%"></span></span>
			</div>
		</header>

		<div class="market">
			<nav class="rail" aria-label="Shop categories">
				{#each categories as cat (cat.id)}
					<button
						type="button"
						class:active={category === cat.id}
						onclick={() => chooseCategory(cat.id)}
					>
						<span class="rail-gem"></span>
						<span>{cat.label}</span>
					</button>
				{/each}
			</nav>

			<section class="feature" style="--accent: {selected.accent}" aria-label="Featured cosmetic">
				<div class="feature-copy">
					<span class="rarity">{rarityLabel(selected)}</span>
					<h2>{selected.name}</h2>
					<p>{selected.description}</p>
					{#if selected.targetGuardian}
						<span class="compat">{selected.targetGuardian}</span>
					{/if}
				</div>
				<div class="feature-art" class:skin={selected.kind === 'guardianSkin'}>
					{#if selected.kind === 'border'}
						<div class="border-demo">
							<span class="demo-avatar">A</span>
							<span class="demo-name">Arc Seeker</span>
						</div>
					{:else if selected.kind === 'banner'}
						<RankEmblem rankId={cosmetics.rank.id} size="lg" />
					{:else}
						{@const guardian = previewGuardian(selected)}
						{#if guardian}
							<img class="guardian" src={guardian} alt={selected.targetGuardian ?? selected.name} />
						{:else}
							<img class="credit-art" src="/cosmetics/abyss-credit.png" alt="" />
						{/if}
					{/if}
				</div>
			</section>

			<aside class="detail" style="--accent: {selected.accent}" aria-label="Purchase panel">
				<span class="detail-kind">{selected.kind === 'guardianSkin' ? 'Guardian Skin' : selected.kind}</span>
				<h3>{selected.shortName}</h3>
				<div class="price">
					<img src="/cosmetics/abyss-credit.png" alt="" />
					<span>{selected.price}</span>
				</div>
				<div class="status">
					<span>{owned ? 'Owned' : 'Locked'}</span>
					<span>{equipped ? 'Equipped' : selected.rarity}</span>
				</div>
				{#if !owned}
					<button class="buy" type="button" onclick={buySelected} disabled={cosmetics.progression.credits < selected.price}>
						Buy
					</button>
				{:else}
					<button class="buy" type="button" onclick={equipSelected} disabled={equipped}>
						{equipped ? 'Equipped' : 'Equip'}
					</button>
				{/if}
				{#if message}<p class="msg" aria-live="polite">{message}</p>{/if}
			</aside>
		</div>

		<div class="strip" aria-label="Cosmetics">
			{#each filtered as item (item.id)}
				<button
					type="button"
					class:active={item.id === selected.id}
					style="--accent: {item.accent}"
					onclick={() => chooseItem(item.id)}
				>
					<span class="tile-hex"></span>
					<span class="tile-name">{item.shortName}</span>
					<span class="tile-price">
						{#if cosmetics.progression.ownedItemIds.includes(item.id)}
							Owned
						{:else}
							<img src="/cosmetics/abyss-credit.png" alt="" />{item.price}
						{/if}
					</span>
				</button>
			{/each}
		</div>
	</div>
</ScreenScaffold>

<style>
	.shop {
		display: flex;
		flex-direction: column;
		gap: 16px;
		min-height: min(660px, calc(100vh - 210px));
	}
	.wallet {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 10px 12px;
		border: 1px solid var(--color-mist);
		background: rgba(10, 7, 24, 0.86);
		border-radius: 8px;
	}
	.credit,
	.rankline {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}
	.credit img,
	.price img,
	.tile-price img {
		width: 28px;
		height: 28px;
		object-fit: contain;
		border-radius: 50%;
	}
	.credit-value {
		display: block;
		font-family: var(--font-display);
		font-size: 1.55rem;
		line-height: 1;
		color: var(--color-bone);
	}
	.credit-label,
	.rankcopy small {
		display: block;
		font-family: var(--font-mono);
		font-size: 0.68rem;
		color: var(--color-fog);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.rankcopy span {
		display: block;
		font-family: var(--font-display);
		font-size: 1rem;
		color: var(--color-bone);
		line-height: 1;
	}
	.track {
		width: clamp(120px, 18vw, 220px);
		height: 5px;
		border-radius: 999px;
		background: rgba(154, 143, 184, 0.22);
		overflow: hidden;
	}
	.track span {
		display: block;
		height: 100%;
		background: linear-gradient(90deg, var(--brand-magenta), var(--brand-cyan));
	}
	.market {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: 178px minmax(0, 1fr) minmax(230px, 0.34fr);
		gap: 16px;
	}
	.rail,
	.detail,
	.feature {
		border: 1px solid var(--color-mist);
		background: rgba(17, 9, 31, 0.76);
		border-radius: 8px;
	}
	.rail {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 12px;
	}
	.rail button {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 11px 8px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--color-fog);
		font-family: var(--font-display);
		font-size: 0.84rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		text-align: left;
		cursor: pointer;
	}
	.rail button.active,
	.rail button:hover,
	.rail button:focus-visible {
		color: var(--color-bone);
		background: rgba(255, 43, 199, 0.12);
		outline: none;
	}
	.rail-gem,
	.tile-hex {
		width: 11px;
		height: 11px;
		transform: rotate(45deg);
		border: 1px solid currentColor;
	}
	.feature {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 0.8fr) minmax(220px, 1fr);
		align-items: center;
		gap: 18px;
		padding: clamp(18px, 3vw, 34px);
		overflow: hidden;
	}
	.feature::after {
		content: '';
		position: absolute;
		inset: auto 6% 12% 42%;
		height: 1px;
		background: linear-gradient(90deg, transparent, var(--accent), transparent);
		opacity: 0.75;
	}
	.rarity,
	.detail-kind,
	.compat {
		display: inline-flex;
		font-family: var(--font-display);
		font-size: 0.68rem;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--accent);
	}
	.feature h2 {
		margin: 12px 0 8px;
		font-family: var(--font-display);
		font-size: clamp(2.1rem, 6vw, 4.4rem);
		line-height: 0.86;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: var(--color-bone);
	}
	.feature p {
		max-width: 34ch;
		margin: 0 0 16px;
		color: var(--color-parchment);
		font-size: 0.9rem;
		line-height: 1.45;
	}
	.compat {
		color: var(--color-fog);
	}
	.feature-art {
		min-height: 280px;
		display: grid;
		place-items: center;
	}
	.border-demo {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 16px 20px;
		border: 1px solid var(--accent);
		border-radius: 8px;
		background: color-mix(in srgb, var(--accent) 12%, rgba(0, 0, 0, 0.2));
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent);
	}
	.demo-avatar {
		display: grid;
		place-items: center;
		width: 52px;
		height: 52px;
		border-radius: 50%;
		background: var(--color-crypt);
		border: 2px solid var(--accent);
		font-family: var(--font-display);
		color: var(--color-bone);
	}
	.demo-name {
		font-family: var(--font-display);
		font-size: 1.35rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-bone);
	}
	.guardian,
	.credit-art {
		width: min(260px, 80%);
		aspect-ratio: 1;
		object-fit: cover;
		border-radius: 50%;
		border: 2px solid var(--accent);
		filter: saturate(1.15) hue-rotate(16deg);
	}
	.credit-art {
		object-fit: contain;
		border: 0;
	}
	.detail {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 18px;
	}
	.detail h3 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 2rem;
		color: var(--color-bone);
		text-transform: uppercase;
	}
	.price {
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: var(--font-display);
		font-size: 1.8rem;
		color: var(--color-bone);
	}
	.status {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}
	.status span {
		padding: 8px;
		border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--color-mist));
		border-radius: 6px;
		color: var(--color-parchment);
		font-family: var(--font-mono);
		font-size: 0.72rem;
		text-transform: uppercase;
		text-align: center;
	}
	.buy {
		margin-top: auto;
		min-height: 44px;
		border: 1px solid var(--accent);
		border-radius: 6px;
		background: color-mix(in srgb, var(--accent) 24%, rgba(0, 0, 0, 0.32));
		color: var(--color-bone);
		font-family: var(--font-display);
		font-size: 1rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		cursor: pointer;
	}
	.buy:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.msg {
		min-height: 1.2em;
		margin: 0;
		color: var(--color-fog);
		font-size: 0.8rem;
		line-height: 1.35;
	}
	.strip {
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: minmax(132px, 1fr);
		gap: 10px;
		overflow-x: auto;
		padding-bottom: 2px;
	}
	.strip button {
		display: grid;
		grid-template-rows: 1fr auto auto;
		justify-items: start;
		gap: 8px;
		min-height: 128px;
		padding: 12px;
		border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--color-mist));
		border-radius: 8px;
		background: rgba(10, 7, 24, 0.78);
		color: var(--color-parchment);
		text-align: left;
		cursor: pointer;
	}
	.strip button.active,
	.strip button:hover,
	.strip button:focus-visible {
		outline: none;
		background: color-mix(in srgb, var(--accent) 12%, rgba(10, 7, 24, 0.82));
	}
	.tile-hex {
		width: 42px;
		height: 42px;
		color: var(--accent);
		align-self: center;
		justify-self: center;
	}
	.tile-name {
		font-family: var(--font-display);
		font-size: 0.95rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-bone);
	}
	.tile-price {
		display: flex;
		align-items: center;
		gap: 4px;
		font-family: var(--font-mono);
		font-size: 0.72rem;
		color: var(--color-fog);
		text-transform: uppercase;
	}
	.tile-price img {
		width: 18px;
		height: 18px;
	}
	@media (max-width: 860px) {
		.market {
			grid-template-columns: 1fr;
		}
		.rail {
			flex-direction: row;
			overflow-x: auto;
		}
		.rail button {
			white-space: nowrap;
		}
		.feature {
			grid-template-columns: 1fr;
		}
		.wallet {
			align-items: stretch;
			flex-direction: column;
		}
	}
	@media (orientation: landscape) and (max-height: 520px) {
		:global(.inner:has(.shop)) {
			padding-top: calc(34px + env(safe-area-inset-top));
			padding-bottom: calc(16px + env(safe-area-inset-bottom));
		}
		:global(.head:has(+ .content .shop)) {
			margin-top: 4px;
			padding-bottom: 8px;
		}
		:global(.head:has(+ .content .shop) .title) {
			font-size: clamp(1.8rem, 10vh, 2.5rem);
		}
		:global(.head:has(+ .content .shop) .subtitle) {
			margin-top: 5px;
			max-width: 54ch;
			font-size: 0.72rem;
		}
		:global(.content:has(.shop)) {
			margin-top: 10px;
		}
		.shop {
			min-height: 0;
			gap: 10px;
		}
		.market {
			grid-template-columns: 144px minmax(0, 1fr) 210px;
			gap: 10px;
		}
		.wallet,
		.rail,
		.detail {
			padding: 8px;
		}
		.wallet {
			align-items: center;
			flex-direction: row;
		}
		.feature {
			min-height: 178px;
			padding: 16px;
		}
		.feature h2 {
			margin: 7px 0 5px;
			font-size: clamp(1.45rem, 8vh, 2rem);
			line-height: 0.9;
		}
		.feature p {
			margin-bottom: 8px;
			font-size: 0.72rem;
			line-height: 1.3;
		}
		.feature-art {
			min-height: 132px;
		}
		.border-demo {
			padding: 10px 12px;
		}
		.demo-avatar {
			width: 38px;
			height: 38px;
		}
		.demo-name {
			font-size: 0.95rem;
		}
		.detail {
			gap: 8px;
		}
		.detail h3 {
			font-size: 1.25rem;
		}
		.price {
			font-size: 1.25rem;
		}
		.buy {
			margin-top: 0;
			min-height: 34px;
			font-size: 0.8rem;
		}
		.strip {
			grid-auto-columns: 118px;
		}
		.strip button {
			min-height: 98px;
			padding: 9px;
		}
		.tile-hex {
			width: 30px;
			height: 30px;
		}
	}
</style>

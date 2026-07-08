<script lang="ts">
	import type { MonsterState } from '$lib/play/types';
	import type { MonsterAsset } from '$lib/types';
	import { displayName, storageUrl } from './helpers';

	interface Props {
		monster: MonsterState | null;
		monsterAssets?: Map<string, MonsterAsset>;
		/** Rendered inside a location card — drop the outer chrome + redundant title. */
		embedded?: boolean;
	}

	let { monster, monsterAssets = new Map(), embedded = false }: Props = $props();

	const imageUrl = $derived.by(() => {
		if (!monster) return null;
		const byId = monsterAssets.get(monster.id);
		const byName =
			byId ??
			Array.from(monsterAssets.values()).find(
				(m) => m.name?.toLowerCase() === monster.name.toLowerCase()
			);
		return storageUrl(byName?.card_image_path ?? null);
	});
</script>

<section class="monster" class:embedded>
	<header class="head">
		{#if !embedded}<span class="eyebrow">Arcane Abyss</span>{/if}
		{#if monster}<span class="dmg">DMG {monster.damage}</span>{/if}
	</header>
	{#if monster}
		<div class="card">
			{#if imageUrl}
				<img src={imageUrl} alt={displayName(monster.name)} loading="lazy" />
			{:else}
				<div class="card-fallback">{displayName(monster.name)}</div>
			{/if}
		</div>
		<div class="name">{displayName(monster.name)}</div>
		<!-- Monster health is a fixed kill threshold — the damage needed to slay it in one
		     combat. There is no shared/depleting pool: HP never persists between fights. -->
		<div class="hp">
			<span class="hp-num">HP {monster.maxHp}</span>
		</div>
		<!-- Tier = escalation rung (climbs as monsters are defeated). Dots = lives left:
		     kills scale with player count (1p→1, 2-3p→2, 4+p→3), then the next, stronger
		     monster comes out. -->
		<div class="horde">
			<span class="horde-label">Tier {monster.ladderIndex + 1}</span>
			<div class="lives" title="Kills needed to drive it off — scales with player count">
				{#each Array.from({ length: monster.livesTotal }, (_, i) => i) as i (i)}
					<span class="life-dot" class:spent={i >= monster.livesRemaining}></span>
				{/each}
			</div>
		</div>
	{:else}
		<div class="empty">No monster invading</div>
	{/if}
</section>

<style>
	.monster {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem;
		background: rgba(40, 6, 24, 0.55);
		border: 1px solid var(--brand-magenta, #ff2bc7);
		border-radius: 4px;
	}
	/* Embedded inside a location card: blend in, no own frame. */
	.monster.embedded {
		padding: 0;
		background: transparent;
		border: none;
		border-radius: 0;
		gap: 0.4rem;
	}
	.monster.embedded .head {
		justify-content: flex-end;
	}
	.monster.embedded .card img {
		max-height: 6rem;
	}
	.head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
	}
	.eyebrow {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: var(--brand-magenta-soft, #ff7fd9);
	}
	.dmg {
		font-family: var(--font-display);
		font-size: 0.8rem;
		color: var(--color-blood, #e05858);
	}
	.card {
		display: flex;
		justify-content: center;
	}
	.card img {
		max-width: 100%;
		max-height: 9rem;
		object-fit: contain;
		border-radius: 6px;
	}
	.card-fallback,
	.empty {
		padding: 1.25rem;
		text-align: center;
		font-family: var(--font-display);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		font-size: 0.8rem;
		color: var(--color-whisper, #6a6680);
		border: 1px dashed rgba(255, 255, 255, 0.12);
		border-radius: 6px;
	}
	.name {
		font-family: var(--font-display);
		font-size: 1.1rem;
		color: #fff;
		text-align: center;
	}
	.hp {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
	}
	.hp-num {
		font-family: var(--font-display);
		font-size: 0.8rem;
		color: #fff;
		font-variant-numeric: tabular-nums;
	}
	.horde {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.horde-label {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--color-fog, #8d8aa1);
	}
	.lives {
		display: flex;
		gap: 3px;
	}
	.life-dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--brand-magenta, #ff2bc7);
		box-shadow: 0 0 5px color-mix(in srgb, var(--brand-magenta, #ff2bc7) 70%, transparent);
	}
	.life-dot.spent {
		background: rgba(255, 255, 255, 0.14);
		box-shadow: none;
	}
</style>

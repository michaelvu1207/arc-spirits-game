<script lang="ts">
	import type { NavigationDestination, MonsterState } from '$lib/play/types';
	import type { GameLocationAsset, IconPoolEntry, RewardIconToken } from '$lib/types';
	import { displayName, storageUrl } from './helpers';

	interface Props {
		destination: NavigationDestination;
		location?: GameLocationAsset | null;
		iconPool?: Map<string, IconPoolEntry>;
		accent?: string;
		monster?: MonsterState | null;
		/** Whether a back-out is still allowed (navigation open + time remaining). */
		canExit?: boolean;
		onExit: () => void;
	}

	let {
		destination,
		location = null,
		iconPool = new Map(),
		accent = '#8d8aa1',
		monster = null,
		canExit = true,
		onExit
	}: Props = $props();

	const isAbyss = $derived(destination === 'Arcane Abyss');
	const rewardRows = $derived(location?.reward_rows ?? []);
	const orderedRows = $derived(
		[...rewardRows].sort((a, b) => (a.type === 'gain' ? 0 : 1) - (b.type === 'gain' ? 0 : 1))
	);

	function tokenIcons(token: RewardIconToken): { id: string; url: string | null }[] {
		const ids = typeof token === 'string' ? [token] : token.icon_ids;
		return ids.map((id) => ({ id, url: storageUrl(iconPool.get(id)?.file_path ?? null) }));
	}
</script>

<div class="confirmed" style="--accent: {accent}" data-testid="confirmed-destination">
	<span class="eyebrow">You have chosen this location</span>
	<h2 class="name">{destination}</h2>

	{#if isAbyss}
		{#if monster}
			<div class="monster">
				<span class="m-name">{displayName(monster.name)}</span>
				<span class="m-stat">HP {monster.maxHp}</span>
			</div>
		{:else}
			<span class="empty">No monster invading</span>
		{/if}
	{:else if orderedRows.length > 0}
		<ul class="rows">
			{#each orderedRows as row, i (i)}
				<li class="row">
					{#if row.type === 'text'}
						<span class="row-text">{row.text}</span>
					{:else if row.type === 'gain'}
						<span class="icons">
							{#each row.gain_icon_ids as token, ti (ti)}
								{#each tokenIcons(token) as ic, k (ic.id + k)}
									{#if k > 0}<span class="or">/</span>{/if}
									<span class="ico">{#if ic.url}<img src={ic.url} alt="" loading="lazy" />{:else}<span class="ico-fb" aria-hidden="true">✦</span>{/if}</span>
								{/each}
							{/each}
						</span>
					{:else}
						<span class="icons">
							{#each row.cost_icon_ids as token, ti (ti)}
								{#each tokenIcons(token) as ic, k (ic.id + k)}
									{#if k > 0}<span class="or">/</span>{/if}
									<span class="ico">{#if ic.url}<img src={ic.url} alt="" loading="lazy" />{:else}<span class="ico-fb" aria-hidden="true">✦</span>{/if}</span>
								{/each}
							{/each}
						</span>
						<span class="arrow">→</span>
						<span class="icons">
							{#each row.gain_icon_ids as token, ti (ti)}
								{#each tokenIcons(token) as ic, k (ic.id + k)}
									{#if k > 0}<span class="or">/</span>{/if}
									<span class="ico">{#if ic.url}<img src={ic.url} alt="" loading="lazy" />{:else}<span class="ico-fb" aria-hidden="true">✦</span>{/if}</span>
								{/each}
							{/each}
						</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if canExit}
		<button class="back" type="button" data-testid="exit-confirmed" onclick={onExit}>
			← Change selection
		</button>
	{:else}
		<span class="locked-note">Locked in — entering soon…</span>
	{/if}
</div>

<style>
	.confirmed {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.9rem;
		max-width: min(560px, 92%);
		margin: auto;
		padding: 1.5rem 1.75rem;
		text-align: center;
		/* Light glass so the zoomed splat reads through behind it. */
		background: radial-gradient(120% 100% at 50% 0%, rgba(8, 5, 18, 0.55), rgba(5, 3, 14, 0.7));
		border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
		border-radius: 16px;
		backdrop-filter: blur(6px);
		box-shadow: 0 20px 60px -20px rgba(0, 0, 0, 0.8);
		animation: confirm-in 360ms cubic-bezier(0.2, 0.9, 0.3, 1) both;
	}
	.eyebrow {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.28em;
		text-transform: uppercase;
		color: var(--brand-cyan, #5cdfff);
	}
	.name {
		margin: 0;
		font-family: var(--font-display);
		font-size: clamp(1.8rem, 4vw, 2.8rem);
		line-height: 1;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		color: #fff;
		text-shadow: 0 0 26px color-mix(in srgb, var(--accent) 70%, transparent);
	}
	.rows {
		list-style: none;
		margin: 0.2rem 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0;
		width: 100%;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 5px 10px;
	}
	/* A thin divider between rows instead of a filled background per row. */
	.row + .row {
		border-top: 1px solid rgba(255, 255, 255, 0.14);
	}
	.icons {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.ico {
		width: 28px;
		height: 28px;
		display: grid;
		place-items: center;
	}
	.ico img {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}
	/* Placeholder sigil for tokens with no art — a designed tile, not a hole. */
	.ico-fb {
		width: 100%;
		height: 100%;
		display: grid;
		place-items: center;
		border-radius: 22%;
		background: rgba(255, 255, 255, 0.05);
		box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.2);
		font-size: 0.78rem;
		color: color-mix(in srgb, var(--accent) 45%, #fff 35%);
	}
	.or {
		margin: 0 -4px;
		font-size: 0.78rem;
		font-weight: 700;
		color: var(--color-whisper, #8d8aa1);
	}
	.arrow {
		color: var(--brand-amber, #ffba3d);
		font-size: 1.1rem;
		margin: 0 -7px;
	}
	.row-text {
		font-size: 0.88rem;
		color: var(--color-fog, #9a93b0);
	}
	.monster {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.m-name {
		font-family: var(--font-display);
		font-size: 1.1rem;
		color: #fff;
	}
	.m-stat {
		font-size: 0.82rem;
		font-variant-numeric: tabular-nums;
		color: var(--brand-coral, #ff7a7a);
	}
	.empty {
		font-size: 0.85rem;
		color: var(--color-whisper, #6a6680);
	}
	.back {
		margin-top: 0.4rem;
		padding: 9px 20px;
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--color-bone, #f5f0ff);
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid var(--color-mist, #2e1d52);
		border-radius: 999px;
		cursor: pointer;
		transition: border-color 140ms ease, background 140ms ease;
	}
	.back:hover {
		border-color: var(--brand-magenta, #ff2bc7);
		background: rgba(255, 43, 199, 0.12);
	}
	.locked-note {
		margin-top: 0.4rem;
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--brand-amber-soft, #ffd56a);
	}
	@keyframes confirm-in {
		from {
			opacity: 0;
			transform: translateY(14px) scale(0.97);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.confirmed {
			animation: none;
		}
	}
</style>

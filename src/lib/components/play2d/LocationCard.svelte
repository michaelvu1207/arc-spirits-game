<script lang="ts">
	import type { SeatColor, NavigationDestination, MonsterState } from '$lib/play/types';
	import { LOCATION_ACCENT, type LocationConfig } from '$lib/play/locations';
	import type { GameLocationAsset, IconPoolEntry, RewardIconToken } from '$lib/types';
	import { seatAccent, storageUrl } from './helpers';

	interface Props {
		config: LocationConfig;
		location?: GameLocationAsset | null;
		iconPool?: Map<string, IconPoolEntry>;
		occupants?: SeatColor[];
		seatNames?: Partial<Record<SeatColor, string>>;
		selectable?: boolean;
		selected?: boolean;
		/** Emphasised (hovered / locked pick / spectator follow). */
		focused?: boolean;
		/** Render as the circular compass hub (the Arcane Abyss core). */
		hub?: boolean;
		onHover?: (destination: NavigationDestination | null) => void;
		/** Invading monster (Arcane Abyss only). */
		monster?: MonsterState | null;
		mySeat?: SeatColor | null;
		onSelect?: (destination: NavigationDestination) => void;
	}

	let {
		config,
		location = null,
		iconPool = new Map(),
		occupants = [],
		seatNames = {},
		selectable = false,
		selected = false,
		focused = false,
		hub = false,
		onHover,
		monster = null,
		mySeat = null,
		onSelect
	}: Props = $props();

	const accent = $derived(LOCATION_ACCENT[config.name] ?? '#8d8aa1');
	const rewardRows = $derived(location?.reward_rows ?? []);
	// Always surface the unconditional "Gain" action row(s) at the top of the list
	// (stable sort keeps every other row's relative order).
	const orderedRows = $derived(
		[...rewardRows].sort((a, b) => (a.type === 'gain' ? 0 : 1) - (b.type === 'gain' ? 0 : 1))
	);

	// Touch: tap the card to toggle the hover preview (pointer: coarse devices).
	let tapFocused = $state(false);
	function handlePointerEnter() {
		if (selectable) onHover?.(config.name);
	}
	function handlePointerLeave() {
		if (selectable) onHover?.(null);
	}
	function handleClick() {
		if (!selectable) return;
		// On touch devices also toggle the preview so the info is reachable without hover.
		if (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches) {
			tapFocused = !tapFocused;
			onHover?.(tapFocused ? config.name : null);
		}
		onSelect?.(config.name);
	}

	function tokenIcons(token: RewardIconToken): { id: string; url: string | null }[] {
		const ids = typeof token === 'string' ? [token] : token.icon_ids;
		return ids.map((id) => ({ id, url: storageUrl(iconPool.get(id)?.file_path ?? null) }));
	}
</script>

<button
	type="button"
	class="loc"
	data-testid="location-{config.name}"
	class:selectable
	class:selected
	class:focused
	class:tap-focused={tapFocused}
	class:hub
	class:abyss={config.combatOnly}
	style="--accent: {accent}"
	disabled={!selectable}
	onclick={handleClick}
	onpointerenter={handlePointerEnter}
	onpointerleave={handlePointerLeave}
	onfocus={() => selectable && onHover?.(config.name)}
	onblur={() => selectable && onHover?.(null)}
>
	<span class="name">{config.name}</span>

	{#if config.combatOnly}
		{#if monster}
			<!-- The monster's stats, lives, and rewards now live on the leaderboard boss
			     card, so the Abyss core just issues the call to action. -->
			<span class="fight">Fight the Monster</span>
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
	{:else}
		<span class="empty">Choose this realm to act here.</span>
	{/if}

	{#if occupants.length}
		<span class="tokens">
			{#each occupants as seat (seat)}
				<span
					class="tok"
					class:mine={seat === mySeat}
					style="background:{seatAccent(seat)}"
					title={seatNames[seat] ?? seat}
				></span>
			{/each}
		</span>
	{/if}
</button>

<style>
	/* A location node: name + reward rows. Used both as a compass arm (cardinal) and,
	   with .hub, as the round centre (the Arcane Abyss core). */
	.loc {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.6rem;
		border: none;
		background: none;
		color: inherit;
		font: inherit;
		cursor: default;
		text-align: center;
		transition: background 140ms ease, transform 140ms ease;
	}
	.loc.selectable {
		cursor: pointer;
	}
	/* No rectangle around cardinal cards — the quadrant wedge does the highlighting.
	   Hover/focus just lifts the name; the locked pick tints it. */
	@media (hover: hover) and (pointer: fine) {
		.loc.selectable:hover .name {
			text-shadow:
				0 1px 8px rgba(0, 0, 0, 0.85),
				0 0 16px color-mix(in srgb, var(--accent) 65%, transparent);
		}
	}
	.loc.focused .name,
	.loc.tap-focused .name {
		text-shadow:
			0 1px 8px rgba(0, 0, 0, 0.85),
			0 0 16px color-mix(in srgb, var(--accent) 65%, transparent);
	}
	.loc.selected .name {
		color: color-mix(in srgb, var(--accent) 75%, #fff);
	}
	.loc:focus-visible {
		outline: 2px solid #fff;
		outline-offset: 2px;
	}

	.name {
		font-family: var(--font-display);
		/* Cardinal titles read at the same weight as the Arcane Abyss hub title. */
		font-size: clamp(1.19rem, 1.88vw, 1.69rem);
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: #fff;
		line-height: 1.1;
		text-shadow: 0 1px 8px rgba(0, 0, 0, 0.85);
	}
	.rows {
		list-style: none;
		margin: 0.19rem 0 0;
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
		gap: 9px;
		padding: 6px 11px;
	}
	/* A thin divider between rows instead of a filled background per row. */
	.row + .row {
		border-top: 1px solid rgba(255, 255, 255, 0.14);
	}
	.icons {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.ico {
		width: 34px;
		height: 34px;
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
		font-size: 0.9rem;
		color: color-mix(in srgb, var(--accent) 45%, #fff 35%);
	}
	.or {
		margin: 0 -5px;
		font-size: 0.98rem;
		font-weight: 700;
		color: var(--color-whisper, #8d8aa1);
	}
	.arrow {
		color: var(--brand-amber, #ffba3d);
		font-size: 1.38rem;
		margin: 0 -9px;
	}
	.row-text {
		font-size: 1.13rem;
		color: var(--color-fog, #8d8aa1);
		line-height: 1.2;
	}

	/* Abyss core call-to-action — the monster's stats/lives/rewards now live on the
	   leaderboard boss card, so the centre just reads as the fight prompt. */
	.fight {
		font-family: var(--font-display);
		font-size: clamp(0.78rem, 1vw, 0.98rem);
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: #fff;
		text-align: center;
		line-height: 1.15;
		text-shadow:
			0 1px 8px rgba(0, 0, 0, 0.85),
			0 0 14px color-mix(in srgb, var(--accent) 60%, transparent);
	}
	.empty {
		font-size: 1rem;
		color: var(--color-whisper, #6a6680);
		line-height: 1.2;
	}

	.tokens {
		display: flex;
		gap: 5px;
		justify-content: center;
		flex-wrap: wrap;
		margin-top: 2px;
	}
	.tok {
		width: 15px;
		height: 15px;
		border-radius: 50%;
		box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
	}
	.tok.mine {
		box-shadow: 0 0 0 2px #fff;
	}

	/* ── Hub: the circular Arcane Abyss core at the centre of the compass ─────── */
	.loc.hub {
		aspect-ratio: 1;
		width: 100%;
		justify-content: center;
		gap: 0.3rem;
		padding: 1rem;
		border-radius: 50%;
		background: radial-gradient(circle at 50% 38%, rgba(60, 8, 36, 0.65) 0%, #0a0714 72%);
		box-shadow:
			0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent),
			0 0 0 6px rgba(10, 7, 20, 0.9),
			0 0 0 7px color-mix(in srgb, var(--accent) 30%, transparent),
			0 0 34px color-mix(in srgb, var(--accent) 28%, transparent),
			inset 0 0 40px rgba(0, 0, 0, 0.6);
	}
	@media (hover: hover) and (pointer: fine) {
		.loc.hub.selectable:hover {
			background: radial-gradient(circle at 50% 38%, rgba(80, 10, 48, 0.7) 0%, #0a0714 72%);
			transform: scale(1.03);
		}
	}
	.loc.hub.focused,
	.loc.hub.tap-focused {
		background: radial-gradient(circle at 50% 38%, rgba(80, 10, 48, 0.7) 0%, #0a0714 72%);
		transform: scale(1.03);
	}
	.loc.hub.selected {
		box-shadow:
			0 0 0 3px var(--accent),
			0 0 0 7px rgba(10, 7, 20, 0.9),
			0 0 46px color-mix(in srgb, var(--accent) 50%, transparent),
			inset 0 0 40px rgba(0, 0, 0, 0.6);
	}
	/* ── Touch / tap-target hardening ──────────────────────────────────────── */
	.loc.selectable {
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
	}

	/* Icon hit areas: native size is 34px — boost to ≥44px on touch so fingers land. */
	@media (pointer: coarse) {
		.ico {
			width: 44px;
			height: 44px;
		}
		.ico img {
			width: 34px;
			height: 34px;
		}
		/* Give the card itself a comfortable minimum tap height. */
		.loc.selectable {
			min-height: 44px;
		}
	}
</style>

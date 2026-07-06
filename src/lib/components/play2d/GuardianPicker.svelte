<script lang="ts">
	import { getGuardianAsset } from '$lib/stores/assetStore.svelte';
	import { playMenuSfx } from '$lib/stores/menuAudio.svelte';
	import { seatAccent } from './helpers';

	interface Props {
		open: boolean;
		title?: string;
		subtitle?: string;
		/** Guardian names to choose from (room.guardianPool). */
		guardians: string[];
		/** Guardian name → claiming seat colour (e.g. "Red") for OTHER seats. */
		takenBy?: Map<string, string>;
		/** Currently selected guardian for this seat. */
		current?: string | null;
		/** Seat accent colour. */
		accent?: string;
		onPick: (name: string) => void;
		onClose: () => void;
	}

	let {
		open,
		title = 'Choose your Guardian',
		subtitle = '',
		guardians,
		takenBy = new Map<string, string>(),
		current = null,
		accent = '#ff2bc7',
		onPick,
		onClose
	}: Props = $props();

	// Staged selection: tapping a tile previews it in the detail pane; only
	// Confirm commits (mobile-game character select, not click-to-commit).
	let selected = $state<string | null>(null);
	$effect(() => {
		if (open) selected = current ?? guardians.find((g) => !takenBy.has(g)) ?? null;
	});

	const detail = $derived(selected ? getGuardianAsset(selected) : null);
	const selectedTaken = $derived(!!selected && takenBy.has(selected));

	function art(name: string): string | null {
		const g = getGuardianAsset(name);
		// Use the character icon (fall back to chibi/mat only if it's missing).
		return g?.iconUrl ?? g?.chibiUrl ?? g?.matUrl ?? null;
	}
	function detailArt(name: string): string | null {
		const g = getGuardianAsset(name);
		return g?.chibiUrl ?? g?.iconUrl ?? g?.matUrl ?? null;
	}
	function originColor(name: string): string {
		return getGuardianAsset(name)?.origin?.color ?? accent;
	}

	function onKey(e: KeyboardEvent) {
		if (open && e.key === 'Escape') {
			playMenuSfx('ui-back');
			onClose();
		}
	}

	function choose(name: string) {
		if (takenBy.has(name)) return;
		playMenuSfx('ui-click');
		selected = name;
	}
	function confirm() {
		if (!selected || selectedTaken) return;
		playMenuSfx('game-start', { volume: 0.7 });
		onPick(selected);
	}
	function close() {
		playMenuSfx('ui-back');
		onClose();
	}
</script>

<svelte:window onkeydown={onKey} />

{#if open}
	<div
		class="select"
		style="--accent: {accent}"
		role="dialog"
		aria-modal="true"
		aria-label={title}
		data-testid="guardian-picker"
	>
		<header class="shead">
			<div class="shead-text">
				<div class="seyebrow">Character Select</div>
				<h2>{title}</h2>
				{#if subtitle}<p>{subtitle}</p>{/if}
			</div>
			<button
				class="close"
				type="button"
				onpointerenter={() => playMenuSfx('ui-hover', { volume: 0.4 })}
				onclick={close}
				aria-label="Close">✕</button
			>
		</header>

		<div class="body">
			<div class="grid" role="listbox" aria-label="Guardians">
				{#each guardians as name (name)}
					{@const src = art(name)}
					{@const takenSeat = takenBy.get(name)}
					{@const isTaken = !!takenSeat}
					{@const isSelected = name === selected}
					<button
						type="button"
						role="option"
						aria-selected={isSelected}
						class="tile"
						class:taken={isTaken}
						class:selected={isSelected}
						style="--oc: {originColor(name)}"
						data-testid="guardian-tile"
						disabled={isTaken}
						onpointerenter={() => !isTaken && playMenuSfx('ui-hover', { volume: 0.38 })}
						onclick={() => choose(name)}
					>
						<div class="tart">
							{#if src}
								<img src={src} alt={name} loading="lazy" />
							{:else}
								<span class="sigil" aria-hidden="true">
									<span class="sigil-gem"></span>
									<span class="sigil-ch">{name.slice(0, 1)}</span>
								</span>
							{/if}
							<div class="tart-fade"></div>
						</div>
						<div class="tmeta">
							<span class="tname">{name}</span>
						</div>
						{#if isTaken}
							<span class="taken-chip" style="--seat: {seatAccent(takenSeat)}">
								<span class="taken-dot" aria-hidden="true"></span>{takenSeat}
							</span>
						{:else if name === current}
							<div class="tick" title="Your current guardian">✓</div>
						{/if}
					</button>
				{/each}
			</div>

			<aside class="detail" aria-live="polite">
				{#if selected}
					{@const dsrc = detailArt(selected)}
					<div class="dart" style="--oc: {originColor(selected)}">
						{#if dsrc}
							<img src={dsrc} alt={selected} />
						{:else}
							<span class="sigil big" aria-hidden="true">
								<span class="sigil-gem"></span>
								<span class="sigil-ch">{selected.slice(0, 1)}</span>
							</span>
						{/if}
					</div>
					<h3 class="dname">{selected}</h3>
					{#if detail?.origin}
						<span class="dorigin" style="--oc: {detail.origin.color}">
							<span class="dorigin-gem" aria-hidden="true"></span>
							{detail.origin.name}
						</span>
						{#if detail.origin.description}
							<p class="dflavor">{detail.origin.description}</p>
						{/if}
					{/if}
					{#if selected === current}
						<span class="dstate">Bound to your seat</span>
					{/if}
				{:else}
					<p class="dempty">Pick a guardian to see their story.</p>
				{/if}
			</aside>
		</div>

		<footer class="sfoot">
			<button class="cancel" type="button" onclick={close}>Cancel</button>
			<button
				class="confirm"
				type="button"
				data-testid="guardian-confirm"
				disabled={!selected || selectedTaken}
				onclick={confirm}
			>
				{selected ? `Confirm ${selected}` : 'Confirm'}
				<svg viewBox="0 0 24 24" aria-hidden="true"
					><path
						d="M5 13l5 5L20 7"
						fill="none"
						stroke="currentColor"
						stroke-width="2.2"
						stroke-linecap="round"
						stroke-linejoin="round"
					/></svg
				>
			</button>
		</footer>
	</div>
{/if}

<style>
	/* Full-screen character-select scene (not a floating modal). */
	.select {
		position: fixed;
		inset: 0;
		z-index: 80;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		gap: clamp(10px, 2vh, 18px);
		padding:
			calc(clamp(14px, 3vh, 26px) + env(safe-area-inset-top))
			max(clamp(16px, 4vw, 44px), env(safe-area-inset-right))
			calc(clamp(12px, 2vh, 20px) + env(safe-area-inset-bottom))
			max(clamp(16px, 4vw, 44px), env(safe-area-inset-left));
		background:
			radial-gradient(ellipse 70% 50% at 50% -10%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 70%),
			linear-gradient(180deg, rgba(10, 6, 22, 0.94), rgba(5, 3, 16, 0.97));
		-webkit-backdrop-filter: blur(14px);
		backdrop-filter: blur(14px);
		color: var(--color-bone, #f5f0ff);
		animation: fade 220ms ease;
	}

	.shead {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}
	.seyebrow {
		font-family: var(--font-display);
		font-size: 0.66rem;
		letter-spacing: 0.32em;
		text-transform: uppercase;
		color: var(--brand-cyan, #24d4ff);
	}
	.shead h2 {
		margin: 6px 0 0;
		font-family: var(--font-display);
		font-size: clamp(1.5rem, 4.5vh, 2.4rem);
		line-height: 0.95;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: #fff;
	}
	.shead p {
		margin: 4px 0 0;
		color: var(--color-fog, #9a8fb8);
		font-size: 0.85rem;
	}
	.close {
		flex: 0 0 auto;
		width: 44px;
		height: 44px;
		border-radius: 999px;
		border: 1px solid var(--color-mist, #2e1d52);
		background: rgba(10, 7, 24, 0.5);
		color: var(--color-parchment, #d8cfee);
		font-size: 1rem;
		cursor: pointer;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
		transition:
			border-color 150ms ease,
			color 150ms ease;
	}
	@media (hover: hover) and (pointer: fine) {
		.close:hover {
			border-color: var(--brand-magenta, #ff2bc7);
			color: var(--brand-magenta-soft, #ff5dd1);
		}
	}
	.close:focus-visible {
		border-color: var(--brand-magenta, #ff2bc7);
		color: var(--brand-magenta-soft, #ff5dd1);
		outline: 2px solid var(--brand-magenta, #ff2bc7);
		outline-offset: 2px;
	}

	/* ── Grid + detail pane ───────────────────────────────────── */
	.body {
		flex: 1;
		min-height: 0;
		display: flex;
		gap: clamp(14px, 2.5vw, 28px);
	}
	.grid {
		flex: 1.5;
		min-width: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(128px, 1fr));
		grid-auto-rows: min-content;
		gap: 12px;
		overflow-y: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
		touch-action: pan-y;
		padding: 3px;
		scrollbar-width: thin;
	}

	.tile {
		position: relative;
		display: flex;
		flex-direction: column;
		padding: 0;
		border: 1px solid var(--color-mist, #2e1d52);
		border-radius: 14px;
		background: rgba(10, 7, 22, 0.6);
		overflow: hidden;
		cursor: pointer;
		text-align: left;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
		transition:
			transform 180ms cubic-bezier(0.2, 0.7, 0.2, 1),
			border-color 180ms ease,
			box-shadow 180ms ease;
	}
	@media (hover: hover) and (pointer: fine) {
		.tile:hover:not(:disabled) {
			transform: translateY(-4px);
			border-color: var(--oc);
			box-shadow: 0 18px 40px -18px var(--oc);
		}
	}
	.tile:focus-visible:not(:disabled) {
		border-color: var(--oc);
		box-shadow: 0 0 0 2px var(--oc);
		outline: none;
	}
	.tile.selected {
		border-color: var(--accent);
		box-shadow:
			0 0 0 2px var(--accent),
			0 16px 40px -18px var(--accent);
	}
	.tile.taken {
		cursor: not-allowed;
		opacity: 0.55;
		filter: grayscale(0.5);
	}

	.tart {
		position: relative;
		aspect-ratio: 1 / 1;
		display: grid;
		place-items: center;
		background:
			radial-gradient(
				ellipse at 50% 30%,
				color-mix(in srgb, var(--oc) 30%, transparent),
				transparent 70%
			),
			rgba(0, 0, 0, 0.35);
	}
	.tart img {
		width: 100%;
		height: 100%;
		/* Character icon — show it whole on the radial-glow backdrop (vs. the mat). */
		object-fit: contain;
		padding: 8%;
		filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.55));
	}
	.tart-fade {
		position: absolute;
		inset: 0;
		background: linear-gradient(180deg, transparent 55%, rgba(8, 5, 18, 0.92) 100%);
		pointer-events: none;
	}
	.tmeta {
		display: flex;
		align-items: center;
		padding: 9px 11px 11px;
	}
	.tname {
		font-family: var(--font-display);
		font-size: 0.88rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: #fff;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* Taken → the claiming seat's colour chip (who has them, not just "no"). */
	.taken-chip {
		position: absolute;
		top: 7px;
		right: 7px;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 3px 8px;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--seat) 75%, transparent);
		background: rgba(5, 3, 16, 0.72);
		color: color-mix(in srgb, var(--seat) 85%, #fff);
		font-family: var(--font-display);
		font-size: 0.56rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}
	.taken-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--seat);
		box-shadow: 0 0 8px var(--seat);
	}
	.tick {
		position: absolute;
		top: 7px;
		right: 7px;
		width: 24px;
		height: 24px;
		display: grid;
		place-items: center;
		border-radius: 999px;
		background: var(--accent);
		color: #07040f;
		font-size: 0.8rem;
		box-shadow: 0 0 14px var(--accent);
	}

	/* Missing art → designed sigil placeholder (shared with the lobby frames). */
	.sigil {
		position: relative;
		width: 100%;
		height: 100%;
		display: grid;
		place-items: center;
	}
	.sigil-gem {
		position: absolute;
		width: 36%;
		aspect-ratio: 1;
		transform: rotate(45deg);
		border: 1.5px solid color-mix(in srgb, var(--oc) 70%, transparent);
		background: color-mix(in srgb, var(--oc) 14%, transparent);
		box-shadow: 0 0 22px -4px color-mix(in srgb, var(--oc) 60%, transparent);
	}
	.sigil-ch {
		position: relative;
		font-family: var(--font-display);
		font-size: 1.9rem;
		color: var(--color-bone, #f5f0ff);
		text-transform: uppercase;
	}
	.sigil.big .sigil-ch {
		font-size: 3rem;
	}

	/* ── Detail pane ──────────────────────────────────────────── */
	.detail {
		flex: 1;
		min-width: 0;
		max-width: 380px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: clamp(14px, 2.5vh, 22px);
		border-radius: 18px;
		border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--color-mist, #2e1d52));
		background: linear-gradient(180deg, rgba(26, 15, 46, 0.66), rgba(8, 5, 18, 0.8));
		overflow-y: auto;
		scrollbar-width: thin;
	}
	.dart {
		position: relative;
		width: 100%;
		aspect-ratio: 1 / 1;
		max-height: 42vh;
		display: grid;
		place-items: center;
		border-radius: 14px;
		background:
			radial-gradient(
				ellipse at 50% 35%,
				color-mix(in srgb, var(--oc) 32%, transparent),
				transparent 72%
			),
			rgba(0, 0, 0, 0.3);
		overflow: hidden;
	}
	.dart img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		padding: 6%;
		filter: drop-shadow(0 10px 24px rgba(0, 0, 0, 0.6));
	}
	.dname {
		margin: 2px 0 0;
		font-family: var(--font-display);
		font-size: clamp(1.3rem, 3.4vh, 1.8rem);
		line-height: 1;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: #fff;
	}
	.dorigin {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		align-self: flex-start;
		padding: 5px 12px;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--oc) 60%, transparent);
		background: color-mix(in srgb, var(--oc) 12%, transparent);
		color: color-mix(in srgb, var(--oc) 80%, #fff);
		font-family: var(--font-display);
		font-size: 0.66rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
	}
	.dorigin-gem {
		width: 8px;
		height: 8px;
		transform: rotate(45deg);
		background: var(--oc);
		box-shadow: 0 0 10px var(--oc);
	}
	.dflavor {
		margin: 0;
		font-family: var(--font-body);
		font-size: 0.86rem;
		line-height: 1.55;
		color: var(--color-parchment, #d8cfee);
	}
	.dstate {
		font-family: var(--font-display);
		font-size: 0.64rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--brand-teal, #20e0c1);
	}
	.dempty {
		margin: auto;
		font-family: var(--font-body);
		font-size: 0.9rem;
		color: var(--color-fog, #9a8fb8);
		text-align: center;
	}

	/* ── Footer: Cancel · Confirm ─────────────────────────────── */
	.sfoot {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 12px;
	}
	.cancel {
		min-height: 50px;
		padding: 12px 22px;
		border-radius: 12px;
		border: 1px solid var(--color-aether, #3a2670);
		background: transparent;
		color: var(--color-parchment, #d8cfee);
		font-family: var(--font-display);
		font-size: 0.74rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		transition:
			border-color 150ms ease,
			color 150ms ease;
	}
	.cancel:hover {
		border-color: var(--brand-magenta, #ff2bc7);
		color: #fff;
	}
	.confirm {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		min-height: 50px;
		max-width: 70vw;
		padding: 12px 26px;
		border: none;
		border-radius: 12px;
		background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 45%, #7b1dff));
		color: #fff;
		font-family: var(--font-display);
		font-size: 0.88rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		cursor: pointer;
		box-shadow: 0 14px 34px -14px var(--accent);
		transition: filter 150ms ease;
	}
	.confirm svg {
		flex: 0 0 auto;
		width: 18px;
		height: 18px;
	}
	.confirm:hover:not(:disabled) {
		filter: brightness(1.12);
	}
	.confirm:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	@keyframes fade {
		from {
			opacity: 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.select {
			animation: none;
		}
		.tile {
			transition: none;
		}
	}

	/* ── Portrait phones: grid on top, detail as a compact strip, sticky footer. ── */
	@media (max-width: 640px) and (orientation: portrait) {
		.body {
			flex-direction: column;
		}
		.grid {
			grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
			gap: 9px;
		}
		.detail {
			flex: 0 0 auto;
			max-width: none;
			flex-direction: row;
			align-items: center;
			gap: 12px;
			padding: 12px;
			overflow: visible;
		}
		.dart {
			flex: 0 0 92px;
			width: 92px;
			aspect-ratio: 1 / 1;
			border-radius: 12px;
		}
		.detail > .dname,
		.detail > .dorigin,
		.detail > .dflavor,
		.detail > .dstate,
		.detail > .dempty {
			margin: 0;
		}
		/* Stack the text bits beside the art. */
		.detail {
			display: grid;
			grid-template-columns: 92px minmax(0, 1fr);
			grid-auto-rows: min-content;
			align-items: start;
			column-gap: 12px;
			row-gap: 4px;
		}
		.dart {
			grid-row: 1 / span 4;
		}
		.dflavor {
			display: -webkit-box;
			-webkit-line-clamp: 2;
			line-clamp: 2;
			-webkit-box-orient: vertical;
			overflow: hidden;
			font-size: 0.78rem;
			line-height: 1.4;
		}
		.confirm {
			flex: 1;
			justify-content: center;
			max-width: none;
		}
	}

	/* ── Short landscape (phones): tighter chrome, detail narrower. ── */
	@media (orientation: landscape) and (max-height: 520px) {
		.shead h2 {
			font-size: clamp(1.15rem, 7vh, 1.6rem);
		}
		.shead p {
			font-size: 0.76rem;
		}
		.close {
			width: 40px;
			height: 40px;
		}
		.grid {
			grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
			gap: 9px;
		}
		.tmeta {
			padding: 7px 9px 8px;
		}
		.tname {
			font-size: 0.7rem;
		}
		.detail {
			max-width: 300px;
			gap: 7px;
		}
		.dart {
			max-height: 30vh;
			aspect-ratio: auto;
			min-height: 110px;
		}
		.dflavor {
			font-size: 0.76rem;
			line-height: 1.4;
		}
		.cancel,
		.confirm {
			min-height: 44px;
			padding-block: 9px;
		}
	}
</style>

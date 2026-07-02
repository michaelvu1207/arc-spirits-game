<script lang="ts">
	import type { getAssetState } from '$lib/stores/assetStore.svelte';
	import type { SpectatorProjection, SeatColor, NavigationDestination } from '$lib/play/types';
	import { ALL_DESTINATIONS } from '$lib/play/types';
	import { LOCATION_ACCENT } from '$lib/play/locations';
	import { seatAccent, storageUrl } from './helpers';

	interface Props {
		room: SpectatorProjection;
		assets: ReturnType<typeof getAssetState>;
		onClose: () => void;
		/** Auto-dismiss after this many ms (0 disables the timer). */
		autoCloseMs?: number;
		/** Occupancy frozen at the reveal instant. Falls back to the live room value so
		 *  the overlay shows who-went-where even if the room advances underneath it. */
		occupancy?: SpectatorProjection['locationOccupancy'];
	}

	let { room, assets, onClose, autoCloseMs = 6000, occupancy }: Props = $props();
	const occ = $derived(occupancy ?? room.locationOccupancy);

	type Traveler = { seat: SeatColor; name: string; icon: string | null; accent: string };

	// One column per destination (4 Spirit World + Arcane Abyss), each listing the
	// players who revealed it. Occupancy is already computed server-side on reveal.
	const columns = $derived.by(() =>
		ALL_DESTINATIONS.map((dest) => {
			const seats = (occ[dest] ?? []) as SeatColor[];
			const travelers: Traveler[] = seats.map((seat) => {
				const guardian =
					room.players[seat]?.selectedGuardian ?? room.seats[seat]?.selectedGuardian ?? '';
				return {
					seat,
					name: room.seats[seat]?.displayName ?? seat,
					icon: storageUrl(assets.guardianAssets.get(guardian)?.icon_image_path ?? null),
					accent: seatAccent(seat)
				};
			});
			return { dest, accent: LOCATION_ACCENT[dest] ?? '#8d8aa1', travelers };
		})
	);

	// Auto-dismiss after a beat so the reveal doesn't block the next phase.
	$effect(() => {
		if (!autoCloseMs) return;
		const timer = setTimeout(onClose, autoCloseMs);
		return () => clearTimeout(timer);
	});

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose();
	}
</script>

<svelte:window on:keydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="scrim" role="dialog" aria-label="Destinations revealed" data-testid="destination-reveal">
	<button type="button" class="backdrop" aria-label="Dismiss" onclick={() => onClose()}></button>
	<div class="panel" data-testid="destination-reveal-panel">
		<header class="head">
			<span class="eyebrow">Navigation</span>
			<h2 class="title">Destinations Revealed</h2>
		</header>

		<div class="grid" data-testid="destination-reveal-grid">
			{#each columns as col, i (col.dest)}
				<section class="dest" style="--accent: {col.accent}; --i: {i}">
					<span class="dest-name">{col.dest}</span>
					<div class="travelers">
						{#each col.travelers as t (t.seat)}
							<div class="traveler" style="--seat: {t.accent}" title={t.name}>
								<span class="avatar">
									{#if t.icon}
										<img src={t.icon} alt={t.name} loading="lazy" />
									{:else}
										<span class="fallback">{t.name.slice(0, 1)}</span>
									{/if}
								</span>
								<span class="tname">{t.name}</span>
							</div>
						{:else}
							<span class="empty">— no one —</span>
						{/each}
					</div>
				</section>
			{/each}
		</div>
	</div>
</div>

<style>
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: grid;
		place-items: center;
		padding: 2rem;
		background: radial-gradient(
			ellipse at center,
			rgba(5, 3, 16, 0.72),
			rgba(5, 3, 16, 0.92)
		);
		backdrop-filter: blur(6px);
		animation: scrim-in 220ms ease-out;
	}
	.backdrop {
		position: fixed;
		inset: 0;
		border: 0;
		background: none;
		cursor: pointer;
	}
	.panel {
		position: relative;
		z-index: 1;
		width: min(1100px, 94vw);
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		pointer-events: none;
	}
	.head {
		text-align: center;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.eyebrow {
		font-family: var(--font-display);
		font-size: 0.9rem;
		letter-spacing: 0.34em;
		text-transform: uppercase;
		color: var(--brand-cyan, #24d4ff);
	}
	.title {
		margin: 0;
		font-family: var(--font-display);
		font-size: 2.4rem;
		letter-spacing: 0.06em;
		color: #fff;
		text-shadow: 0 0 24px rgba(123, 29, 255, 0.55);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(5, 1fr);
		gap: 0.85rem;
	}
	.dest {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		min-height: 9rem;
		padding: 0.9rem 0.75rem;
		border-radius: 8px;
		background: color-mix(in srgb, var(--accent) 12%, rgba(10, 7, 24, 0.92));
		border-top: 3px solid var(--accent);
		box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
		/* Staggered reveal, one column after another. */
		animation: col-in 360ms cubic-bezier(0.2, 0.8, 0.2, 1) backwards;
		animation-delay: calc(var(--i) * 70ms);
	}
	.dest-name {
		font-family: var(--font-display);
		font-size: 1.05rem;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--accent);
		text-align: center;
	}
	.travelers {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-height: 0;
	}
	.traveler {
		display: flex;
		align-items: center;
		gap: 0.55rem;
	}
	.avatar {
		flex: 0 0 auto;
		width: 34px;
		height: 34px;
		border-radius: 50%;
		overflow: hidden;
		display: grid;
		place-items: center;
		background: var(--color-crypt, #1a0f2e);
		box-shadow: 0 0 0 2px var(--seat);
	}
	.avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.fallback {
		font-family: var(--font-display);
		color: #fff;
		font-size: 1rem;
	}
	.tname {
		font-family: var(--font-display);
		font-size: 0.95rem;
		letter-spacing: 0.03em;
		color: var(--color-bone, #f5f0ff);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.empty {
		font-size: 0.8rem;
		font-style: italic;
		color: var(--color-whisper, #6a5d8a);
	}
	/* Phone: use a plain list instead of big reveal cards. The destination reveal
	   happens during a busy board state, so legibility beats spectacle here. */
	@media (max-width: 760px), (max-height: 620px) {
		.scrim {
			place-items: center;
			overflow-y: auto;
			padding: calc(0.85rem + env(safe-area-inset-top, 0px)) 1rem
				calc(0.85rem + env(safe-area-inset-bottom, 0px));
			background: rgba(5, 3, 16, 0.86);
			backdrop-filter: blur(4px);
			-webkit-backdrop-filter: blur(4px);
		}
		.panel {
			width: min(34rem, 100%);
			gap: 0.75rem;
			pointer-events: none;
		}
		.head {
			gap: 0.15rem;
		}
		.eyebrow,
		.title,
		.dest-name,
		.tname,
		.empty {
			color: #fff;
			text-shadow: none;
		}
		.eyebrow {
			font-size: 0.68rem;
			letter-spacing: 0.28em;
			opacity: 1;
		}
		.title {
			font-size: clamp(1.15rem, 7vw, 1.75rem);
			letter-spacing: 0.08em;
		}
		.grid {
			display: flex;
			flex-direction: column;
			gap: 0;
			width: 100%;
			border-top: 1px solid rgba(255, 255, 255, 0.28);
			border-bottom: 1px solid rgba(255, 255, 255, 0.28);
		}
		.dest {
			display: grid;
			grid-template-columns: minmax(7.5rem, 0.9fr) minmax(0, 1.1fr);
			align-items: center;
			gap: 0.75rem;
			min-height: auto;
			padding: 0.65rem 0;
			border: 0;
			border-radius: 0;
			border-bottom: 1px solid rgba(255, 255, 255, 0.2);
			background: transparent;
			box-shadow: none;
			animation: none;
		}
		.dest:last-child {
			border-bottom: 0;
		}
		.dest-name {
			font-size: 0.82rem;
			letter-spacing: 0.1em;
			text-align: left;
			line-height: 1.15;
		}
		.travelers {
			display: flex;
			flex-direction: row;
			flex-wrap: wrap;
			justify-content: flex-end;
			align-items: center;
			gap: 0.25rem 0.45rem;
			min-width: 0;
		}
		.traveler {
			display: inline-flex;
			min-width: 0;
			gap: 0;
		}
		.avatar {
			display: none;
		}
		.tname {
			max-width: 9rem;
			font-size: 0.78rem;
			letter-spacing: 0.04em;
			line-height: 1.2;
			opacity: 1;
		}
		.empty {
			font-size: 0.72rem;
			font-style: normal;
			opacity: 1;
		}
	}
	@keyframes scrim-in {
		from {
			opacity: 0;
		}
	}
	@keyframes col-in {
		from {
			opacity: 0;
			transform: translateY(12px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.scrim,
		.dest {
			animation: none;
		}
	}
</style>

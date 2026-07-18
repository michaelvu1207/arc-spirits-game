<script lang="ts">
	import { goto } from '$app/navigation';
	import { auth } from '$lib/auth/auth.svelte';
	import { fetchMy2DRating, type Rating2DRow } from '$lib/supabase';
	import { getCosmeticsState } from '$lib/stores/cosmetics.svelte';
	import { playMenuSfx } from '$lib/stores/menuAudio.svelte';
	import GameIcon from '$lib/components/GameIcon.svelte';
	import StatCell from './screens/StatCell.svelte';
	import MatchHistoryOverlay from './MatchHistoryOverlay.svelte';

	let open = $state(false);
	let showHistory = $state(false);
	let busy = $state(false);

	// Inline display-name editing.
	let editingName = $state(false);
	let nameDraft = $state('');
	let nameError = $state<string | null>(null);

	// Lazily-loaded ranked rating for the signed-in user.
	let rating = $state<Rating2DRow | null>(null);
	let ratingLoaded = $state(false);

	const cosmetics = getCosmeticsState();
	const displayName = $derived(auth.displayName ?? 'Nameless Spirit');
	const initial = $derived((auth.displayName ?? '?').slice(0, 1).toUpperCase());
	const userId = $derived(auth.user?.id ?? null);

	const hover = () => playMenuSfx('ui-hover', { volume: 0.4 });
	const click = () => playMenuSfx('ui-click');

	// (Re)load the rating whenever the popover opens for a signed-in user.
	$effect(() => {
		if (!open || !userId) return;
		ratingLoaded = false;
		let cancelled = false;
		fetchMy2DRating(userId)
			.then((r) => {
				if (!cancelled) rating = r;
			})
			.catch(() => {
				if (!cancelled) rating = null;
			})
			.finally(() => {
				if (!cancelled) ratingLoaded = true;
			});
		return () => {
			cancelled = true;
		};
	});

	function toggle() {
		open = !open;
		playMenuSfx(open ? 'ui-click' : 'ui-back');
		if (!open) editingName = false;
	}

	function close() {
		if (open) playMenuSfx('ui-back');
		open = false;
		editingName = false;
	}

	function startEdit() {
		nameDraft = auth.displayName ?? '';
		nameError = null;
		editingName = true;
		click();
	}

	async function saveName(e: SubmitEvent) {
		e.preventDefault();
		if (busy) return;
		busy = true;
		nameError = null;
		try {
			await auth.updateDisplayName(nameDraft);
			editingName = false;
		} catch (err) {
			nameError = err instanceof Error ? err.message : 'Could not save name.';
		} finally {
			busy = false;
		}
	}

	async function signOut() {
		if (busy) return;
		busy = true;
		try {
			await auth.signOut();
			close();
		} finally {
			busy = false;
		}
	}

	function openHistory() {
		click();
		showHistory = true;
		open = false;
	}

	function goAccount() {
		click();
		goto('/account');
	}

	function goRecords() {
		click();
		goto('/play/records');
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape' && open) close();
	}}
/>

<div class="dock">
	{#if open}
		<!-- Click-away catcher (under the popover, over the page). -->
		<button class="catch" type="button" aria-label="Close profile menu" onclick={close}></button>

		<div class="pop" role="dialog" aria-label="Your profile">
			{#if auth.isSignedIn}
				<header class="pop-head">
					<span class="avatar lg" aria-hidden="true">{initial}</span>
					<div class="who">
						<div class="eyebrow">{auth.isAnonymous ? 'Guest Spirit' : 'Spirit'}</div>
						{#if editingName}
							<form class="name-form" onsubmit={saveName}>
								<input
									bind:value={nameDraft}
									maxlength="40"
									placeholder="Display name"
									aria-label="Display name"
									disabled={busy}
								/>
								<div class="name-actions">
									<button class="btn-primary sm" type="submit" disabled={busy}>Save</button>
									<button
										class="btn-ghost sm"
										type="button"
										onclick={() => (editingName = false)}
										disabled={busy}
									>
										Cancel
									</button>
								</div>
								{#if nameError}<span class="name-err">{nameError}</span>{/if}
							</form>
						{:else}
							<button class="name-btn" type="button" onclick={startEdit} title="Edit display name">
								<span class="name">{displayName}</span>
								<span class="pencil" aria-hidden="true">✎</span>
							</button>
							<div class="who-sub">
								{#if auth.isAnonymous}
									<span class="tag guest">Guest account</span>
								{:else}
									<span class="tag real">{auth.email ?? 'Account'}</span>
								{/if}
							</div>
						{/if}
					</div>
				</header>

				<div class="stats">
					<div class="wallet-stat">
						<div>
							<span>{cosmetics.rank.name}</span>
							<small>{cosmetics.progression.credits} Credits</small>
						</div>
					</div>
					{#if !ratingLoaded}
						<p class="stats-muted">Reading the aether…</p>
					{:else if rating}
						<StatCell
							value={Math.round(rating.ordinal)}
							label="Rating"
							size="sm"
							accent="var(--brand-cyan)"
						/>
						<span class="s-div" aria-hidden="true"></span>
						<StatCell value={rating.gamesPlayed} label="Ranked Games" size="sm" />
					{:else}
						<p class="stats-muted">Unranked — play a ranked match to earn your rating.</p>
					{/if}
				</div>

				<nav class="actions" aria-label="Profile actions">
					<button class="act" type="button" onclick={openHistory} onpointerenter={hover}>
						<span class="gem" aria-hidden="true"></span>
						<span class="lbl">Past Games</span>
						<span class="go" aria-hidden="true">→</span>
					</button>
					<button class="act" type="button" onclick={goRecords} onpointerenter={hover}>
						<span class="gem" aria-hidden="true"></span>
						<span class="lbl">Game Records</span>
						<span class="go" aria-hidden="true">→</span>
					</button>
					<button class="act" type="button" onclick={goAccount} onpointerenter={hover}>
						<span class="gem" aria-hidden="true"></span>
						<span class="lbl">{auth.isAnonymous ? 'Claim Account' : 'Account Settings'}</span>
						<span class="go" aria-hidden="true">→</span>
					</button>
					<button
						class="act danger"
						type="button"
						onclick={signOut}
						onpointerenter={hover}
						disabled={busy}
					>
						<span class="gem" aria-hidden="true"></span>
						<span class="lbl">Sign Out</span>
						<span class="go" aria-hidden="true">→</span>
					</button>
				</nav>
			{:else}
				<header class="pop-head solo">
					<div class="who">
						<div class="eyebrow">Spirit Unknown</div>
						<div class="name">Not signed in</div>
					</div>
				</header>
				<p class="signed-out-lead">
					Sign in to save your stats and climb the ranked ladder — or jump straight in as a guest.
				</p>
				<button class="btn-primary block" type="button" onclick={goAccount} onpointerenter={hover}>
					Sign in / Create account
				</button>
			{/if}
		</div>
	{/if}

	<button
		class="chip"
		class:active={open}
		type="button"
		onclick={toggle}
		onpointerenter={hover}
		aria-haspopup="dialog"
		aria-expanded={open}
		data-testid="profile-dock"
	>
		{#if auth.isSignedIn}
			<span class="avatar" aria-hidden="true">{initial}</span>
			<span class="chip-text">
				<span class="chip-name">{displayName}</span>
				<span class="chip-sub">{auth.isAnonymous ? 'Guest' : 'Profile'}</span>
			</span>
		{:else}
			<span class="avatar ghost" aria-hidden="true"><GameIcon name="account" size={30} /></span>
			<span class="chip-text">
				<span class="chip-name">Sign In</span>
				<span class="chip-sub">Profile</span>
			</span>
		{/if}
		<span class="chip-chevron" class:up={open} aria-hidden="true">▾</span>
	</button>
</div>

{#if showHistory && userId}
	<MatchHistoryOverlay
		{userId}
		displayName={auth.displayName}
		onClose={() => (showHistory = false)}
	/>
{/if}

<style>
	/* Docked top-left (mobile-game identity chip). The popover opens BELOW the
	   chip: column-reverse keeps the chip — last in DOM — visually first. */
	.dock {
		position: fixed;
		left: max(20px, env(safe-area-inset-left));
		top: max(20px, env(safe-area-inset-top));
		z-index: 9500;
		display: flex;
		flex-direction: column-reverse;
		align-items: flex-start;
		gap: 12px;
	}

	.catch {
		position: fixed;
		inset: 0;
		z-index: -1;
		background: transparent;
		border: none;
		cursor: default;
	}

	/* ── Persistent chip ─────────────────────────────────── */
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 11px;
		padding: 8px 14px 8px 8px;
		border-radius: 999px;
		border: 1px solid var(--color-aether);
		background: linear-gradient(180deg, rgba(26, 15, 44, 0.86), rgba(10, 6, 20, 0.9));
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		color: var(--color-bone);
		cursor: pointer;
		box-shadow: 0 16px 44px -20px rgba(0, 0, 0, 0.9);
		transition:
			border-color 180ms ease,
			transform 180ms ease;
	}
	.chip:hover,
	.chip.active {
		border-color: var(--brand-magenta);
		transform: translateY(-1px);
	}
	.avatar {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		flex: none;
		border-radius: 50%;
		background: var(--gradient-flame);
		color: #fff;
		font-family: var(--font-display);
		font-size: 1.05rem;
		line-height: 1;
		box-shadow: 0 0 14px -2px rgba(255, 43, 199, 0.55);
	}
	.avatar.ghost {
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid var(--color-aether);
		color: var(--color-fog);
		box-shadow: none;
	}
	.avatar.lg {
		width: 50px;
		height: 50px;
		font-size: 1.45rem;
	}
	.chip-text {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		line-height: 1.15;
		min-width: 0;
	}
	.avatar.ghost {
		width: 38px;
		height: 38px;
		background: none;
		color: #24d4ff;
		clip-path: none;
	}
	.chip-name {
		font-family: var(--font-display);
		font-size: 0.95rem;
		letter-spacing: 0.04em;
		max-width: 150px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chip-sub {
		font-family: var(--font-display);
		font-size: 0.6rem;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--color-fog);
	}
	.chip-chevron {
		margin-left: 2px;
		font-size: 0.7rem;
		color: var(--brand-magenta-soft);
		transition: transform 200ms ease;
	}
	.chip-chevron.up {
		transform: rotate(180deg);
	}

	/* ── Popover (mirrors DetailOverlay chrome) ──────────── */
	.pop {
		width: min(316px, calc(100vw - 40px));
		border-radius: 16px;
		border: 1px solid var(--color-aether);
		background: linear-gradient(180deg, rgba(20, 12, 36, 0.98), rgba(10, 6, 20, 0.99));
		backdrop-filter: blur(14px);
		-webkit-backdrop-filter: blur(14px);
		box-shadow:
			0 30px 90px -24px rgba(0, 0, 0, 0.85),
			0 0 0 1px rgba(123, 29, 255, 0.12);
		overflow: hidden;
		animation: pop-in 200ms cubic-bezier(0.2, 0.9, 0.3, 1.2) both;
	}
	@keyframes pop-in {
		from {
			opacity: 0;
			transform: translateY(10px) scale(0.985);
		}
	}

	.pop-head {
		display: flex;
		gap: 13px;
		align-items: flex-start;
		padding: 18px 18px 16px;
		border-bottom: 1px solid var(--color-mist);
		background: linear-gradient(180deg, rgba(123, 29, 255, 0.1), transparent);
	}
	.pop-head.solo {
		padding-bottom: 14px;
	}
	.who {
		flex: 1;
		min-width: 0;
	}
	.eyebrow {
		font-family: var(--font-display);
		font-size: 0.62rem;
		letter-spacing: 0.3em;
		text-transform: uppercase;
		color: var(--brand-cyan);
		margin-bottom: 5px;
	}
	.name-btn {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		background: none;
		border: none;
		padding: 0;
		color: var(--color-bone);
		cursor: pointer;
		max-width: 100%;
	}
	.name {
		font-family: var(--font-display);
		font-size: 1.15rem;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pencil {
		font-size: 0.72rem;
		color: var(--color-fog);
		opacity: 0;
		transition: opacity 150ms ease;
	}
	.name-btn:hover .pencil {
		opacity: 1;
	}
	.who-sub {
		margin-top: 6px;
	}
	.tag {
		font-family: var(--font-mono);
		font-size: 0.66rem;
		letter-spacing: 0.04em;
		padding: 2px 8px;
		border-radius: 4px;
		display: inline-block;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		vertical-align: bottom;
	}
	.tag.guest {
		background: rgba(36, 212, 255, 0.16);
		color: var(--brand-cyan);
	}
	.tag.real {
		background: rgba(32, 224, 193, 0.14);
		color: var(--brand-teal);
	}

	.name-form {
		display: flex;
		flex-direction: column;
		gap: 9px;
	}
	.name-form input {
		width: 100%;
		padding: 9px 11px;
		border-radius: 8px;
		border: 1px solid var(--color-mist);
		background: rgba(8, 5, 16, 0.7);
		color: var(--color-bone);
		font: inherit;
		font-size: 0.9rem;
	}
	.name-form input:focus {
		outline: none;
		border-color: var(--brand-magenta);
	}
	.name-actions {
		display: flex;
		gap: 8px;
	}
	/* Compact variants of the global button styles for the inline name editor. */
	.btn-primary.sm,
	.btn-ghost.sm {
		padding: 7px 14px;
		font-size: 0.62rem;
	}
	.name-err {
		font-size: 0.74rem;
		color: var(--brand-magenta-soft);
	}

	/* ── Stats ───────────────────────────────────────────── */
	.stats {
		display: flex;
		align-items: stretch;
		gap: 22px;
		padding: 16px 18px;
		border-bottom: 1px solid var(--color-mist);
	}
	.wallet-stat {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 84px;
	}
	.wallet-stat span {
		display: block;
		font-family: var(--font-display);
		font-size: 0.88rem;
		line-height: 1;
		color: var(--color-bone);
		text-transform: uppercase;
	}
	.wallet-stat small {
		display: block;
		margin-top: 3px;
		font-family: var(--font-mono);
		font-size: 0.62rem;
		color: var(--color-fog);
		text-transform: uppercase;
		white-space: nowrap;
	}
	.s-div {
		width: 1px;
		align-self: stretch;
		min-height: 30px;
		background: var(--color-mist);
	}
	.stats-muted {
		margin: 0;
		font-family: var(--font-body);
		font-size: 0.8rem;
		line-height: 1.5;
		color: var(--color-fog);
	}

	/* ── Actions (mirrors the play-menu rows) ─────────────── */
	.actions {
		display: flex;
		flex-direction: column;
		padding: 8px;
	}
	.act {
		position: relative;
		display: flex;
		align-items: center;
		gap: 13px;
		width: 100%;
		padding: 12px 10px;
		background: none;
		border: none;
		text-align: left;
		cursor: pointer;
		color: var(--color-parchment);
		transition: color 180ms ease;
	}
	.act::after {
		content: '';
		position: absolute;
		left: 10px;
		right: 10px;
		bottom: 4px;
		height: 1px;
		background: var(--gradient-spectrum);
		transform: scaleX(0);
		transform-origin: left;
		opacity: 0.75;
		transition: transform 240ms ease;
	}
	.act:hover,
	.act:focus-visible {
		color: #fff;
		outline: none;
	}
	.act:hover::after,
	.act:focus-visible::after {
		transform: scaleX(1);
	}
	.act.danger:hover,
	.act.danger:focus-visible {
		color: var(--brand-magenta-soft);
	}
	.act:disabled {
		opacity: 0.55;
		cursor: progress;
	}
	.gem {
		flex: 0 0 auto;
		width: 10px;
		height: 10px;
		transform: rotate(45deg);
		border: 1px solid var(--color-aether);
		transition:
			background 200ms ease,
			border-color 200ms ease,
			box-shadow 200ms ease;
	}
	.act:hover .gem,
	.act:focus-visible .gem {
		background: var(--gradient-flame);
		border-color: transparent;
		box-shadow: 0 0 10px rgba(255, 43, 199, 0.65);
	}
	.act .lbl {
		flex: 1;
		font-family: var(--font-display);
		font-size: 0.92rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		line-height: 1;
	}
	.act .go {
		flex: 0 0 auto;
		font-family: var(--font-display);
		font-size: 0.95rem;
		color: var(--brand-magenta-soft);
		opacity: 0;
		transform: translateX(-6px);
		transition:
			opacity 200ms ease,
			transform 200ms ease;
	}
	.act:hover .go,
	.act:focus-visible .go {
		opacity: 1;
		transform: translateX(0);
	}

	/* ── Signed out ──────────────────────────────────────── */
	.signed-out-lead {
		margin: 0;
		padding: 16px 18px 4px;
		font-family: var(--font-body);
		font-size: 0.84rem;
		line-height: 1.55;
		color: var(--color-fog);
	}
	.btn-primary.block {
		display: flex;
		width: calc(100% - 36px);
		margin: 14px 18px 18px;
	}

	/* ── Mobile: compact chip top-left (clear of the shell's top-right controls);
	   the popover takes most of the width below it. ───────── */
	@media (max-width: 560px) {
		.dock {
			left: max(12px, env(safe-area-inset-left));
			top: max(12px, env(safe-area-inset-top));
		}
		.chip {
			border-radius: 14px;
		}
		.pop {
			width: min(92vw, 340px);
		}
		.chip-name {
			max-width: 118px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.pop {
			animation: none;
		}
		.chip,
		.act,
		.act::after,
		.gem,
		.go {
			transition: none;
		}
	}

	/* Profile as an identity blade, not a pill or popover card. */
	.chip,
	.chip:hover,
	.chip.active {
		min-width: 210px;
		padding: 7px 26px 7px 8px;
		border: 0;
		border-radius: 0;
		background: #160a34;
		box-shadow: none;
		backdrop-filter: none;
		transform: none;
		clip-path: polygon(0 0, calc(100% - 24px) 0, 100% 50%, calc(100% - 24px) 100%, 0 100%);
	}
	.chip::after {
		content: '';
		position: absolute;
		left: 0;
		bottom: 0;
		width: 72%;
		height: 4px;
		background: #24d4ff;
	}
	.chip.active::after,
	.chip:hover::after {
		background: #ff2bc7;
	}
	.avatar,
	.avatar.ghost {
		border: 0;
		border-radius: 0;
		background: #d515aa;
		box-shadow: none;
		clip-path: polygon(25% 5%, 75% 5%, 100% 50%, 75% 95%, 25% 95%, 0 50%);
	}
	.avatar.ghost {
		background: #2b1260;
		color: #24d4ff;
	}
	.pop {
		width: min(370px, calc(100vw - 40px));
		border: 0;
		border-radius: 0;
		background: #0d061f;
		box-shadow: none;
		backdrop-filter: none;
		clip-path: polygon(0 0, 92% 0, 100% 7%, 100% 93%, 88% 100%, 0 100%);
	}
	.pop-head {
		border: 0;
		background: #43178f;
		clip-path: polygon(0 0, 100% 0, 92% 100%, 0 100%);
	}
	.tag {
		border-radius: 0;
		background: #170a35 !important;
	}
	.name-form input {
		border: 0;
		border-bottom: 3px solid #24d4ff;
		border-radius: 0;
		background: #110829;
	}
	.stats {
		border: 0;
		background: #150b34;
	}
	.actions {
		gap: 2px;
		padding: 6px 0 0;
	}
	.act {
		padding: 13px 24px 13px 18px;
		background: #1d0d45;
		clip-path: polygon(0 0, 96% 0, 100% 50%, 96% 100%, 0 100%);
	}
	.act:nth-child(even) {
		width: 94%;
		background: #27115b;
	}
	.act::after {
		display: none;
	}
	.act:hover,
	.act:focus-visible {
		background: #24d4ff;
		color: #080311;
	}
	.act.danger:hover,
	.act.danger:focus-visible {
		background: #ff2bc7;
		color: #080311;
	}
	.act .gem {
		border: 0;
		background: #ff2bc7;
		box-shadow: none;
	}
	.act:hover .gem,
	.act:focus-visible .gem {
		background: #080311;
		box-shadow: none;
	}
	.btn-primary.block,
	.btn-primary.sm,
	.btn-ghost.sm {
		border-radius: 0;
		clip-path: polygon(0 0, 93% 0, 100% 50%, 93% 100%, 0 100%);
	}

	/* Organized upper-right account utility, opening inward. */
	.dock {
		left: auto;
		right: max(24px, env(safe-area-inset-right));
		top: max(82px, calc(72px + env(safe-area-inset-top)));
		align-items: flex-end;
		gap: 8px;
	}
	.chip,
	.chip:hover,
	.chip.active {
		position: relative;
		flex-direction: row-reverse;
		min-width: 260px;
		padding: 9px 18px 9px 30px;
		background: #24104d;
		clip-path: polygon(18px 0, 100% 0, 100% 100%, 18px 100%, 0 50%);
	}
	.chip::before {
		content: '';
		position: absolute;
		right: 0;
		top: 0;
		width: 8px;
		height: 100%;
		background: #24d4ff;
	}
	.chip::after {
		left: auto;
		right: 0;
		width: 82%;
		height: 5px;
	}
	.chip-text {
		align-items: flex-end;
		text-align: right;
	}
	.chip-chevron {
		margin: 0 auto 0 0;
		transform: rotate(90deg);
	}
	.chip-chevron.up {
		transform: rotate(270deg);
	}
	.pop {
		width: min(390px, calc(100vw - 40px));
		background: #080413;
		clip-path: polygon(8% 0, 100% 0, 100% 92%, 91% 100%, 0 100%, 0 9%);
	}
	.pop-head {
		background: #24104d;
		clip-path: polygon(8% 0, 100% 0, 100% 100%, 0 86%);
	}
	.act:nth-child(odd) {
		width: 100%;
		margin-left: 0;
		clip-path: polygon(0 0, 100% 0, 100% 100%, 5% 100%);
	}
	.act:nth-child(even) {
		width: 100%;
		clip-path: polygon(0 0, 100% 0, 100% 100%, 5% 100%);
	}

	@media (orientation: landscape) and (max-height: 650px) {
		.dock {
			top: 68px;
			right: max(16px, env(safe-area-inset-right));
		}
		.pop {
			max-height: calc(100dvh - 126px);
			overflow-y: auto;
		}
		.chip,
		.chip:hover,
		.chip.active {
			min-width: 230px;
			padding-block: 7px;
		}
		.avatar {
			width: 32px;
			height: 32px;
		}
	}

	@media (orientation: portrait) {
		.dock {
			top: max(82px, env(safe-area-inset-top));
			right: max(12px, env(safe-area-inset-right));
			left: auto;
		}
		.chip,
		.chip:hover,
		.chip.active {
			min-width: 218px;
		}
		.pop {
			width: min(94vw, 390px);
		}
	}
</style>

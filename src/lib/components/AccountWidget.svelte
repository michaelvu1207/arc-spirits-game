<script lang="ts">
	import { goto } from '$app/navigation';
	import { auth } from '$lib/auth/auth.svelte';

	let busy = $state(false);

	async function handleSignOut() {
		if (busy) return;
		busy = true;
		try {
			await auth.signOut();
			await goto('/game');
		} finally {
			busy = false;
		}
	}
</script>

{#if auth.isSignedIn}
	<div class="acct" data-testid="account-widget">
		<a href="/account" class="chip" data-testid="nav-account" title="Account">
			<span class="avatar" aria-hidden="true">{(auth.displayName ?? '?').slice(0, 1).toUpperCase()}</span>
			<span class="chip-name">{auth.displayName ?? 'Account'}</span>
			{#if auth.isAnonymous}<span class="guest-tag" title="Guest account — claim it to keep your progress">Guest</span>{/if}
		</a>
		<button
			class="signout"
			type="button"
			onclick={handleSignOut}
			disabled={busy}
			data-testid="nav-signout"
			title="Sign out"
			aria-label="Sign out"
		>
			<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
				<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" stroke-linecap="round" stroke-linejoin="round" />
				<path d="M16 17l5-5-5-5M21 12H9" stroke-linecap="round" stroke-linejoin="round" />
			</svg>
		</button>
	</div>
{:else}
	<a href="/account" class="signin-btn" data-testid="nav-signin">Sign In</a>
{/if}

<style>
	.acct {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 9px;
		padding: 5px 12px 5px 5px;
		border-radius: 999px;
		border: 1px solid var(--color-mist);
		background: rgba(20, 12, 36, 0.6);
		text-decoration: none;
		color: var(--color-bone);
		transition: border-color 160ms ease, background 160ms ease;
	}
	.chip:hover {
		border-color: var(--brand-magenta);
		background: rgba(40, 16, 52, 0.7);
	}
	.avatar {
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		flex: none;
		border-radius: 50%;
		background: var(--gradient-flame, linear-gradient(135deg, #ff2bc7, #7b1dff));
		color: #fff;
		font-family: var(--font-display);
		font-size: 0.82rem;
		line-height: 1;
	}
	.chip-name {
		font-family: var(--font-display);
		font-size: 0.84rem;
		letter-spacing: 0.06em;
		max-width: 140px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.guest-tag {
		font-family: var(--font-mono, monospace);
		font-size: 0.6rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		padding: 2px 6px;
		border-radius: 3px;
		background: rgba(36, 212, 255, 0.16);
		color: var(--brand-cyan, #24d4ff);
	}
	.signout {
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: 8px;
		border: 1px solid var(--color-mist);
		background: rgba(20, 12, 36, 0.6);
		color: var(--color-fog);
		cursor: pointer;
		transition: color 160ms ease, border-color 160ms ease;
	}
	.signout:hover:not(:disabled) {
		color: var(--color-bone);
		border-color: var(--brand-magenta);
	}
	.signout:disabled {
		opacity: 0.5;
		cursor: progress;
	}
	.signin-btn {
		display: inline-flex;
		align-items: center;
		padding: 8px 18px;
		border-radius: 8px;
		background: var(--gradient-flame, linear-gradient(135deg, #ff2bc7, #7b1dff));
		color: #fff;
		font-family: var(--font-display);
		font-size: 0.84rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		text-decoration: none;
		box-shadow: 0 10px 26px -14px rgba(255, 43, 199, 0.7);
		transition: transform 150ms ease;
	}
	.signin-btn:hover {
		transform: translateY(-1px);
	}
</style>

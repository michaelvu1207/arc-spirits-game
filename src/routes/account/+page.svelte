<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { auth, type OAuthProvider } from '$lib/auth/auth.svelte';
	import CosmeticLoadout from '$lib/components/CosmeticLoadout.svelte';

	type Mode = 'signin' | 'signup';
	let mode = $state<Mode>('signin');

	let email = $state('');
	let password = $state('');
	let displayName = $state('');

	let busy = $state(false);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);

	// Surface OAuth/confirm callback failures redirected here with ?error=.
	$effect(() => {
		const e = $page.url.searchParams.get('error');
		if (e === 'auth_callback_failed') error = 'Sign-in could not be completed. Please try again.';
		else if (e === 'confirm_failed') error = 'That confirmation link is invalid or expired.';
	});

	// Seed the display-name field from the current profile once signed in.
	$effect(() => {
		if (auth.isSignedIn && auth.displayName && !displayName) displayName = auth.displayName;
	});

	function fail(e: unknown) {
		error = e instanceof Error ? e.message : 'Something went wrong.';
	}

	async function submitCredentials(e: SubmitEvent) {
		e.preventDefault();
		if (busy) return;
		error = null;
		notice = null;
		busy = true;
		try {
			if (mode === 'signin') {
				await auth.signInEmail(email, password);
				await goto('/play');
			} else {
				const result = await auth.signUpEmail(email, password, displayName || 'Nameless Spirit');
				if (result.session) {
					await goto('/play');
				} else {
					notice = `Account created. Check ${email} for a confirmation link to finish.`;
				}
			}
		} catch (e) {
			fail(e);
		} finally {
			busy = false;
		}
	}

	async function claimAccount(e: SubmitEvent) {
		e.preventDefault();
		if (busy) return;
		error = null;
		notice = null;
		busy = true;
		try {
			await auth.linkEmailPassword(email, password);
			notice = 'Check your inbox to confirm your email — then your account is permanent.';
		} catch (e) {
			fail(e);
		} finally {
			busy = false;
		}
	}

	async function oauth(provider: OAuthProvider) {
		error = null;
		try {
			await auth.signInWithProvider(provider);
		} catch (e) {
			fail(e);
		}
	}

	/** Claim-card OAuth: LINK the provider identity to the CURRENT anonymous uid so
	 *  the promised "keep all progress" is actually true — never a sign-in that
	 *  lands in a different account. */
	async function oauthClaim(provider: OAuthProvider) {
		error = null;
		try {
			await auth.linkOAuthProvider(provider);
		} catch (e) {
			fail(e);
		}
	}

	async function saveName(e: SubmitEvent) {
		e.preventDefault();
		if (busy) return;
		error = null;
		notice = null;
		busy = true;
		try {
			await auth.updateDisplayName(displayName);
			notice = 'Display name updated.';
		} catch (e) {
			fail(e);
		} finally {
			busy = false;
		}
	}

	async function resetPassword() {
		if (!email) {
			error = 'Enter your email above first.';
			return;
		}
		error = null;
		try {
			await auth.sendPasswordReset(email);
			// Enumeration-safe: don't confirm whether the address has an account.
			notice = `If an account exists for ${email}, a password reset link is on its way.`;
		} catch (e) {
			fail(e);
		}
	}

	async function doSignOut() {
		busy = true;
		try {
			await auth.signOut();
			email = '';
			password = '';
			displayName = '';
			notice = 'Signed out.';
		} finally {
			busy = false;
		}
	}

	// ── Manage (permanent accounts) ──────────────────────────────
	let newPassword = $state('');
	let newEmail = $state('');
	let currentPassword = $state('');

	async function changePassword(e: SubmitEvent) {
		e.preventDefault();
		if (busy) return;
		error = null;
		notice = null;
		busy = true;
		try {
			// Step-up: confirm the current password before changing it.
			await auth.reauthenticate(currentPassword);
			await auth.changePassword(newPassword);
			newPassword = '';
			currentPassword = '';
			notice = 'Password updated.';
		} catch (e) {
			fail(e);
		} finally {
			busy = false;
		}
	}

	async function changeEmail(e: SubmitEvent) {
		e.preventDefault();
		if (busy) return;
		error = null;
		notice = null;
		busy = true;
		try {
			await auth.changeEmail(newEmail);
			notice = `Confirmation sent. Check ${newEmail} (and your current inbox) to finish the change.`;
			newEmail = '';
		} catch (e) {
			fail(e);
		} finally {
			busy = false;
		}
	}

	async function signOutEverywhere() {
		busy = true;
		error = null;
		try {
			await auth.signOutEverywhere();
			notice = 'Signed out on all devices.';
		} catch (e) {
			fail(e);
		} finally {
			busy = false;
		}
	}

	async function deleteAccount() {
		if (!currentPassword) {
			error = 'Enter your current password to confirm account deletion.';
			return;
		}
		if (
			!confirm(
				'Permanently delete your account? This cannot be undone. Your game history is kept but anonymized.'
			)
		)
			return;
		busy = true;
		error = null;
		try {
			// Step-up: a borrowed live session can't delete without the password.
			await auth.reauthenticate(currentPassword);
			await auth.deleteAccount();
			await goto('/play');
		} catch (e) {
			fail(e);
			busy = false;
		}
	}

	const initial = $derived((auth.displayName ?? '?').slice(0, 1).toUpperCase());
</script>

<svelte:head><title>Account | Arc Spirits</title></svelte:head>

<main class="auth">
	<a class="back" href="/play">← Play</a>

	<div class="shell">
		<header class="brand">
			<div class="eyebrow">Arc Spirits</div>
			<h1 class="title brand-flame-text">{auth.isSignedIn ? 'Profile' : 'Account'}</h1>
		</header>

		{#if error}<p class="msg error" role="alert" data-testid="auth-error">{error}</p>{/if}
		{#if notice}<p class="msg notice" data-testid="auth-notice">{notice}</p>{/if}

		{#if auth.isSignedIn}
			<!-- ───────────── Signed in ───────────── -->
			<section class="card" data-testid="account-signed-in">
				<div class="who">
					<span class="avatar">{initial}</span>
					<div class="who-text">
						<div class="who-name" data-testid="account-displayname">
							{auth.displayName ?? 'Nameless Spirit'}
						</div>
						{#if auth.isAnonymous}
							<span class="badge guest">Guest account</span>
						{:else}
							<span class="badge real">{auth.email ?? 'Account'}</span>
						{/if}
					</div>
				</div>

				<form class="row" onsubmit={saveName}>
					<input
						class="input"
						bind:value={displayName}
						maxlength="40"
						placeholder="Display name"
						aria-label="Display name"
						data-testid="displayname-input"
					/>
					<button class="btn-ghost" type="submit" disabled={busy} data-testid="displayname-save"
						>Save</button
					>
				</form>
			</section>
			<CosmeticLoadout />

			{#if auth.isAnonymous}
				<!-- Claim flow: attach a real identity to the same uid → keep all progress. -->
				<section class="card" data-testid="claim-card">
					<h2>Claim your account</h2>
					<p class="lead">
						Add an email + password (or a provider) to make your guest account permanent and keep
						your stats across devices.
					</p>
					<form class="stack" onsubmit={claimAccount}>
						<input
							class="input"
							bind:value={email}
							type="email"
							placeholder="you@email.com"
							autocomplete="email"
							data-testid="claim-email"
							required
						/>
						<input
							class="input"
							bind:value={password}
							type="password"
							placeholder="Password (min 8 chars)"
							autocomplete="new-password"
							minlength="8"
							data-testid="claim-password"
							required
						/>
						<button class="btn-primary" type="submit" disabled={busy} data-testid="claim-submit"
							>{busy ? 'Linking…' : 'Claim account'}</button
						>
					</form>
					<div class="oauth">
						<button
							class="oauth-btn"
							type="button"
							onclick={() => oauthClaim('google')}
							data-testid="oauth-google">Google</button
						>
						<button
							class="oauth-btn"
							type="button"
							onclick={() => oauthClaim('apple')}
							data-testid="oauth-apple">Apple</button
						>
						<button
							class="oauth-btn"
							type="button"
							onclick={() => oauthClaim('discord')}
							data-testid="oauth-discord">Discord</button
						>
					</div>
				</section>
			{/if}

			{#if auth.isPermanent}
				<!-- Advanced security tucked into a disclosure so the page stays simple. -->
				<details class="manage" data-testid="manage-card">
					<summary>Manage account</summary>
					<div class="manage-body">
						<input
							class="input"
							bind:value={currentPassword}
							type="password"
							placeholder="Current password (required below)"
							autocomplete="current-password"
							data-testid="current-password"
						/>
						<form class="row" onsubmit={changePassword}>
							<input
								class="input"
								bind:value={newPassword}
								type="password"
								placeholder="New password"
								autocomplete="new-password"
								minlength="8"
								data-testid="new-password"
							/>
							<button
								class="btn-ghost"
								type="submit"
								disabled={busy || newPassword.length < 8 || !currentPassword}
								data-testid="change-password">Update</button
							>
						</form>
						<form class="row" onsubmit={changeEmail}>
							<input
								class="input"
								bind:value={newEmail}
								type="email"
								placeholder="New email"
								autocomplete="email"
								data-testid="new-email"
							/>
							<button
								class="btn-ghost"
								type="submit"
								disabled={busy || !newEmail}
								data-testid="change-email">Send</button
							>
						</form>
						<div class="manage-actions">
							<button
								class="link"
								type="button"
								onclick={signOutEverywhere}
								disabled={busy}
								data-testid="signout-everywhere">Sign out everywhere</button
							>
							<button
								class="link danger"
								type="button"
								onclick={deleteAccount}
								disabled={busy}
								data-testid="delete-account">Delete account</button
							>
						</div>
					</div>
				</details>
			{/if}

			<button
				class="btn-primary block"
				type="button"
				onclick={doSignOut}
				disabled={busy}
				data-testid="signout">Sign out</button
			>
		{:else}
			<!-- ───────────── Signed out ───────────── -->
			<section class="card">
				<div class="seg" role="tablist">
					<button
						class="seg-btn"
						class:active={mode === 'signin'}
						role="tab"
						aria-selected={mode === 'signin'}
						type="button"
						onclick={() => (mode = 'signin')}
						data-testid="tab-signin">Sign in</button
					>
					<button
						class="seg-btn"
						class:active={mode === 'signup'}
						role="tab"
						aria-selected={mode === 'signup'}
						type="button"
						onclick={() => (mode = 'signup')}
						data-testid="tab-signup">Create account</button
					>
				</div>

				<form class="stack" onsubmit={submitCredentials}>
					{#if mode === 'signup'}
						<input
							class="input"
							bind:value={displayName}
							maxlength="40"
							placeholder="Display name"
							autocomplete="nickname"
							data-testid="signup-name"
						/>
					{/if}
					<input
						class="input"
						bind:value={email}
						type="email"
						placeholder="you@email.com"
						autocomplete="email"
						data-testid="auth-email"
						required
					/>
					<input
						class="input"
						bind:value={password}
						type="password"
						placeholder="Password"
						autocomplete={mode === 'signup' ? 'new-password' : 'current-password'}
						minlength="8"
						data-testid="auth-password"
						required
					/>
					<button class="btn-primary" type="submit" disabled={busy} data-testid="auth-submit">
						{busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
					</button>
				</form>

				{#if mode === 'signin'}
					<button class="link" type="button" onclick={resetPassword} data-testid="forgot"
						>Forgot password?</button
					>
				{/if}

				<div class="divider"><span>or</span></div>

				<div class="oauth">
					<button
						class="oauth-btn"
						type="button"
						onclick={() => oauth('google')}
						data-testid="oauth-google">Google</button
					>
					<button
						class="oauth-btn"
						type="button"
						onclick={() => oauth('apple')}
						data-testid="oauth-apple">Apple</button
					>
					<button
						class="oauth-btn"
						type="button"
						onclick={() => oauth('discord')}
						data-testid="oauth-discord">Discord</button
					>
				</div>
			</section>

			<p class="foot">
				No account needed to play — head to <a href="/play">Play</a> and jump in as a guest. Create an
				account anytime to save your stats.
			</p>
		{/if}
	</div>
</main>

<style>
	.auth {
		min-height: 100vh;
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: clamp(56px, 9vh, 96px) 20px clamp(40px, 7vh, 72px);
		position: relative;
	}

	.back {
		position: absolute;
		top: clamp(18px, 4vh, 32px);
		left: clamp(16px, 4vw, 36px);
		font-family: var(--font-display);
		font-size: 0.78rem;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--color-fog);
		text-decoration: none;
		transition:
			color 180ms ease,
			transform 180ms ease;
	}
	.back:hover {
		color: var(--color-bone);
		transform: translateX(-3px);
	}

	.shell {
		width: 100%;
		max-width: 400px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	/* ── Brand header ─────────────────────────────────────── */
	.brand {
		text-align: center;
		margin-bottom: 4px;
	}
	.eyebrow {
		font-family: var(--font-display);
		font-size: 0.66rem;
		letter-spacing: 0.34em;
		text-transform: uppercase;
		color: var(--brand-cyan);
		margin-bottom: 8px;
	}
	.title {
		font-family: var(--font-display);
		font-size: clamp(2.2rem, 8vw, 3rem);
		line-height: 0.9;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		margin: 0;
		filter: drop-shadow(0 6px 30px rgba(123, 29, 255, 0.45));
	}

	/* ── Card ─────────────────────────────────────────────── */
	.card {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 22px;
		border-radius: 16px;
		border: 1px solid var(--color-aether);
		background: linear-gradient(180deg, rgba(20, 12, 36, 0.92), rgba(10, 6, 20, 0.94));
		box-shadow: 0 30px 80px -32px rgba(0, 0, 0, 0.85);
	}
	h2 {
		font-family: var(--font-display);
		font-size: 1rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-bone);
		margin: 0;
	}
	.lead {
		color: var(--color-fog);
		font-size: 0.84rem;
		line-height: 1.55;
		margin: 0;
	}

	/* ── Segmented mode toggle ────────────────────────────── */
	.seg {
		display: flex;
		gap: 4px;
		padding: 4px;
		border-radius: 11px;
		border: 1px solid var(--color-mist);
		background: rgba(8, 5, 16, 0.6);
	}
	.seg-btn {
		flex: 1;
		padding: 9px 8px;
		border: none;
		border-radius: 8px;
		background: transparent;
		color: var(--color-fog);
		font-family: var(--font-display);
		font-size: 0.74rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		cursor: pointer;
		transition:
			color 160ms ease,
			background 160ms ease;
	}
	.seg-btn.active {
		background: var(--gradient-flame);
		color: #fff;
	}

	/* ── Inputs & rows ────────────────────────────────────── */
	.stack {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.row {
		display: flex;
		gap: 10px;
	}
	.row .input {
		flex: 1;
	}
	.input {
		width: 100%;
		padding: 12px 14px;
		border-radius: 10px;
		border: 1px solid var(--color-mist);
		background: rgba(8, 5, 16, 0.6);
		color: var(--color-bone);
		font: inherit;
		font-size: 0.92rem;
		transition: border-color 160ms ease;
	}
	.input::placeholder {
		color: var(--color-whisper);
	}
	.input:focus {
		outline: none;
		border-color: var(--brand-magenta);
	}

	/* Global .btn-primary / .btn-ghost are used directly; these add layout helpers. */
	.btn-ghost {
		flex: none;
		white-space: nowrap;
	}
	.block {
		width: 100%;
		justify-content: center;
	}

	/* ── Divider + OAuth ──────────────────────────────────── */
	.divider {
		display: flex;
		align-items: center;
		gap: 12px;
		color: var(--color-whisper);
		font-size: 0.72rem;
		letter-spacing: 0.2em;
		text-transform: uppercase;
	}
	.divider::before,
	.divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--color-mist);
	}
	.oauth {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 8px;
	}
	.oauth-btn {
		padding: 11px 6px;
		border-radius: 9px;
		border: 1px solid var(--color-mist);
		background: rgba(8, 5, 16, 0.4);
		color: var(--color-parchment);
		font-family: var(--font-display);
		font-size: 0.74rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		cursor: pointer;
		transition:
			border-color 160ms ease,
			color 160ms ease;
	}
	.oauth-btn:hover {
		border-color: var(--brand-magenta);
		color: var(--brand-magenta-soft);
	}

	/* ── Who (signed in) ──────────────────────────────────── */
	.who {
		display: flex;
		align-items: center;
		gap: 14px;
	}
	.avatar {
		display: grid;
		place-items: center;
		width: 52px;
		height: 52px;
		flex: none;
		border-radius: 50%;
		background: var(--gradient-flame);
		color: #fff;
		font-family: var(--font-display);
		font-size: 1.4rem;
		box-shadow: 0 0 16px -2px rgba(255, 43, 199, 0.55);
	}
	.who-text {
		min-width: 0;
	}
	.who-name {
		font-family: var(--font-display);
		font-size: 1.3rem;
		letter-spacing: 0.02em;
		color: var(--color-bone);
		line-height: 1.1;
	}
	.badge {
		display: inline-block;
		margin-top: 6px;
		font-family: var(--font-mono);
		font-size: 0.72rem;
		padding: 2px 8px;
		border-radius: 4px;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.badge.guest {
		background: rgba(36, 212, 255, 0.16);
		color: var(--brand-cyan);
	}
	.badge.real {
		background: rgba(32, 224, 193, 0.14);
		color: var(--brand-teal);
	}

	/* ── Manage disclosure ────────────────────────────────── */
	.manage {
		border-radius: 16px;
		border: 1px solid var(--color-mist);
		background: rgba(10, 6, 20, 0.5);
		overflow: hidden;
	}
	.manage summary {
		list-style: none;
		cursor: pointer;
		padding: 15px 20px;
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--color-fog);
		display: flex;
		align-items: center;
		justify-content: space-between;
		transition: color 160ms ease;
	}
	.manage summary::-webkit-details-marker {
		display: none;
	}
	.manage summary::after {
		content: '+';
		font-size: 1.1rem;
		color: var(--brand-magenta-soft);
	}
	.manage[open] summary::after {
		content: '−';
	}
	.manage summary:hover {
		color: var(--color-bone);
	}
	.manage-body {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 4px 20px 20px;
	}
	.manage-actions {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		margin-top: 6px;
		padding-top: 12px;
		border-top: 1px solid var(--color-mist);
	}

	/* ── Links & messages ─────────────────────────────────── */
	.link {
		align-self: flex-start;
		background: none;
		border: none;
		padding: 0;
		color: var(--brand-magenta-soft);
		font-family: var(--font-body);
		font-size: 0.82rem;
		cursor: pointer;
	}
	.link:hover {
		color: var(--brand-magenta);
	}
	.link.danger {
		color: var(--color-blood, #c41a3d);
	}
	.link:disabled {
		opacity: 0.5;
		cursor: progress;
	}

	.foot {
		text-align: center;
		color: var(--color-fog);
		font-size: 0.82rem;
		line-height: 1.55;
		margin: 0;
	}
	.foot a {
		color: var(--brand-magenta-soft);
	}

	.msg {
		padding: 11px 14px;
		border-radius: 10px;
		font-size: 0.85rem;
		margin: 0;
	}
	.msg.error {
		border-left: 3px solid var(--color-blood, #c41a3d);
		background: rgba(196, 26, 61, 0.18);
		color: var(--color-bone);
	}
	.msg.notice {
		border-left: 3px solid var(--brand-teal);
		background: rgba(32, 224, 193, 0.12);
		color: var(--color-bone);
	}

	/* Sign-in as a full graphic poster: sharp fields, no centered app card. */
	.auth {
		display: grid;
		grid-template-columns: minmax(420px, 560px) minmax(240px, 1fr);
		align-items: center;
		justify-content: stretch;
		padding: clamp(72px, 9vh, 110px) clamp(32px, 7vw, 112px) clamp(40px, 6vh, 72px);
		background: #050310;
		overflow-x: hidden;
		overflow-y: auto;
	}
	.auth::before,
	.auth::after {
		content: '';
		position: absolute;
		pointer-events: none;
	}
	.auth::before {
		right: -12vw;
		top: -8vh;
		width: 54vw;
		height: 116vh;
		background: #24104d;
		clip-path: polygon(42% 0, 100% 0, 100% 100%, 8% 88%, 30% 48%);
	}
	.auth::after {
		right: 3vw;
		bottom: 5vh;
		width: 25vw;
		height: 19vh;
		background: #24d4ff;
		opacity: 0.38;
		clip-path: polygon(12% 0, 100% 20%, 80% 100%, 0 72%);
	}
	.back,
	.shell {
		position: relative;
		z-index: 1;
	}
	.back {
		position: absolute;
		top: max(24px, env(safe-area-inset-top));
		left: max(24px, env(safe-area-inset-left));
		width: max-content;
		padding: 8px 34px 8px 12px;
		background: #20104a;
		color: #fff;
		clip-path: polygon(0 0, 90% 0, 100% 50%, 90% 100%, 0 100%);
	}
	.back:hover {
		transform: none;
		background: #24d4ff;
		color: #080311;
	}
	.shell {
		grid-column: 1;
		width: 100%;
		max-width: 520px;
		gap: 12px;
	}
	.brand {
		text-align: left;
	}
	.title {
		font-size: clamp(3rem, 6vw, 5rem);
		color: #ff2bc7;
		background: none;
		-webkit-text-fill-color: currentColor;
		filter: none;
		text-shadow: none;
	}
	.card {
		gap: 12px;
		padding: 18px;
		border: 0;
		border-radius: 0;
		background: #100725;
		box-shadow: none;
		clip-path: polygon(0 0, 94% 0, 100% 7%, 100% 93%, 92% 100%, 0 100%);
	}
	.seg {
		gap: 2px;
		padding: 0;
		border: 0;
		border-radius: 0;
		background: transparent;
	}
	.seg-btn,
	.seg-btn.active {
		border-radius: 0;
		background: #28115b;
		clip-path: polygon(0 0, 92% 0, 100% 50%, 92% 100%, 0 100%);
	}
	.seg-btn.active {
		background: #d515aa;
	}
	.input {
		border: 0;
		border-bottom: 3px solid #24d4ff;
		border-radius: 0;
		background: #090416;
	}
	.oauth-btn,
	.btn-ghost,
	.btn-primary {
		border-radius: 0;
		clip-path: polygon(0 0, 91% 0, 100% 50%, 91% 100%, 0 100%);
	}
	.avatar {
		border-radius: 0;
		background: #d515aa;
		box-shadow: none;
		clip-path: polygon(25% 5%, 75% 5%, 100% 50%, 75% 95%, 25% 95%, 0 50%);
	}
	.badge {
		border-radius: 0;
		background: #28115b;
	}
	.msg {
		border-radius: 0;
	}

	@media (orientation: landscape) and (max-height: 650px) {
		.auth {
			grid-template-columns: minmax(360px, 520px) minmax(180px, 1fr);
			align-items: start;
			padding: 52px 7vw 24px;
		}
		.title {
			font-size: clamp(2.5rem, 10vh, 3.6rem);
		}
		.eyebrow {
			margin-bottom: 4px;
		}
		.card {
			gap: 9px;
			padding: 14px 16px;
		}
		.seg-btn {
			padding-block: 7px;
		}
		.input {
			padding-block: 10px;
		}
		.oauth-btn {
			padding-block: 9px;
		}
		.foot {
			font-size: 0.74rem;
			line-height: 1.35;
		}
	}

	@media (max-width: 760px) and (orientation: portrait) {
		.auth {
			display: flex;
			align-items: stretch;
			padding: 76px 20px 36px;
		}
		.shell {
			margin-inline: auto;
		}
	}
</style>

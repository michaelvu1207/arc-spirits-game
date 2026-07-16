<script lang="ts">
	import type { PageData } from './$types';
	import { goto } from '$app/navigation';
	import { auth } from '$lib/auth/auth.svelte';
	import { postPlayJson, setActiveMember } from '$lib/stores/playStore.svelte';

	let { data }: { data: PageData } = $props();
	let busy = $state(false);
	let error = $state<string | null>(null);
	let accepted = $state(false);
	let name = $state('');

	async function accept() {
		if (busy) return;
		busy = true;
		error = null;
		try {
			await auth.whenInitialized();
			if (!auth.user) await auth.resolvePlayIdentity(name.trim() || 'Invited Spirit');
			const result = await postPlayJson<{ kind: string; roomCode?: string; memberId?: string }>(
				`/api/play/social/invites/${encodeURIComponent(data.token)}`,
				{}
			);
			accepted = true;
			if (result.kind === 'room' && result.roomCode && result.memberId) {
				setActiveMember(result.memberId);
				await goto(`/play/${encodeURIComponent(result.roomCode)}`);
			} else {
				setTimeout(() => void goto('/play'), 700);
			}
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not accept invitation.';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Live Invitation · Arc Spirits</title>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<main data-testid="invite-page">
	<section>
		<span class="eyebrow">Live invitation</span>
		<div class="sigil" aria-hidden="true"><i></i><i></i><i></i></div>
		<h1>{data.invite.kind === 'friend' ? 'Friend Request' : data.invite.kind === 'party' ? 'Join the Party' : 'Join Private Room'}</h1>
		<p><strong>{data.invite.from}</strong> invited you to a live Arc Spirits experience.</p>
		<p class="note">This link expires automatically. It never starts an asynchronous game or enables turn reminders.</p>
		{#if !auth.user}<label>Display name<input bind:value={name} maxlength="40" autocomplete="nickname" /></label>{/if}
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		<button type="button" onclick={accept} disabled={busy || accepted} data-testid="invite-accept">
			{accepted ? 'Accepted' : busy ? 'Accepting…' : 'Accept Invitation'}
		</button>
		<a href={`arcspirits://invite/${data.token}`} data-testid="invite-open-app">Open Arc Spirits app</a>
		<a href="/play">Not now</a>
	</section>
</main>

<style>
	:global(body) { margin: 0; background: #070411; color: white; }
	main { min-height: 100vh; display: grid; place-items: center; box-sizing: border-box; padding: 1rem; font-family: system-ui; background: radial-gradient(circle at 50% 20%, #32135c, transparent 45%), #070411; }
	section { width: min(520px, 100%); box-sizing: border-box; padding: clamp(1.3rem, 5vw, 2.6rem); text-align: center; border: 1px solid #704cab; border-radius: 28px; background: rgba(17,8,36,.96); box-shadow: 0 24px 90px rgba(0,0,0,.58); }
	.eyebrow { color: #66f2df; text-transform: uppercase; letter-spacing: .2em; font-size: .72rem; font-weight: 800; }
	.sigil { position: relative; width: 90px; height: 90px; margin: 1.4rem auto; animation: float 4s ease-in-out infinite; }
	.sigil i { position: absolute; inset: 8px; clip-path: polygon(50% 0,100% 42%,78% 100%,18% 88%,0 35%); background: linear-gradient(135deg,#b178ff,#3de7d2); opacity: .78; }
	.sigil i:nth-child(2) { transform: rotate(62deg) scale(.68); opacity: .5; } .sigil i:nth-child(3) { transform: rotate(130deg) scale(.4); background: white; }
	h1 { margin: 0; font-size: clamp(2rem, 8vw, 3.7rem); line-height: .95; text-transform: uppercase; } p { color: #c9bfd6; line-height: 1.5; } .note { font-size: .85rem; }
	label { display: grid; gap: .4rem; text-align: left; margin: 1rem 0; color: #a99db7; } input { min-height: 44px; border: 1px solid #64448f; border-radius: 10px; padding: 0 .8rem; color: white; background: #0c0718; font-size: 1rem; }
	button, a { min-height: 44px; display: inline-grid; place-items: center; box-sizing: border-box; margin: .4rem; padding: .7rem 1rem; border: 1px solid #7653a8; border-radius: 999px; color: white; background: #2b1550; font-weight: 800; text-decoration: none; }
	button:focus-visible, a:focus-visible, input:focus-visible { outline: 3px solid #66f2df; outline-offset: 2px; } .error { color: #ff8ea0; }
	@keyframes float { 0%,100% { transform: translateY(0) rotate(0); } 50% { transform: translateY(-8px) rotate(8deg); } }
	@media (prefers-reduced-motion: reduce) { .sigil { animation: none; } }
</style>

<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { auth } from '$lib/auth/auth.svelte';
	import { apiUrl, isCrossOrigin } from '$lib/play/apiBase';
	import { postPlayJson, setActiveMember } from '$lib/stores/playStore.svelte';
	import GameIcon from '$lib/components/GameIcon.svelte';

	type Person = {
		userId: string;
		displayName: string;
		presence?: { state: string; roomCode?: string | null } | null;
	};
	type Snapshot = {
		party: null | {
			id: string;
			ownerUserId: string;
			activeRoomCode: string | null;
			members: Array<Person & { role: string }>;
		};
		friends: Person[];
		recentRivals: Person[];
	};

	let open = $state(false);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let snapshot = $state<Snapshot | null>(null);
	let copied = $state(false);
	let timer: ReturnType<typeof setInterval> | null = null;

	function headers(): Record<string, string> {
		const value: Record<string, string> = { Accept: 'application/json' };
		if (isCrossOrigin && auth.session?.access_token)
			value.Authorization = `Bearer ${auth.session.access_token}`;
		return value;
	}

	async function refresh() {
		if (!auth.user) return;
		loading = true;
		try {
			const response = await fetch(apiUrl('/api/play/social'), {
				headers: headers(),
				credentials: isCrossOrigin ? 'include' : 'same-origin'
			});
			if (!response.ok) throw new Error(`Social service returned ${response.status}`);
			snapshot = await response.json();
			error = null;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Live social unavailable.';
		} finally {
			loading = false;
		}
	}

	async function heartbeat() {
		if (!auth.user) return;
		let clientId = localStorage.getItem('arc-social-client-id');
		if (!clientId) {
			clientId = `web-${crypto.randomUUID().replaceAll('-', '')}`;
			localStorage.setItem('arc-social-client-id', clientId);
		}
		await postPlayJson('/api/play/social/presence', {
			clientId,
			platform: 'web',
			state: 'online',
			visibility: 'friends'
		}).catch(() => {});
	}

	async function createParty() {
		await postPlayJson('/api/play/social/party', {});
		await refresh();
	}

	async function leaveParty() {
		await postPlayJson('/api/play/social/party', { action: 'leave' });
		await refresh();
	}

	async function copyPartyInvite() {
		const invite = await postPlayJson<{ url: string }>('/api/play/social/invites', {
			kind: 'party'
		});
		const url = new URL(invite.url, window.location.origin).toString();
		await navigator.clipboard.writeText(url);
		copied = true;
		setTimeout(() => (copied = false), 1600);
	}

	async function launchPartyRoom() {
		const result = await postPlayJson<{ roomCode: string; memberId: string }>(
			'/api/play/social/party/room',
			{}
		);
		setActiveMember(result.memberId);
		await goto(`/play/${encodeURIComponent(result.roomCode)}`);
	}

	async function friendRival(person: Person) {
		const invite = await postPlayJson<{ url: string }>('/api/play/social/invites', {
			kind: 'friend',
			targetUserId: person.userId
		});
		await navigator.clipboard.writeText(new URL(invite.url, window.location.origin).toString());
		copied = true;
		setTimeout(() => (copied = false), 1600);
	}

	async function block(person: Person) {
		await postPlayJson('/api/play/social/blocks', { userId: person.userId });
		await refresh();
	}

	onMount(() => {
		void auth.whenInitialized().then(() => Promise.all([refresh(), heartbeat()]));
		timer = setInterval(() => void Promise.all([refresh(), heartbeat()]), 30_000);
		return () => {
			if (timer) clearInterval(timer);
		};
	});
</script>

<aside class:open class="social" data-testid="social-dock">
	<button
		class="toggle"
		type="button"
		onclick={() => {
			open = !open;
			if (open) void refresh();
		}}
		aria-expanded={open}
	>
		<GameIcon name="lobby" size={28} /> Party & Friends
	</button>
	{#if open}
		<div class="panel">
			<header><strong>Live Social</strong><small>No async matches or turn reminders</small></header>
			{#if !auth.user}<p>Start as a guest or sign in to use parties and friends.</p>
			{:else if loading && !snapshot}<p>Loading presence…</p>
			{:else if error}<p role="alert">{error}</p>
			{:else if snapshot}
				<section>
					<h3>Party</h3>
					{#if snapshot.party}
						<ul>
							{#each snapshot.party.members as member}<li>
									<i class:online={!!member.presence}></i>{member.displayName}<small
										>{member.role}</small
									>
								</li>{/each}
						</ul>
						<div class="actions">
							{#if snapshot.party.ownerUserId === auth.user.id}<button
									type="button"
									onclick={copyPartyInvite}>{copied ? 'Copied' : 'Invite'}</button
								><button type="button" onclick={launchPartyRoom}>Private Room</button>{/if}
							<button type="button" onclick={leaveParty} data-testid="social-leave-party"
								>Leave Party</button
							>
						</div>
					{:else}<button type="button" onclick={createParty} data-testid="social-create-party"
							>Create Party</button
						>{/if}
				</section>
				<section>
					<h3>Friends</h3>
					{#if snapshot.friends.length}<ul>
							{#each snapshot.friends as friend}<li>
									<i class:online={!!friend.presence}></i>{friend.displayName}<small
										>{friend.presence?.state ?? 'offline'}</small
									><button type="button" onclick={() => block(friend)}>Block</button>
								</li>{/each}
						</ul>{:else}<p>No friends yet.</p>{/if}
				</section>
				{#if snapshot.recentRivals.length}<section>
						<h3>Recent Rivals</h3>
						<ul>
							{#each snapshot.recentRivals as rival}<li>
									{rival.displayName}<button type="button" onclick={() => friendRival(rival)}
										>Invite</button
									>
								</li>{/each}
						</ul>
					</section>{/if}
			{/if}
		</div>
	{/if}
</aside>

<style>
	.social {
		position: fixed;
		z-index: 48;
		right: max(16px, env(safe-area-inset-right));
		bottom: max(16px, env(safe-area-inset-bottom));
		width: min(360px, calc(100vw - 32px));
		font-family: var(--font-body, system-ui);
	}
	.toggle {
		float: right;
		min-height: 44px;
		border: 1px solid rgba(101, 243, 225, 0.45);
		border-radius: 999px;
		padding: 0.65rem 1rem;
		color: white;
		background: rgba(17, 8, 37, 0.94);
		font-weight: 800;
	}
	.panel {
		clear: both;
		margin-top: 54px;
		max-height: min(540px, 70vh);
		overflow: auto;
		padding: 1rem;
		border: 1px solid rgba(123, 29, 255, 0.62);
		border-radius: 18px;
		color: white;
		background: rgba(10, 5, 25, 0.98);
		box-shadow: 0 18px 60px rgba(0, 0, 0, 0.5);
	}
	header {
		display: grid;
		gap: 0.2rem;
	}
	header strong,
	h3 {
		font-family: var(--font-display);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	header small,
	p {
		color: #b9aec8;
	}
	section {
		border-top: 1px solid rgba(255, 255, 255, 0.08);
		margin-top: 0.8rem;
		padding-top: 0.6rem;
	}
	h3 {
		margin: 0 0 0.5rem;
		font-size: 0.78rem;
		color: #66f2df;
	}
	ul {
		display: grid;
		gap: 0.4rem;
		list-style: none;
		padding: 0;
		margin: 0;
	}
	li {
		min-height: 44px;
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	li small {
		margin-left: auto;
		color: #9a8eaa;
	}
	i {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #675d72;
	}
	i.online {
		background: #66f2df;
		box-shadow: 0 0 10px #66f2df;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.6rem;
	}
	.panel button {
		min-height: 44px;
		border: 1px solid #664793;
		border-radius: 10px;
		padding: 0.5rem 0.7rem;
		color: white;
		background: #281446;
		font-weight: 700;
	}
	li button {
		min-height: 36px !important;
		margin-left: 0.35rem;
	}
	@media (prefers-reduced-motion: reduce) {
		* {
			transition: none !important;
			animation: none !important;
		}
	}

	/* Party and friends open as a bold side-stage, never a floating card. */
	.social {
		width: min(560px, calc(100vw - 32px));
	}
	.toggle {
		min-width: 210px;
		border: 0;
		border-radius: 0;
		padding: 0.78rem 2.3rem 0.78rem 1.2rem;
		background: #063f4d;
		color: #fff;
		font-family: var(--font-display);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		clip-path: polygon(10% 0, 100% 0, 100% 72%, 92% 100%, 0 100%, 0 28%);
	}
	.toggle:hover,
	.toggle:focus-visible {
		background: #24104d;
		color: #fff;
	}
	.toggle :global(.game-icon) {
		width: 28px;
		height: 28px;
		margin-right: 8px;
		vertical-align: middle;
	}
	.panel {
		clear: both;
		margin-top: 54px;
		max-height: min(650px, 78vh);
		padding: 1.4rem 2rem 1.6rem;
		border: 0;
		border-radius: 0;
		background: #0d061f;
		box-shadow: none;
		clip-path: polygon(7% 0, 100% 0, 100% 93%, 92% 100%, 0 100%, 0 9%);
	}
	.panel header {
		margin-inline: -2rem;
		padding: 0.9rem 2rem;
		background: #43178f;
		clip-path: polygon(0 0, 100% 0, 91% 100%, 0 100%);
	}
	.panel section {
		border: 0;
		border-top: 5px solid #24d4ff;
		margin-top: 1rem;
		padding-top: 0.7rem;
	}
	.panel section:nth-of-type(even) {
		border-color: #ff2bc7;
	}
	.panel h3 {
		color: #fff;
		font-size: 0.9rem;
	}
	.panel li {
		position: relative;
		padding-left: 18px;
		border-bottom: 1px solid #38206b;
	}
	.panel li::before {
		content: '';
		position: absolute;
		left: 0;
		width: 9px;
		height: 9px;
		background: #7b1dff;
		transform: rotate(45deg);
	}
	.panel button {
		border: 0;
		border-radius: 0;
		background: #2f1464;
		clip-path: polygon(0 0, 88% 0, 100% 50%, 88% 100%, 0 100%);
	}
	.panel button:hover,
	.panel button:focus-visible {
		background: #24d4ff;
		color: #080311;
	}
	.panel i {
		border-radius: 0;
		transform: rotate(45deg);
	}
</style>

<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { joinPlayRoom } from '$lib/stores/playStore.svelte';
	import { getPlayState } from '$lib/stores/playStore.svelte';
	import { seatAccent } from './helpers';
	import type { RoomChatMessage, SeatColor } from '$lib/play/types';

	type Variant = 'panel' | 'drawer';

	interface Props {
		variant?: Variant;
		open?: boolean;
		onClose?: () => void;
	}

	let { variant = 'panel', open = true, onClose = () => {} }: Props = $props();

	const playState = getPlayState();
	const room = $derived(playState.room);
	const member = $derived(playState.member);
	const messages = $derived(playState.chatMessages);
	const visible = $derived(variant === 'panel' || open);
	const canSend = $derived(!!member?.id && room?.status !== 'closed');
	const needsJoin = $derived(!member?.id && room?.status !== 'closed');

	let draft = $state('');
	let nameDraft = $state('');
	let busy = $state(false);
	let joinBusy = $state(false);
	let localError = $state<string | null>(null);
	let listEl = $state<HTMLDivElement | null>(null);

	$effect(() => {
		if (!room?.roomCode) return;
		playState.setRoomChatOpen(visible);
		if (visible) {
			void playState.loadRoomChat(room.roomCode, { countUnread: false });
		}
	});

	$effect(() => {
		messages.length;
		if (!visible) return;
		void tick().then(() => {
			if (listEl) listEl.scrollTop = listEl.scrollHeight;
		});
	});

	function close() {
		playState.setRoomChatOpen(false);
		onClose();
	}

	function accent(seat: SeatColor | null): string {
		return seat ? seatAccent(seat) : 'var(--brand-cyan, #5cdfff)';
	}

	function formatTime(message: RoomChatMessage): string {
		const date = new Date(message.createdAt);
		if (Number.isNaN(date.getTime())) return '';
		return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	}

	// Unmount cancellation: a spectator's join-to-chat resolving after the player
	// LEFT the room page must not re-install/re-connect the departed room (the
	// store fences the install; this also keeps the dead handler's state writes out).
	const unmount = new AbortController();
	onDestroy(() => unmount.abort());

	async function ensureJoined() {
		if (member?.id || !room?.roomCode) return;
		const name = nameDraft.trim();
		if (!name) {
			throw new Error('Enter a name to join chat.');
		}
		joinBusy = true;
		try {
			await joinPlayRoom(room.roomCode, name, { signal: unmount.signal });
		} finally {
			joinBusy = false;
		}
	}

	async function send() {
		const body = draft.trim();
		if (!body || busy) return;
		busy = true;
		localError = null;
		try {
			await ensureJoined();
			await playState.sendRoomChat(body);
			draft = '';
		} catch (err) {
			if (unmount.signal.aborted) return; // left the page — nothing to report to
			localError = err instanceof Error ? err.message : 'Could not send chat.';
		} finally {
			busy = false;
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter' || event.shiftKey) return;
		event.preventDefault();
		void send();
	}
</script>

{#if visible}
	{#if variant === 'drawer'}
		<button
			type="button"
			class="chat-backdrop"
			aria-label="Close chat"
			data-testid="chat-backdrop"
			onclick={close}
		></button>
	{/if}

	<section
		class="chat"
		class:drawer={variant === 'drawer'}
		class:panel={variant === 'panel'}
		role={variant === 'drawer' ? 'dialog' : 'region'}
		aria-label="Room chat"
		data-testid="game-chat"
	>
		<header class="chat-head">
			<div>
				<span class="chat-kicker">Room</span>
				<h2>Chat</h2>
			</div>
			{#if variant === 'drawer'}
				<button type="button" class="close" aria-label="Close chat" data-testid="chat-close" onclick={close}>
					<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
						<path
							d="M6 6l12 12M18 6L6 18"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
						/>
					</svg>
				</button>
			{/if}
		</header>

		<div class="messages" bind:this={listEl} data-testid="chat-messages">
			{#if messages.length === 0}
				<div class="empty" data-testid="chat-empty">
					<span>No messages yet.</span>
				</div>
			{:else}
				{#each messages as message (message.id)}
					<article
						class="message"
						class:mine={message.memberId != null && message.memberId === member?.id}
						style={`--seat:${accent(message.seatColor)}`}
						data-testid="chat-message"
					>
						<div class="meta">
							<span class="dot"></span>
							<strong>{message.authorDisplayName}</strong>
							<span class="role">{message.authorRole}</span>
							<time datetime={message.createdAt}>{formatTime(message)}</time>
						</div>
						<p>{message.body}</p>
					</article>
				{/each}
			{/if}
		</div>

		{#if needsJoin}
			<div class="join">
				<input
					bind:value={nameDraft}
					placeholder="Display name"
					aria-label="Display name"
					maxlength="40"
					data-testid="chat-name"
				/>
			</div>
		{/if}

		<form
			class="composer"
			onsubmit={(event) => {
				event.preventDefault();
				void send();
			}}
		>
			<textarea
				bind:value={draft}
				placeholder={canSend ? 'Send a message' : 'Join chat to send'}
				aria-label="Chat message"
				maxlength="500"
				rows="2"
				disabled={room?.status === 'closed'}
				data-testid="chat-input"
				onkeydown={onKeydown}
			></textarea>
			<button
				type="submit"
				disabled={busy || joinBusy || !draft.trim() || room?.status === 'closed'}
				aria-label="Send chat message"
				data-testid="chat-send"
			>
				<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
					<path
						d="M4 12l15-7-4 14-3-5-5-2z"
						stroke="currentColor"
						stroke-width="1.8"
						stroke-linejoin="round"
					/>
				</svg>
			</button>
		</form>

		{#if localError || playState.chatError}
			<p class="chat-error" role="alert" data-testid="chat-error">{localError ?? playState.chatError}</p>
		{/if}
	</section>
{/if}

<style>
	.chat-backdrop {
		position: fixed;
		inset: 0;
		z-index: 38;
		border: 0;
		padding: 0;
		background: rgba(3, 2, 10, 0.34);
		backdrop-filter: blur(2px);
		-webkit-backdrop-filter: blur(2px);
		pointer-events: auto;
	}

	.chat {
		--chat-bg: linear-gradient(180deg, rgba(13, 8, 27, 0.94), rgba(7, 5, 17, 0.92));
		display: flex;
		flex-direction: column;
		min-height: 0;
		border: 1px solid rgba(255, 255, 255, 0.14);
		border-radius: 8px;
		background: var(--chat-bg);
		box-shadow: 0 24px 70px -36px rgba(0, 0, 0, 0.86);
		color: var(--color-bone, #f5f0ff);
		overflow: hidden;
		pointer-events: auto;
		backdrop-filter: blur(14px);
		-webkit-backdrop-filter: blur(14px);
	}
	.chat.panel {
		width: 100%;
		min-height: 340px;
		max-height: min(460px, 58vh);
	}
	.chat.drawer {
		position: fixed;
		top: max(58px, calc(14px + env(safe-area-inset-top)));
		right: max(12px, env(safe-area-inset-right));
		bottom: max(12px, env(safe-area-inset-bottom));
		z-index: 39;
		width: min(370px, calc(100vw - 24px));
	}

	.chat-head {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 14px 10px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.09);
		background: linear-gradient(90deg, rgba(92, 223, 255, 0.08), rgba(255, 43, 199, 0.08));
	}
	.chat-kicker {
		display: block;
		font-family: var(--font-display);
		font-size: 0.58rem;
		letter-spacing: 0.24em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.5);
	}
	h2 {
		margin: 2px 0 0;
		font-family: var(--font-display);
		font-size: 1.05rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		line-height: 1;
	}
	.close {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		border-radius: 8px;
		border: 1px solid rgba(255, 255, 255, 0.14);
		background: rgba(255, 255, 255, 0.05);
		color: rgba(255, 255, 255, 0.74);
		cursor: pointer;
	}
	.close svg {
		width: 18px;
		height: 18px;
	}

	.messages {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-width: thin;
	}
	.empty {
		flex: 1;
		display: grid;
		place-items: center;
		min-height: 120px;
		color: rgba(255, 255, 255, 0.45);
		font-family: var(--font-display);
		font-size: 0.72rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
	}
	.message {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding: 9px 10px 10px 12px;
		border-left: 2px solid var(--seat);
		background: rgba(255, 255, 255, 0.045);
	}
	.message.mine {
		background: color-mix(in srgb, var(--seat) 12%, rgba(255, 255, 255, 0.045));
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		font-size: 0.66rem;
		color: rgba(255, 255, 255, 0.58);
	}
	.dot {
		flex: 0 0 auto;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--seat);
		box-shadow: 0 0 10px var(--seat);
	}
	.meta strong {
		min-width: 0;
		max-width: 42%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-display);
		font-size: 0.72rem;
		letter-spacing: 0.05em;
		color: rgba(255, 255, 255, 0.88);
	}
	.role {
		text-transform: uppercase;
		letter-spacing: 0.12em;
	}
	time {
		margin-left: auto;
		font-variant-numeric: tabular-nums;
	}
	p {
		margin: 0;
		overflow-wrap: anywhere;
		line-height: 1.35;
		color: rgba(255, 255, 255, 0.86);
		font-size: 0.88rem;
	}

	.join {
		flex: 0 0 auto;
		padding: 0 12px 9px;
	}
	input,
	textarea {
		width: 100%;
		box-sizing: border-box;
		border-radius: 6px;
		border: 1px solid rgba(255, 255, 255, 0.14);
		background: rgba(0, 0, 0, 0.3);
		color: #fff;
		font: inherit;
		outline: none;
	}
	input {
		height: 38px;
		padding: 0 11px;
	}
	textarea {
		min-height: 44px;
		max-height: 110px;
		padding: 9px 10px;
		resize: vertical;
	}
	input:focus,
	textarea:focus {
		border-color: rgba(92, 223, 255, 0.55);
		box-shadow: 0 0 0 2px rgba(92, 223, 255, 0.12);
	}
	.composer {
		flex: 0 0 auto;
		display: grid;
		grid-template-columns: minmax(0, 1fr) 44px;
		gap: 8px;
		padding: 10px 12px 12px;
		border-top: 1px solid rgba(255, 255, 255, 0.09);
	}
	.composer button {
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		border-radius: 8px;
		border: 1px solid rgba(92, 223, 255, 0.42);
		background: rgba(92, 223, 255, 0.12);
		color: #dff9ff;
		cursor: pointer;
	}
	.composer button:disabled {
		opacity: 0.38;
		cursor: not-allowed;
	}
	.composer svg {
		width: 19px;
		height: 19px;
	}
	.chat-error {
		flex: 0 0 auto;
		padding: 0 12px 12px;
		color: var(--color-blood, #ff4d6d);
		font-size: 0.78rem;
	}

	@media (orientation: landscape) and (max-height: 520px) and (pointer: coarse) {
		.chat.drawer {
			top: max(8px, env(safe-area-inset-top));
			right: calc(48px + env(safe-area-inset-right));
			bottom: max(8px, env(safe-area-inset-bottom));
			width: min(340px, calc(100vw - 72px));
		}
		.chat-head {
			padding: 9px 11px 8px;
		}
		.messages {
			padding: 9px;
			gap: 7px;
		}
		.message {
			padding: 7px 8px 8px 10px;
		}
		.composer {
			padding: 8px 9px 9px;
		}
	}

	@media (max-width: 600px) and (orientation: portrait) {
		.chat.drawer {
			top: auto;
			left: 0;
			right: 0;
			bottom: 0;
			width: auto;
			max-height: min(76vh, 560px);
			border-radius: 12px 12px 0 0;
		}
	}
</style>

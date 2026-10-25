<script lang="ts">
	import type {
		GameCommand,
		NavigationDestination,
		SeatColor,
		SpectatorProjection
	} from '$lib/play/types';
	import {
		navigationPowerById,
		isNavigationPowerRune,
		type NavigationPowerId
	} from '$lib/play/navigationPowers';

	interface Props {
		room: SpectatorProjection;
		mySeat: SeatColor | null;
		destination: NavigationDestination | null;
		busy: boolean;
		error?: string | null;
		onCommit: (powerId: NavigationPowerId | null) => void;
		onCancel: () => void;
		onCommand: (command: GameCommand) => void;
	}
	let {
		room,
		mySeat,
		destination,
		busy,
		error = null,
		onCommit,
		onCancel,
		onCommand
	}: Props = $props();
	const player = $derived(mySeat ? room.players[mySeat] : null);
	const draft = $derived(player?.pendingPowerDrafts?.[0] ?? []);
	const offer = $derived(
		player?.navigationPowerOffers?.find((entry) => entry.mandatory) ??
			player?.navigationPowerOffers?.[0] ??
			null
	);
	const inventory = $derived(player?.powerInventory ?? []);
	let replacementPower = $state<NavigationPowerId | ''>('');
	const replacing = $derived(!!player?.pendingPowerReplacement);
	const replacementTrade = $derived(player?.navigationDestination === 'Fire Region');
	const committed = $derived(
		navigationPowerById(player?.navigationPower ?? player?.pendingNavigationPower)
	);
	const trade = $derived(player?.pendingNavigationTrade ?? null);
	const incomingTrade = $derived(!!trade && trade.toSeat === mySeat);
	const tradeEnabled = $derived(!!player?.navigationPowerTradeEnabled && room.phase === 'location');
	const tradePartners = $derived(
		room.activeSeats.filter(
			(seat) =>
				seat !== mySeat &&
				room.players[seat]?.navigationDestination === player?.navigationDestination
		)
	);
	let tradeOpen = $state(false);
	let acquireOpen = $state(false);
	const availableRunes = $derived((player?.mats ?? []).filter(isNavigationPowerRune));
	const canAcquire = $derived(
		room.phase === 'location' &&
			!!player &&
			!player.phaseReady &&
			player.navigationDestination !== 'Arcane Abyss' &&
			(!replacementTrade || inventory.length > 0) &&
			availableRunes.length > 0
	);
	let partner = $state<SeatColor | ''>('');
	let giveSpirits = $state<number[]>([]);
	let receiveSpirits = $state<number[]>([]);
	let giveRunes = $state<number[]>([]);
	let receiveRunes = $state<number[]>([]);
	const partnerPlayer = $derived(partner ? room.players[partner] : null);
	const show = $derived(
		room.status === 'active' &&
			!!player &&
			(incomingTrade || draft.length > 0 || !!offer || !!destination || tradeOpen || acquireOpen)
	);

	$effect(() => {
		if (replacementPower && !inventory.includes(replacementPower)) replacementPower = '';
		if (!tradeEnabled || room.status !== 'active') tradeOpen = false;
		if (!canAcquire || room.status !== 'active') acquireOpen = false;
	});
	function focusModal(node: HTMLElement) {
		const previous = document.activeElement as HTMLElement | null;
		const focusable = () =>
			Array.from(
				node.querySelectorAll<HTMLElement>(
					'button:not([disabled]),select:not([disabled]),input:not([disabled]),[tabindex="0"]'
				)
			);
		queueMicrotask(() => focusable()[0]?.focus());
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && !offer && !draft.length && !incomingTrade && !busy) {
				event.preventDefault();
				tradeOpen = false;
				acquireOpen = false;
				onCancel();
			}
			if (event.key !== 'Tab') return;
			const items = focusable();
			const first = items[0];
			const last = items.at(-1);
			if (!first) {
				event.preventDefault();
				node.focus();
			} else if (
				event.shiftKey &&
				(document.activeElement === first || !node.contains(document.activeElement))
			) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};
		node.addEventListener('keydown', onKeyDown);
		return {
			destroy() {
				node.removeEventListener('keydown', onKeyDown);
				previous?.focus();
			}
		};
	}
	function choosePartner(value: string) {
		partner = value as SeatColor | '';
		receiveSpirits = [];
		receiveRunes = [];
	}
	function toggle(values: number[], slot: number, checked: boolean): number[] {
		return checked ? [...values, slot] : values.filter((value) => value !== slot);
	}
	function proposeTrade() {
		if (!partner) return;
		onCommand({
			type: 'tradeNavigationPower',
			targetSeat: partner,
			giveSpiritSlots: giveSpirits,
			receiveSpiritSlots: receiveSpirits,
			giveRuneSlots: giveRunes,
			receiveRuneSlots: receiveRunes
		});
		tradeOpen = false;
		giveSpirits = [];
		receiveSpirits = [];
		giveRunes = [];
		receiveRunes = [];
	}
	function tradeAssetNames(seat: SeatColor, spiritSlots: number[], runeSlots: number[]) {
		const owner = room.players[seat];
		return (
			[
				...spiritSlots.map(
					(slot) => owner?.spirits.find((spirit) => spirit.slotIndex === slot)?.name ?? 'Spirit'
				),
				...runeSlots.map(
					(slot) => owner?.mats.find((rune) => rune.slotIndex === slot)?.name ?? 'Rune'
				)
			].join(', ') || 'Nothing'
		);
	}
</script>

{#if room.status === 'active' && player && (committed || inventory.length || tradeEnabled || trade || canAcquire)}
	<aside class="power-status" data-testid="navigation-power-status" aria-label="Navigation Powers">
		{#if committed}<span data-testid="committed-navigation-power"
				><strong>{committed.name}</strong><small
					>{player.pendingNavigationPower ? 'Committed' : 'Played this round'}</small
				></span
			>{/if}
		{#if inventory.length}<span
				>{inventory.length} Power{inventory.length === 1 ? '' : 's'} held</span
			>{/if}
		{#if canAcquire}<button
				type="button"
				disabled={busy}
				data-testid="gain-navigation-power"
				onclick={() => {
					acquireOpen = true;
					tradeOpen = false;
				}}>Gain a Power</button
			>{/if}
		{#if tradeEnabled && !trade}
			<button
				type="button"
				disabled={busy || tradePartners.length === 0}
				data-testid="navigation-power-trade"
				onclick={() => {
					partner = tradePartners[0] ?? '';
					tradeOpen = true;
					acquireOpen = false;
				}}>Trade</button
			>
		{/if}
		{#if trade && !incomingTrade}<span data-testid="navigation-power-trade-waiting"
				>Trade offered to {room.players[trade.toSeat]?.displayName ?? trade.toSeat}</span
			>{/if}
	</aside>
{/if}

{#if show}
	<div class="power-overlay" role="presentation">
		<div
			class="power-card"
			role="dialog"
			aria-modal="true"
			aria-labelledby="power-heading"
			tabindex="-1"
			use:focusModal
			data-testid="navigation-power-panel"
		>
			<header>
				<div>
					<span class="eyebrow">Navigation Power</span>
					<h2 id="power-heading">
						{offer?.mandatory
							? (navigationPowerById(offer.powerId)?.name ?? 'Resolve Power')
							: incomingTrade
								? 'Trade offer'
								: draft.length
									? 'Choose a Power'
									: offer
										? (navigationPowerById(offer.powerId)?.name ?? 'Resolve Power')
										: tradeOpen
											? 'Trade at your location'
											: acquireOpen
												? 'Gain a Power'
												: 'Play a Power?'}
					</h2>
				</div>
				{#if !incomingTrade && !draft.length && !offer}<button
						type="button"
						class="quiet"
						disabled={busy}
						aria-label="Cancel power selection"
						onclick={() => {
							tradeOpen = false;
							acquireOpen = false;
							onCancel();
						}}>Cancel</button
					>{/if}
			</header>
			{#if error}<p class="power-error" role="alert">{error}</p>{/if}

			{#if incomingTrade && trade && !offer?.mandatory}
				<p>{room.players[trade.fromSeat]?.displayName ?? trade.fromSeat} offers a trade.</p>
				<div class="trade-summary">
					<strong>You receive</strong>
					<p>{tradeAssetNames(trade.fromSeat, trade.giveSpiritSlots, trade.giveRuneSlots)}</p>
					<strong>You give</strong>
					<p>{tradeAssetNames(trade.toSeat, trade.receiveSpiritSlots, trade.receiveRuneSlots)}</p>
				</div>
				<div class="actions">
					<button
						type="button"
						disabled={busy}
						data-testid="navigation-trade-accept"
						onclick={() =>
							onCommand({ type: 'respondNavigationPowerTrade', tradeId: trade.id, accept: true })}
						>Accept trade</button
					><button
						type="button"
						class="quiet"
						disabled={busy}
						data-testid="navigation-trade-decline"
						onclick={() =>
							onCommand({ type: 'respondNavigationPowerTrade', tradeId: trade.id, accept: false })}
						>Decline</button
					>
				</div>
			{:else if draft.length && !offer?.mandatory}
				<p>
					{replacing
						? 'Choose a held Power to replace, then choose its replacement.'
						: 'Choose one to keep. The other Powers return to the pool.'}
				</p>
				{#if replacing}
					<label class="partner"
						>Replace<select
							data-testid="power-to-replace"
							bind:value={replacementPower}
							disabled={busy}
						>
							<option value="">Choose a held Power</option>
							{#each [...new Set(inventory)] as held}<option value={held}
									>{navigationPowerById(held)?.name}</option
								>{/each}
						</select></label
					>
				{/if}
				<div class="options" data-testid="navigation-power-draft">
					{#each draft as id, index (`${id}:${index}`)}
						{@const power = navigationPowerById(id)}
						<button
							type="button"
							disabled={busy || (replacing && (!replacementPower || replacementPower === id))}
							data-testid={`draft-power-${id}`}
							onclick={() =>
								onCommand({
									type: 'chooseNavigationPower',
									powerId: id,
									...(replacing && replacementPower ? { replacePowerId: replacementPower } : {})
								})}><strong>{power?.name ?? id}</strong><span>{power?.text ?? ''}</span></button
						>
					{/each}
				</div>
			{:else if offer}
				<p>{offer.prompt ?? navigationPowerById(offer.powerId)?.text}</p>
				<div class="options" data-testid="navigation-power-offer">
					{#each offer.options as option (option.id)}
						<button
							type="button"
							class:quiet={option.id === 'decline'}
							disabled={busy}
							data-testid={`power-option-${option.id}`}
							onclick={() =>
								onCommand({
									type: 'resolveNavigationPower',
									offerId: offer.id,
									optionId: option.id
								})}>{option.label}</button
						>
					{/each}
				</div>
			{:else if acquireOpen}
				<p>
					{replacementTrade
						? 'Pay 1 Origin Rune to replace a held Power. Reveal 3 and choose 1.'
						: 'Pay 1 Origin Rune. Reveal 3 Powers and choose 1 to keep.'}
				</p>
				<div class="options">
					{#each availableRunes as rune (rune.slotIndex)}
						<button
							type="button"
							disabled={busy}
							data-testid={`power-pay-rune-${rune.slotIndex}`}
							onclick={() =>
								onCommand({ type: 'acquireNavigationPower', runeSlot: rune.slotIndex })}
							>Pay {rune.name ?? 'Rune'}</button
						>
					{/each}
				</div>
			{:else if tradeOpen}
				<label class="partner"
					>Trade with<select
						value={partner}
						disabled={busy}
						onchange={(event) => choosePartner(event.currentTarget.value)}
						data-testid="navigation-trade-partner"
						>{#each tradePartners as seat (seat)}<option value={seat}
								>{room.players[seat]?.displayName ?? seat}</option
							>{/each}</select
					></label
				>
				<div class="trade-grid">
					<fieldset>
						<legend>You give</legend>
						{#each player?.spirits ?? [] as spirit (spirit.slotIndex)}<label
								><input
									type="checkbox"
									checked={giveSpirits.includes(spirit.slotIndex)}
									onchange={(event) =>
										(giveSpirits = toggle(
											giveSpirits,
											spirit.slotIndex,
											event.currentTarget.checked
										))}
								/>{spirit.name}</label
							>{/each}
						{#each (player?.mats ?? []).filter( (rune) => isNavigationPowerRune(rune) ) as rune (rune.slotIndex)}<label
								><input
									type="checkbox"
									checked={giveRunes.includes(rune.slotIndex)}
									onchange={(event) =>
										(giveRunes = toggle(giveRunes, rune.slotIndex, event.currentTarget.checked))}
								/>{rune.name ?? 'Rune'}</label
							>{/each}
					</fieldset>
					<fieldset>
						<legend>You receive</legend>
						{#each partnerPlayer?.spirits ?? [] as spirit (spirit.slotIndex)}<label
								><input
									type="checkbox"
									checked={receiveSpirits.includes(spirit.slotIndex)}
									onchange={(event) =>
										(receiveSpirits = toggle(
											receiveSpirits,
											spirit.slotIndex,
											event.currentTarget.checked
										))}
								/>{spirit.name}</label
							>{/each}
						{#each (partnerPlayer?.mats ?? []).filter( (rune) => isNavigationPowerRune(rune) ) as rune (rune.slotIndex)}<label
								><input
									type="checkbox"
									checked={receiveRunes.includes(rune.slotIndex)}
									onchange={(event) =>
										(receiveRunes = toggle(
											receiveRunes,
											rune.slotIndex,
											event.currentTarget.checked
										))}
								/>{rune.name ?? 'Rune'}</label
							>{/each}
					</fieldset>
				</div>
				<p class="muted">Nothing moves until the other player accepts.</p>
				<div class="actions">
					<button
						type="button"
						disabled={busy ||
							!partner ||
							!(
								giveSpirits.length +
								receiveSpirits.length +
								giveRunes.length +
								receiveRunes.length
							)}
						data-testid="navigation-trade-propose"
						onclick={proposeTrade}>Offer trade</button
					><button type="button" class="quiet" disabled={busy} onclick={() => (tradeOpen = false)}
						>Cancel</button
					>
				</div>
			{:else if destination}
				<p>{destination} · Select one held Power, or keep them for later.</p>
				<div class="options" data-testid="navigation-power-inventory">
					<button
						type="button"
						class="quiet"
						disabled={busy}
						data-testid="navigation-no-power"
						onclick={() => onCommit(null)}>No Power — lock destination</button
					>
					{#each inventory as id, index (`${id}:${index}`)}
						{@const power = navigationPowerById(id)}
						<button
							type="button"
							disabled={busy}
							data-testid={`play-power-${id}`}
							onclick={() => onCommit(id)}
							><strong>{power?.name ?? id}</strong><span>{power?.text ?? ''}</span></button
						>
					{/each}
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.power-overlay {
		position: fixed;
		inset: 0;
		z-index: 1600;
		display: grid;
		place-items: center;
		padding: 16px;
		background: rgb(4 3 12 / 0.75);
		backdrop-filter: blur(10px);
		color: #f6f3ff;
	}
	.power-card {
		width: min(620px, 100%);
		max-height: 85dvh;
		overflow: auto;
		padding: 24px;
		border: 1px solid rgb(255 255 255 / 0.18);
		border-radius: 20px;
		background: linear-gradient(145deg, #191630, #0b0a1a);
		box-shadow: 0 24px 80px rgb(0 0 0 / 0.5);
		box-sizing: border-box;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 16px;
	}
	h2 {
		font-size: 1.4rem;
		margin: 4px 0;
	}
	p {
		font-size: 0.9rem;
		line-height: 1.5;
		color: #d2cede;
	}
	.eyebrow {
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.15em;
		color: #5cdfff;
	}
	.options {
		display: grid;
		gap: 9px;
		margin-top: 18px;
	}
	button {
		font: inherit;
		color: inherit;
		cursor: pointer;
		border: 1px solid rgb(92 223 255 / 0.4);
		border-radius: 10px;
		background: rgb(92 223 255 / 0.12);
		padding: 11px 14px;
		text-align: left;
		min-height: 44px;
	}
	button:disabled {
		opacity: 0.45;
		cursor: wait;
	}
	button:hover:not(:disabled),
	button:focus-visible {
		outline: 2px solid #5cdfff;
		outline-offset: 2px;
	}
	.options button {
		display: grid;
		gap: 5px;
	}
	.options span {
		font-size: 0.85rem;
		line-height: 1.4;
		color: #d2cede;
	}
	.quiet {
		border-color: rgb(255 255 255 / 0.18);
		background: rgb(255 255 255 / 0.05);
	}
	.power-status {
		position: fixed;
		bottom: max(80px, calc(env(safe-area-inset-bottom) + 68px));
		left: 50%;
		transform: translateX(-50%);
		z-index: 60;
		display: flex;
		align-items: center;
		gap: 12px;
		max-width: 90vw;
		padding: 8px 14px;
		border: 1px solid rgb(92 223 255 / 0.2);
		border-radius: 12px;
		background: #141027;
		color: #ece9fa;
		box-shadow: 0 4px 20px #0006;
		font-size: 0.76rem;
	}
	.power-status span {
		display: grid;
		gap: 3px;
	}
	.power-status small {
		font-size: 0.68rem;
		color: #a9a4bd;
	}
	.power-status button {
		padding: 5px 12px;
		min-height: 44px;
	}
	.power-error {
		padding: 10px 12px;
		border-left: 3px solid #e05858;
		background: rgb(110 18 35 / 0.45);
		color: #ffe8ed;
	}
	.actions {
		display: flex;
		gap: 10px;
		margin-top: 16px;
		flex-wrap: wrap;
	}
	.partner {
		display: grid;
		gap: 7px;
		margin: 16px 0;
		font-size: 0.9rem;
	}
	select {
		font: inherit;
		padding: 9px;
		border-radius: 8px;
		background: #201b3b;
		color: #fff;
		border: 1px solid #635b7d;
	}
	.trade-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}
	.trade-grid fieldset {
		border: 1px solid #4b425e;
		border-radius: 8px;
		min-width: 0;
	}
	.trade-grid legend {
		font-weight: bold;
		font-size: 0.9rem;
	}
	.trade-grid label {
		display: flex;
		gap: 8px;
		align-items: center;
		min-height: 44px;
		font-size: 0.8rem;
	}
	.trade-grid input {
		accent-color: #5cdfff;
	}
	.muted {
		font-size: 0.8rem;
		color: #a9a4bd;
	}
	.trade-summary p {
		margin: 6px 0 15px;
	}
	@media (max-width: 480px) {
		.power-card {
			padding: 18px;
		}
		.trade-grid {
			grid-template-columns: 1fr;
		}
		.power-status {
			bottom: 8px;
			font-size: 0.7rem;
			gap: 8px;
		}
		h2 {
			font-size: 1.2rem;
		}
	}
</style>

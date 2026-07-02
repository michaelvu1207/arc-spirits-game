<script lang="ts">
	import type { PlayerProjection } from '$lib/play/types';
	import type {
		GameLocationAsset,
		IconPoolEntry,
		MatSlotSnapshot,
		RewardIconToken
	} from '$lib/types';
	import {
		buildLocationInteractions,
		canAfford,
		eligibleCostSlots,
		isWildcardCost,
		meaningFor,
		type LocationInteraction
	} from '$lib/play/locationInteractions';
	import { awakenedClassCounts } from '$lib/play/effects/apply';
	import type { getAssetState } from '$lib/stores/assetStore.svelte';
	import { runeIconUrl, storageUrl } from './helpers';

	interface Props {
		location: GameLocationAsset | null;
		iconPool?: Map<string, IconPoolEntry>;
		/** Full asset state — used to draw the icons of held relics/runes in the
		 *  "which to discard" chooser for wildcard costs. */
		assets: ReturnType<typeof getAssetState>;
		player: PlayerProjection | null;
		accent?: string;
		busy?: boolean;
		onResolve?: (rowIndex: number, choices: number[], costChoices: number[]) => void;
	}

	let {
		location,
		iconPool = new Map(),
		assets,
		player,
		accent = 'var(--brand-violet, #5a2bff)',
		busy = false,
		onResolve
	}: Props = $props();

	// A wildcard cost ("any relic" / "any basic rune") where the player holds more
	// than one eligible item to discard — each is the player's choice. `slots` are the
	// held mats (with their array index into player.mats) that could pay cost slot `ci`.
	type CostChooser = { ci: number; slots: { arrayIndex: number; slot: MatSlotSnapshot }[] };
	function costChooserFor(
		interaction: LocationInteraction,
		ci: number
	): CostChooser['slots'] | null {
		const mats = player?.mats ?? [];
		const req = interaction.cost[ci];
		if (!req || !isWildcardCost(req)) return null;
		// Collapse identical held items to one option — discarding any one of four copies of
		// the same relic is the same choice, so show each DISTINCT item once.
		const seen = new Set<string>();
		const distinct: CostChooser['slots'] = [];
		for (const arrayIndex of eligibleCostSlots(req, mats)) {
			const slot = mats[arrayIndex];
			const key = slot.id ?? `${slot.name ?? ''}|${slot.type ?? ''}|${slot.originId ?? ''}`;
			if (seen.has(key)) continue;
			seen.add(key);
			distinct.push({ arrayIndex, slot });
		}
		// Only a real *choice* (>1 distinct item) needs UX — otherwise any one auto-pays.
		return distinct.length >= 2 ? distinct : null;
	}
	function costChoosers(interaction: LocationInteraction): CostChooser[] {
		const out: CostChooser[] = [];
		interaction.cost.forEach((_req, ci) => {
			const slots = costChooserFor(interaction, ci);
			if (slots) out.push({ ci, slots });
		});
		return out;
	}
	function slotIconUrl(slot: MatSlotSnapshot): string | null {
		return runeIconUrl(assets, slot);
	}

	// Per-row, per-cost-slot discard pick: costSel[rowIndex][ci] = chosen mat array index.
	let costSel = $state<Record<number, Record<number, number>>>({});
	function chosenCostIndex(rowIndex: number, ci: number, fallback: number): number {
		return costSel[rowIndex]?.[ci] ?? fallback;
	}
	function selectCost(rowIndex: number, ci: number, arrayIndex: number) {
		costSel = { ...costSel, [rowIndex]: { ...(costSel[rowIndex] ?? {}), [ci]: arrayIndex } };
	}

	const interactions = $derived(buildLocationInteractions(location?.reward_rows));
	const usedRows = $derived(player?.actionsUsedThisRound ?? []);
	// Per-row use allowance: 1 + Child Prodigy's locationInteraction credit ("you may
	// do ALL location interactions up to two times"). When >1 we render one card per
	// allowed use, each spent left-to-right as the player resolves the row.
	const rowAllowance = $derived(1 + (player?.extraActions?.locationInteraction ?? 0));

	// Per-row choices for "or" gains: choices[rowIndex][k] = selected option index.
	let choices = $state<Record<number, number[]>>({});
	// The row most recently resolved — only this flipped card shows the detailed
	// result log (lastAction holds just the latest outcome).
	let lastRow = $state<number | null>(null);

	function isOr(token: RewardIconToken): token is { kind: 'or'; icon_ids: string[] } {
		return typeof token !== 'string';
	}
	function iconUrl(id: string): string | null {
		return storageUrl(iconPool.get(id)?.file_path ?? null);
	}
	// Icon sizing: a consistent set size for every icon, larger when an icon stands
	// alone, and much larger for game-action tokens (Summon / Cultivate / Rest).
	function iconSize(token: string, soloRow: boolean): 'act' | 'solo' | 'base' {
		if (meaningFor(token)?.kind === 'action') return 'act';
		return soloRow ? 'solo' : 'base';
	}

	// A card is "dense" when it carries many reward icons / chooser options. Dense
	// cards shrink their icons + chrome (see .int-card.dense CSS) so every option
	// stays visible inside the fixed-size card instead of overflowing and being
	// clipped (the card is overflow:hidden) — this is the "lots of choices" case.
	function iconSlotCount(interaction: LocationInteraction): number {
		let n = interaction.costTokens.length;
		for (const t of interaction.gainTokens) n += isOr(t) ? t.icon_ids.length : 1;
		return n;
	}
	function isDense(interaction: LocationInteraction): boolean {
		if (iconSlotCount(interaction) >= 4) return true;
		return interaction.gainTokens.some((t) => isOr(t) && t.icon_ids.length >= 3);
	}

	function orSlotOf(interaction: LocationInteraction, tokenIndex: number): number {
		let slot = 0;
		for (let i = 0; i < tokenIndex; i += 1) if (isOr(interaction.gainTokens[i])) slot += 1;
		return slot;
	}
	function selectedOption(rowIndex: number, orSlot: number): number {
		return choices[rowIndex]?.[orSlot] ?? 0;
	}
	function selectOption(rowIndex: number, orSlot: number, optionIndex: number) {
		const current = choices[rowIndex] ? [...choices[rowIndex]] : [];
		current[orSlot] = optionIndex;
		choices = { ...choices, [rowIndex]: current };
	}

	// How many times this row has already been resolved this round (0..rowAllowance).
	function usedCount(interaction: LocationInteraction): number {
		return usedRows.filter((a) => a === `row:${interaction.rowIndex}`).length;
	}
	// A trade whose cost is WAIVED for this player — mirrors the runtime waiver in
	// resolveLocationInteraction so the card isn't disabled in the exact case the
	// ability exists for (an awakened Mod Injector / Undercover who lacks the runes):
	//   • Mod Injector — any Spirit-Augment trade is free while awakened.
	//   • Undercover — the player's next rune→relic trade is free (one-shot flag).
	function freeTrade(interaction: LocationInteraction): boolean {
		if (!player || interaction.cost.length === 0) return false;
		// Resolve what the trade grants, honoring an "or" gain's currently-selected
		// option (mirrors the runtime waiver in resolveLocationInteraction).
		const picks = choices[interaction.rowIndex] ?? [];
		let grantsAugment = false;
		let grantsRelic = false;
		let cursor = 0;
		for (const g of interaction.gains) {
			if (g.type === 'rune') {
				if (g.rune.type === 'augment') grantsAugment = true;
				if (g.rune.type === 'relic') grantsRelic = true;
			} else if (g.type === 'chooseRune') {
				const chosen = g.options[picks[cursor] ?? 0] ?? g.options[0];
				cursor += 1;
				if (chosen?.type === 'augment') grantsAugment = true;
				if (chosen?.type === 'relic') grantsRelic = true;
			}
		}
		const modInjectorFree =
			(awakenedClassCounts(player)['Mod Injector'] ?? 0) >= 1 && grantsAugment;
		const undercoverFree = !!player.freeNextRelicTrade && grantsRelic;
		return modInjectorFree || undercoverFree;
	}
	function affordable(interaction: LocationInteraction): boolean {
		return freeTrade(interaction) || canAfford(interaction, player?.mats ?? []);
	}
	// A specific card instance (`inst`, 0-based) is spent once that many uses have
	// been made; instances fill left-to-right.
	function instUsed(interaction: LocationInteraction, inst: number): boolean {
		return inst < usedCount(interaction);
	}
	function instDisabled(interaction: LocationInteraction, inst: number): boolean {
		return busy || instUsed(interaction, inst) || !affordable(interaction);
	}

	function resolve(interaction: LocationInteraction, inst: number) {
		if (instDisabled(interaction, inst)) return;
		lastRow = interaction.rowIndex; // this card will show the detailed result
		// The held-mat array index the player chose to discard for each wildcard cost
		// (defaults to the first eligible item, matching the old auto-pick).
		const costChoices = costChoosers(interaction).map((c) =>
			chosenCostIndex(interaction.rowIndex, c.ci, c.slots[0].arrayIndex)
		);
		onResolve?.(interaction.rowIndex, choices[interaction.rowIndex] ?? [], costChoices);
	}

	function resultLines(interaction: LocationInteraction, inst: number): string[] {
		// Only the most-recently-resolved instance of the most-recent row shows the
		// detailed log; earlier/other flipped cards read as a plain "claimed".
		const lastInst = usedCount(interaction) - 1;
		if (interaction.rowIndex === lastRow && inst === lastInst && player?.lastAction?.log?.length) {
			return player.lastAction.log;
		}
		return ['Claimed this round.'];
	}
</script>

{#snippet icon(url: string | null, size: 'act' | 'solo' | 'base')}
	<span class="ico {size}">
		{#if url}<img src={url} alt="" loading="lazy" />{/if}
	</span>
{/snippet}

{#if interactions.length === 0}
	<div class="empty" data-testid="no-interactions">No interactions here — pass your turn.</div>
{:else}
	<div class="int-scroll">
		<div class="int-grid" data-testid="interaction-grid">
			{#each interactions as interaction (interaction.rowIndex)}
				{#each Array(rowAllowance) as _, inst (inst)}
					{@const isUsed = instUsed(interaction, inst)}
					{@const cantAfford = !affordable(interaction)}
					{@const isTrade = interaction.kind === 'trade'}
					{@const soloGain = interaction.gainTokens.length === 1}
					{@const soloCost = interaction.costTokens.length === 1}
					<div
						class="int-card"
						class:disabled={instDisabled(interaction, inst)}
						class:flipped={isUsed}
						class:trade={isTrade}
						class:dense={isDense(interaction)}
						style="--accent: {accent}"
						role="button"
						tabindex={instDisabled(interaction, inst) ? -1 : 0}
						data-testid={rowAllowance > 1
							? `interaction-${interaction.rowIndex}-${inst}`
							: `interaction-${interaction.rowIndex}`}
						onclick={() => resolve(interaction, inst)}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								resolve(interaction, inst);
							}
						}}
					>
						<div class="flipper" class:flipped={isUsed}>
							<!-- Front: the interaction -->
							<div class="face front">
								<div class="flow">
									{#if isTrade}
										<div class="row cost">
											{#each interaction.costTokens as token, ci (ci)}
												{@const costOpts = costChooserFor(interaction, ci)}
												{#if costOpts}
													{@const pickedIdx = chosenCostIndex(
														interaction.rowIndex,
														ci,
														costOpts[0].arrayIndex
													)}
													<span
														class="chooser"
														role="group"
														aria-label="Choose which one to discard"
													>
														<span class="chooser-label">
															<span class="tap-dot" aria-hidden="true"></span>Discard one
														</span>
														<span class="chooser-opts">
															{#each costOpts as opt, oi (opt.arrayIndex)}
																<button
																	type="button"
																	class="opt"
																	class:selected={pickedIdx === opt.arrayIndex}
																	aria-pressed={pickedIdx === opt.arrayIndex}
																	title="Tap to discard {opt.slot.name ?? 'this'}"
																	onclick={(e) => {
																		e.stopPropagation();
																		selectCost(interaction.rowIndex, ci, opt.arrayIndex);
																	}}
																>
																	{@render icon(slotIconUrl(opt.slot), 'base')}
																</button>
															{/each}
														</span>
													</span>
												{:else if !isOr(token)}
													{@render icon(iconUrl(token), iconSize(token, soloCost))}
												{/if}
											{/each}
										</div>
										<span class="arrow" aria-hidden="true">
											<svg viewBox="0 0 24 28" width="22" height="26">
												<path
													d="M12 2 V20 M5 14 L12 22 L19 14"
													fill="none"
													stroke="currentColor"
													stroke-width="2.4"
													stroke-linecap="round"
													stroke-linejoin="round"
												/>
											</svg>
										</span>
									{/if}

									<div class="row gain">
										{#each interaction.gainTokens as token, ti (ti)}
											{#if isOr(token)}
												{@const slot = orSlotOf(interaction, ti)}
												{@const picked = selectedOption(interaction.rowIndex, slot)}
												<span class="chooser" role="group" aria-label="Choose one of these rewards">
													<span class="chooser-label">
														<span class="tap-dot" aria-hidden="true"></span>Choose one
													</span>
													<span class="chooser-opts">
														{#each token.icon_ids as optId, oi (optId + oi)}
															<button
																type="button"
																class="opt"
																class:selected={picked === oi}
																aria-pressed={picked === oi}
																title="Tap to choose this reward"
																onclick={(e) => {
																	e.stopPropagation();
																	selectOption(interaction.rowIndex, slot, oi);
																}}
															>
																{@render icon(iconUrl(optId), 'base')}
															</button>
														{/each}
													</span>
												</span>
											{:else}
												{@render icon(iconUrl(token), iconSize(token, soloGain))}
											{/if}
										{/each}
									</div>
								</div>

								<span class="cta" class:locked={cantAfford}>
									{#if cantAfford}
										<span class="lock" aria-hidden="true"></span>Can't afford
									{:else if isTrade}
										Pay · Take
									{:else}
										Take
									{/if}
								</span>
							</div>

							<!-- Back: the result (shown once resolved; the card reads as disabled) -->
							<div class="face back">
								<div class="type result">
									<span class="check" aria-hidden="true"></span>
									<span class="type-label">{isTrade ? 'Trade' : 'Gain'} complete</span>
								</div>
								<div class="result-body">
									{#each resultLines(interaction, inst) as line, li (li)}
										<p>{line}</p>
									{/each}
								</div>
							</div>
						</div>
					</div>
				{/each}
			{/each}
		</div>
	</div>
{/if}

<style>
		/* Keep the whole card set inside the visible stage. The parent location action view
		   gives this region a stable content track under the instruction header, so the header
		   stays put while the cards center or scroll inside the remaining space. */
		.int-scroll {
			width: 100%;
			flex: 1 1 auto;
			min-height: 0;
			max-height: 100%;
			overflow-y: auto;
			overflow-x: hidden;
			overscroll-behavior: contain;
			-webkit-overflow-scrolling: touch;
			touch-action: pan-y;
			display: flex;
			justify-content: center;
			align-items: flex-start;
			padding: 1rem 0.25rem;
			box-sizing: border-box;
			scrollbar-width: thin;
		}
	.int-grid {
		display: flex;
		flex-wrap: nowrap;
		gap: var(--int-grid-gap, 1rem);
		justify-content: center;
		align-items: stretch;
		/* The GameBoard stage track already excludes the trait list, leaderboard, and
		   rail. Size to that container instead of guessing with viewport math. */
		width: 100%;
		max-width: min(1100px, 100%);
		margin: 0 auto;
		/* Perspective lives here so the cards' content can flip without putting the
		   frosted glass (backdrop-filter) inside a 3D subtree — where it wouldn't render. */
		perspective: 1400px;
	}

	/* ── Card: the frosted-glass panel. The scene behind blurs heavily through it;
	   only the CONTENT flips (inside this static panel), keeping the blur reliable. ── */
	.int-card {
		position: relative;
		display: flex;
		flex: 1 1 0;
		min-width: 0;
		min-height: 0;
		max-width: var(--int-card-max, 17rem);
		overflow: hidden;
		border-radius: var(--int-card-radius, 18px);
		border: 1px solid rgba(255, 255, 255, 0.14);
		background: rgba(15, 10, 28, 0.26);
		-webkit-backdrop-filter: blur(40px) saturate(1.4);
		backdrop-filter: blur(40px) saturate(1.4);
		box-shadow:
			0 16px 44px rgba(0, 0, 0, 0.45),
			inset 0 1px 0 rgba(255, 255, 255, 0.18);
		cursor: pointer;
		transition:
			transform 200ms cubic-bezier(0.22, 1, 0.36, 1),
			border-color 200ms ease,
			box-shadow 200ms ease,
			background 200ms ease,
			opacity 200ms ease;
	}
	@media (hover: hover) and (pointer: fine) {
		.int-card:not(.disabled):hover {
			transform: translateY(-6px);
			border-color: color-mix(in srgb, var(--accent) 55%, rgba(255, 255, 255, 0.25));
			box-shadow:
				0 22px 54px rgba(0, 0, 0, 0.55),
				inset 0 1px 0 rgba(255, 255, 255, 0.22);
		}
	}
	.int-card:not(.disabled):focus-visible {
		outline: none;
		border-color: color-mix(in srgb, var(--accent) 70%, #fff 20%);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent);
	}
	/* A can't-afford card (disabled, not yet used) dims the whole glass panel. */
	.int-card.disabled:not(.flipped) {
		cursor: not-allowed;
		opacity: 0.5;
		filter: saturate(0.75);
	}
	/* A resolved card reads as done — muted glass, but the result stays legible. */
	.int-card.flipped {
		cursor: default;
		background: rgba(10, 7, 20, 0.42);
		border-color: rgba(255, 255, 255, 0.08);
	}

	.flipper {
		position: relative;
		flex: 1;
		display: grid;
		width: 100%;
		transform-style: preserve-3d;
		transition: transform 0.6s cubic-bezier(0.4, 0.15, 0.2, 1);
	}
	.flipper.flipped {
		transform: rotateY(180deg);
	}

	/* Both faces stack in the same grid cell so the card sizes to the larger. The
	   faces are transparent content — the frosted glass is on the static .int-card. */
	.face {
		grid-area: 1 / 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		min-height: 16rem;
		padding: 1.4rem 1.15rem 1.2rem;
		text-align: center;
		-webkit-backface-visibility: hidden;
		backface-visibility: hidden;
	}
	.face.back {
		transform: rotateY(180deg);
		justify-content: center;
		gap: 0.9rem;
	}

	/* ── Type label ────────────────────────────────────────────────────────── */
	.type {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}
	.type-label {
		font-family: var(--font-display);
		font-size: 0.82rem;
		font-weight: 700;
		letter-spacing: 0.3em;
		text-transform: uppercase;
		padding-left: 0.06em;
		color: color-mix(in srgb, var(--accent) 68%, var(--brand-amber, #ffba3d));
	}
	.int-card.trade .type-label {
		color: var(--brand-teal, #20e0c1);
	}
	/* Result heading is calm/muted — the card is done. */
	.type.result .type-label {
		color: var(--color-parchment, #d8d2e8);
	}
	.check {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: color-mix(in srgb, var(--brand-teal, #20e0c1) 80%, transparent);
		position: relative;
		flex: none;
	}
	.check::after {
		content: '';
		position: absolute;
		left: 5px;
		top: 2.5px;
		width: 4px;
		height: 8px;
		border: solid var(--color-void, #0c0518);
		border-width: 0 2px 2px 0;
		transform: rotate(45deg);
	}

	/* ── Flow: cost → chevron → gain ───────────────────────────────────────── */
	.flow {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.28rem;
		flex: 1;
		justify-content: center;
		width: 100%;
	}
	.row {
		display: inline-flex;
		flex-wrap: nowrap;
		align-items: center;
		justify-content: center;
		align-self: center;
		flex: 0 1 auto;
		gap: 0.45rem;
		width: fit-content;
		min-width: 0;
		max-width: 100%;
		margin-inline: auto;
	}
	.arrow {
		display: grid;
		place-items: center;
		color: color-mix(in srgb, var(--accent) 60%, var(--brand-amber, #ffba3d));
		filter: drop-shadow(0 0 6px color-mix(in srgb, var(--accent) 50%, transparent));
		animation: arrow-bob 1.8s ease-in-out infinite;
	}
	@keyframes arrow-bob {
		0%,
		100% {
			transform: translateY(-1px);
			opacity: 0.8;
		}
		50% {
			transform: translateY(3px);
			opacity: 1;
		}
	}

	/* ── Icons — uniform sized boxes, art floats on a soft shadow ──────────── */
	.ico {
		display: inline-grid;
		place-items: center;
		width: var(--icon);
		height: var(--icon);
		flex: 0 0 var(--icon);
	}
	.ico.base {
		--icon: 3rem;
	}
	.ico.solo {
		--icon: 4.75rem;
	}
	/* A game action (Summon / Cultivate / Rest) reads as the headline of the card. */
	.ico.act {
		--icon: 7rem;
	}
	.ico img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		filter: drop-shadow(0 3px 9px rgba(0, 0, 0, 0.6));
		transition:
			transform 200ms cubic-bezier(0.22, 1, 0.36, 1),
			filter 200ms ease;
	}
	@media (hover: hover) and (pointer: fine) {
		.int-card:not(.disabled):hover .ico img {
			transform: scale(1.06);
			filter: drop-shadow(0 6px 16px rgba(0, 0, 0, 0.6));
		}
	}

	/* ── Choice strip — lightweight label with only the icons as tap targets. ── */
	.chooser {
		--choice-size: 3.45rem;
		display: inline-flex;
		flex-direction: column;
		align-items: center;
		flex: 0 1 auto;
		min-width: 0;
		gap: 0.22rem;
		max-width: 100%;
		padding: 0;
		border: 0;
		border-radius: 0;
		background: none;
		box-shadow: none;
	}
	.chooser-label {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-family: var(--font-display);
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--accent) 55%, #fff 45%);
	}
	.tap-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
		box-shadow: 0 0 6px color-mix(in srgb, var(--accent) 80%, transparent);
		animation: tap-pulse 1.6s ease-in-out infinite;
	}
	@keyframes tap-pulse {
		0%,
		100% {
			transform: scale(0.8);
			opacity: 0.55;
		}
		50% {
			transform: scale(1.15);
			opacity: 1;
		}
	}
	.chooser-opts {
		display: inline-flex;
		flex-wrap: nowrap;
		align-items: center;
		justify-content: center;
		flex: 0 1 auto;
		min-width: 0;
		gap: 0.28rem;
		max-width: 100%;
	}
	.opt {
		position: relative;
		display: grid;
		place-items: center;
		width: var(--choice-size);
		height: var(--choice-size);
		min-width: var(--choice-size);
		min-height: var(--choice-size);
		flex: 0 0 var(--choice-size);
		padding: 0.18rem;
		border: 1px solid transparent;
		border-radius: 10px;
		background: transparent;
		cursor: pointer;
		opacity: 0.86;
		transition:
			opacity 140ms ease,
			transform 140ms ease,
			filter 140ms ease,
			background 140ms ease,
			border-color 140ms ease,
			box-shadow 140ms ease;
	}
	.chooser-opts:has(.opt.selected) .opt:not(.selected) {
		opacity: 0.34;
		filter: grayscale(0.7) saturate(0.65);
	}
	@media (hover: hover) and (pointer: fine) {
		.opt:hover {
			opacity: 1;
			transform: translateY(-2px) scale(1.04);
		}
	}
	.opt.selected {
		opacity: 1;
		filter: none;
		border-color: transparent;
		background: transparent;
		box-shadow: none;
	}
	/* A check badge on the chosen option makes "this is the one you'll get" unmistakable. */
	.opt.selected::after {
		content: '';
		position: absolute;
		top: -6px;
		right: -6px;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--accent)
			url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M5 13l4 4L19 7' fill='none' stroke='white' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")
			center / 10px no-repeat;
		box-shadow: 0 0 0 2px rgba(15, 10, 28, 0.9);
	}

	/* ── Dense card — many reward icons / chooser options. Shrink the icons, chrome
	   and spacing so every option stays visible inside the fixed-size card rather
	   than overflowing (and being clipped) or pushing the CTA off the bottom. ── */
	.int-card.dense .face {
		min-height: 13rem;
		padding: 0.9rem 0.75rem 0.85rem;
		gap: 0.45rem;
	}
	.int-card.dense .flow {
		gap: 0.18rem;
	}
	.int-card.dense .row {
		gap: 0.24rem;
	}
	.int-card.dense .ico.base {
		--icon: 2.2rem;
	}
	.int-card.dense .ico.solo {
		--icon: 3.2rem;
	}
	.int-card.dense .ico.act {
		--icon: 5rem;
	}
	.int-card.dense .chooser {
		--choice-size: 2.5rem;
		gap: 0.16rem;
		padding: 0;
	}
	.int-card.dense .chooser-opts {
		gap: 0.18rem;
	}
	.int-card.dense .opt {
		padding: 0.14rem;
		border-radius: 10px;
	}
	.int-card.dense .arrow {
		transform: scale(0.8);
	}

	/* ── Result body ───────────────────────────────────────────────────────── */
	.result-body {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.result-body p {
		margin: 0;
		font-size: 0.92rem;
		line-height: 1.4;
		color: var(--color-parchment, #d8d2e8);
	}

	/* ── CTA footer ────────────────────────────────────────────────────────── */
	.cta {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-family: var(--font-display);
		font-size: 0.8rem;
		font-weight: 700;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		padding: 0.52rem 1.1rem;
		border-radius: 999px;
		color: var(--color-void, #0c0518);
		background: color-mix(in srgb, var(--accent) 72%, var(--brand-amber, #ffba3d));
		box-shadow: none;
		transition:
			transform 160ms ease,
			box-shadow 160ms ease,
			filter 160ms ease;
	}
	.int-card.trade .cta {
		background: var(--brand-teal, #20e0c1);
		box-shadow: none;
	}
	@media (hover: hover) and (pointer: fine) {
		.int-card:not(.disabled):hover .cta {
			transform: translateY(-2px);
			filter: brightness(1.08);
			box-shadow: none;
		}
	}
	.cta.locked {
		color: var(--color-fog, #8d8aa1);
		background: rgba(255, 255, 255, 0.04);
		border: 1px solid color-mix(in srgb, var(--color-fog, #8d8aa1) 40%, transparent);
		box-shadow: none;
	}
	.lock {
		width: 9px;
		height: 8px;
		border-radius: 1px 1px 0 0;
		background: currentColor;
		position: relative;
	}
	.lock::before {
		content: '';
		position: absolute;
		left: 50%;
		top: -5px;
		width: 7px;
		height: 7px;
		transform: translateX(-50%);
		border: 1.5px solid currentColor;
		border-bottom: 0;
		border-radius: 4px 4px 0 0;
	}

	/* ── Empty state ───────────────────────────────────────────────────────── */
	.empty {
		font-family: var(--font-display);
		font-size: 0.92rem;
		letter-spacing: 0.06em;
		color: var(--color-fog, #8d8aa1);
		padding: 2rem;
	}

	@media (prefers-reduced-motion: reduce) {
		.arrow,
		.ico img {
			animation: none;
			transition: none;
		}
		.flipper {
			transition: none;
		}
	}

	/* ── Mobile layout (phones ≤600px) ─────────────────────────────────────── */
	@media (max-width: 600px) {
		.int-grid {
			flex-wrap: wrap;
			max-width: 100%;
			gap: 0.75rem;
		}
		/* Each card takes ~half the row so 2 cards fit side-by-side at 360px. */
		.int-card {
			flex: 0 1 calc(50% - 0.375rem);
			min-width: 0;
			max-width: calc(50% - 0.375rem);
			touch-action: manipulation;
			-webkit-tap-highlight-color: transparent;
			user-select: none;
			/* Cut the heavy backdrop blur for perf on low-end phones: small radius,
			   no saturate(), and a more opaque solid base so contrast is preserved. */
			background: rgba(15, 10, 28, 0.72);
			-webkit-backdrop-filter: blur(8px);
			backdrop-filter: blur(8px);
			/* Lighter shadow — big multi-layer blurs are costly to composite. */
			box-shadow:
				0 8px 22px rgba(0, 0, 0, 0.45),
				inset 0 1px 0 rgba(255, 255, 255, 0.16);
		}
		.int-card.flipped {
			background: rgba(10, 7, 20, 0.82);
		}
			.face {
				min-height: 9rem;
				padding: 0.75rem 0.6rem;
				gap: 0.5rem;
		}
		/* Shrink the headline icons so a 2-column, multi-row grid fits the phone stage
		   without overflowing under the pass-turn bar. */
		.ico.base {
			--icon: 2.4rem;
		}
		.ico.solo {
			--icon: 3.4rem;
		}
		.ico.act {
			--icon: 4.5rem;
		}
		.cta {
			min-height: 44px;
		}
			.chooser {
				--choice-size: 40px;
				padding: 0;
			}
	}

	/* On reduced-motion devices, drop backdrop-filter entirely on these large card
	   panels — it's the most expensive case on mobile GPUs. The opaque base keeps
	   the content fully legible. */
	@media (max-width: 600px) and (prefers-reduced-motion: reduce) {
		.int-card {
			-webkit-backdrop-filter: none;
			backdrop-filter: none;
			background: rgba(15, 10, 28, 0.92);
		}
		.int-card.flipped {
			background: rgba(10, 7, 20, 0.94);
		}
	}

	@media (orientation: landscape) and (max-height: 520px) and (pointer: coarse) {
		.int-scroll {
			padding: 0.45rem 0.15rem;
		}
		.int-grid {
			gap: 0.55rem;
			max-width: 100%;
		}
		.int-card {
			max-width: 12.25rem;
			border-radius: 12px;
			background: rgba(15, 10, 28, 0.66);
			-webkit-backdrop-filter: blur(10px);
			backdrop-filter: blur(10px);
			box-shadow:
				0 8px 22px rgba(0, 0, 0, 0.42),
				inset 0 1px 0 rgba(255, 255, 255, 0.14);
		}
			.face {
				min-height: clamp(7.5rem, 36vh, 10rem);
				padding: 0.72rem 0.62rem;
				gap: 0.32rem;
		}
		.face.back {
			gap: 0.45rem;
		}
		.type-label {
			font-size: 0.66rem;
			letter-spacing: 0.18em;
		}
			.flow {
				gap: 0.12rem;
			}
			.row {
				gap: 0.2rem;
		}
		.ico.base {
			--icon: clamp(1.75rem, 8vh, 2.1rem);
		}
		.ico.solo {
			--icon: clamp(2.35rem, 11vh, 3rem);
		}
		.ico.act {
			--icon: clamp(3.15rem, 14vh, 4.1rem);
		}
			.chooser {
				--choice-size: 32px;
				gap: 0.12rem;
				padding: 0;
			}
			.chooser-label {
				font-size: 0.58rem;
				letter-spacing: 0.1em;
			}
			.chooser-opts {
				gap: 0.16rem;
			}
			.opt {
				padding: 0.12rem;
				border-radius: 8px;
			}
		.cta {
			min-height: 34px;
			padding: 0.36rem 0.75rem;
			font-size: 0.64rem;
			letter-spacing: 0.12em;
		}
		.result-body p {
			font-size: 0.76rem;
			line-height: 1.25;
		}
		.empty {
			padding: 1rem;
			font-size: 0.78rem;
		}
	}
</style>

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
	import type { SeatAffordances } from '$lib/play/viewV2';
	import { runeIconUrl, storageUrl } from './helpers';
	import TakeoverStage from './takeover/TakeoverStage.svelte';
	import SourcePanel from './takeover/SourcePanel.svelte';
	import CandidateRack from './takeover/CandidateRack.svelte';
	import CommitBar from './takeover/CommitBar.svelte';
	import type { MeterSlot, RackCandidate } from './takeover/types';

	interface Props {
		location: GameLocationAsset | null;
		iconPool?: Map<string, IconPoolEntry>;
		/** Full asset state — used to draw the icons of held relics/runes in the
		 *  armed payment rack. */
		assets: ReturnType<typeof getAssetState>;
		player: PlayerProjection | null;
		accent?: string;
		busy?: boolean;
		/** This seat's engine affordances (spec §5.2 `locationInteractions`). Optional:
		 *  until the engine ships them the menu falls back to the same client helpers
		 *  it always used (status quo, no new rule derivation). */
		seatAffordances?: SeatAffordances | null;
		/** Fires when a trade arms/disarms (the board parks pass-turn meanwhile). */
		onArmedChange?: (armed: boolean) => void;
		onResolve?: (rowIndex: number, choices: number[], costChoices: number[]) => void;
	}

	let {
		location,
		iconPool = new Map(),
		assets,
		player,
		accent = 'var(--brand-violet, #5a2bff)',
		busy = false,
		seatAffordances = null,
		onArmedChange,
		onResolve
	}: Props = $props();

	// Engine-owned per-row eligibility (§5.2 SeatAffordances.locationInteractions).
	const rowAffordances = $derived(
		new Map((seatAffordances?.locationInteractions ?? []).map((a) => [a.rowIndex, a]))
	);

	function slotIconUrl(slot: MatSlotSnapshot): string | null {
		return runeIconUrl(assets, slot);
	}

	const interactions = $derived(buildLocationInteractions(location?.reward_rows));
	const usedRows = $derived(player?.actionsUsedThisRound ?? []);
	// Per-row use allowance: 1 + Child Prodigy's locationInteraction credit ("you may
	// do ALL location interactions up to two times"). When >1 we render one card per
	// allowed use, each spent left-to-right as the player resolves the row.
	const rowAllowance = $derived(1 + (player?.extraActions?.locationInteraction ?? 0));

	// The row most recently resolved — only this flipped card shows the detailed
	// result log (lastAction holds just the latest outcome).
	let lastRow = $state<number | null>(null);

	function isOr(token: RewardIconToken): token is { kind: 'or'; icon_ids: string[] } {
		return typeof token !== 'string';
	}
	function iconUrl(id: string): string | null {
		return storageUrl(iconPool.get(id)?.file_path ?? null);
	}
	// Display label for a reward token — drives the placeholder (and its tooltip)
	// when the icon pool has no art for it. Presentation only.
	function tokenLabel(id: string): string | null {
		return meaningFor(id)?.label ?? null;
	}
	// Icon sizing: a consistent set size for every icon, larger when an icon stands
	// alone, and much larger for game-action tokens (Summon / Cultivate / Rest).
	function iconSize(token: string, soloRow: boolean): 'act' | 'solo' | 'base' {
		if (meaningFor(token)?.kind === 'action') return 'act';
		return soloRow ? 'solo' : 'base';
	}

	// A card is "dense" when it carries many reward icons. Dense cards shrink their
	// icons + chrome (see .int-card.dense CSS) so every option stays visible inside
	// the fixed-size card instead of overflowing and being clipped.
	function iconSlotCount(interaction: LocationInteraction): number {
		let n = interaction.costTokens.length;
		for (const t of interaction.gainTokens) n += isOr(t) ? t.icon_ids.length : 1;
		return n;
	}
	function isDense(interaction: LocationInteraction): boolean {
		if (iconSlotCount(interaction) >= 4) return true;
		return interaction.gainTokens.some((t) => isOr(t) && t.icon_ids.length >= 3);
	}

	// How many times this row has already been resolved this round (0..rowAllowance).
	function usedCount(interaction: LocationInteraction): number {
		return usedRows.filter((a) => a === `row:${interaction.rowIndex}`).length;
	}
	// A trade whose cost is WAIVED for this player. The engine affordance names the
	// waiver; the fallback mirrors the runtime waiver exactly as before:
	//   • Mod Injector — any Spirit-Augment trade is free while awakened.
	//   • Undercover — the player's next rune→relic trade is free (one-shot flag).
	function freeTrade(interaction: LocationInteraction): boolean {
		const aff = rowAffordances.get(interaction.rowIndex);
		if (aff?.freeTrade) return true;
		if (!player || interaction.cost.length === 0) return false;
		let grantsAugment = false;
		let grantsRelic = false;
		for (const g of interaction.gains) {
			if (g.type === 'rune') {
				if (g.rune.type === 'augment') grantsAugment = true;
				if (g.rune.type === 'relic') grantsRelic = true;
			} else if (g.type === 'chooseRune') {
				// Any option counting keeps the waiver visible before the player picks.
				for (const opt of g.options) {
					if (opt.type === 'augment') grantsAugment = true;
					if (opt.type === 'relic') grantsRelic = true;
				}
			}
		}
		const modInjectorFree =
			(awakenedClassCounts(player)['Mod Injector'] ?? 0) >= 1 && grantsAugment;
		const undercoverFree = !!player.freeNextRelicTrade && grantsRelic;
		return modInjectorFree || undercoverFree;
	}
	function affordable(interaction: LocationInteraction): boolean {
		const aff = rowAffordances.get(interaction.rowIndex);
		if (aff) return aff.affordable || !!aff.freeTrade;
		return freeTrade(interaction) || canAfford(interaction, player?.mats ?? []);
	}
	function noEffectNow(interaction: LocationInteraction): boolean {
		return rowAffordances.get(interaction.rowIndex)?.noEffectNow ?? false;
	}
	// A specific card instance (`inst`, 0-based) is spent once that many uses have
	// been made; instances fill left-to-right.
	function instUsed(interaction: LocationInteraction, inst: number): boolean {
		return inst < usedCount(interaction);
	}
	function instDisabled(interaction: LocationInteraction, inst: number): boolean {
		return busy || instUsed(interaction, inst) || !affordable(interaction);
	}
	function hasOrChoice(interaction: LocationInteraction): boolean {
		return interaction.gains.some((g) => g.type === 'chooseRune');
	}
	/** A row arms (stage takeover) when paying or choosing is involved; a plain
	 *  free gain stays one-click. */
	function needsArming(interaction: LocationInteraction): boolean {
		return (interaction.cost.length > 0 && !freeTrade(interaction)) || hasOrChoice(interaction);
	}

	// ── W1b armed trade (plans/ux-overhaul.md §4.2) ───────────────────────────
	// Clicking a costed/choice row no longer resolves it — it ARMS: the card pins
	// as the source, the mat rack rises as the candidate rack, every cost slot is
	// a visible meter slot, and "or" gains are explicit chips with no default.
	// NOTHING mutates until Confirm.
	let armedRow = $state<number | null>(null);
	/** Chosen mats-array index per cost slot (specific slots pre-filled by auto-match). */
	let armedFill = $state<(number | null)[]>([]);
	/** Chosen option per "or" gain group — starts null (no silent default, S6). */
	let armedChoiceSel = $state<(number | null)[]>([]);
	const armedInteraction = $derived(
		armedRow === null ? null : (interactions.find((i) => i.rowIndex === armedRow) ?? null)
	);
	$effect(() => {
		onArmedChange?.(armedRow !== null);
	});
	$effect(() => {
		// The row resolved / location changed out from under the armed view.
		if (armedRow !== null && !armedInteraction) disarm();
	});

	type ArmedCostSlot = {
		need: string;
		needIcon: string | null;
		wildcard: boolean;
		eligible: number[];
		autoPick: number | null;
	};
	const armedFreeTrade = $derived(armedInteraction ? freeTrade(armedInteraction) : false);
	function costSlotsFor(it: LocationInteraction): ArmedCostSlot[] {
		if (freeTrade(it)) return [];
		const aff = rowAffordances.get(it.rowIndex);
		const tokenIcon = (ci: number): string | null => {
			const token = it.costTokens[ci];
			return typeof token === 'string' ? iconUrl(token) : null;
		};
		if (aff && aff.costSlots.length === it.cost.length) {
			return aff.costSlots.map((s, ci) => ({
				need: s.need,
				needIcon: tokenIcon(ci),
				wildcard: s.wildcard,
				eligible: s.eligibleMatSlotIndexes,
				autoPick: s.autoPick
			}));
		}
		// Fallback: the exact helpers the old chooser used (status quo semantics).
		return it.cost.map((req, ci) => {
			const eligible = eligibleCostSlots(req, player?.mats ?? []);
			return {
				need: req.label,
				needIcon: tokenIcon(ci),
				wildcard: isWildcardCost(req),
				eligible,
				autoPick: eligible[0] ?? null
			};
		});
	}
	const armedCostSlots = $derived<ArmedCostSlot[]>(
		armedInteraction ? costSlotsFor(armedInteraction) : []
	);
	const armedChoiceGroups = $derived(
		armedInteraction
			? armedInteraction.gains.filter((g) => g.type === 'chooseRune')
			: []
	);

	function matIdentity(slot: MatSlotSnapshot): string {
		return slot.id ?? `${slot.name ?? ''}|${slot.type ?? ''}|${slot.originId ?? ''}`;
	}
	/** Pre-fill the meter: specific slots take the auto-match pick (S1 — the spend
	 *  is always visible); a wildcard slot pre-fills only when there is no real
	 *  choice (a single distinct eligible item). No two slots share one mat. */
	function initialFill(slots: ArmedCostSlot[]): (number | null)[] {
		const used = new Set<number>();
		const take = (idx: number | null | undefined): number | null => {
			if (idx == null || used.has(idx)) return null;
			used.add(idx);
			return idx;
		};
		return slots.map((slot) => {
			if (!slot.wildcard) {
				const pick = take(slot.autoPick) ?? take(slot.eligible.find((i) => !used.has(i)));
				return pick;
			}
			const mats = player?.mats ?? [];
			const distinct = new Set(
				slot.eligible.filter((i) => !used.has(i)).map((i) => matIdentity(mats[i]))
			);
			if (distinct.size === 1) return take(slot.eligible.find((i) => !used.has(i)));
			return null;
		});
	}
	function arm(interaction: LocationInteraction) {
		armedRow = interaction.rowIndex;
		armedChoiceSel = Array.from(
			{ length: interaction.gains.filter((g) => g.type === 'chooseRune').length },
			() => null
		);
		armedFill = initialFill(costSlotsFor(interaction));
	}
	function disarm() {
		armedRow = null;
		armedFill = [];
		armedChoiceSel = [];
	}

	// Group the FULL held rack (real objects, S1: you always see what you keep and
	// what you lose). Identical copies collapse to one card + count.
	type MatGroup = { key: string; label: string; image: string | null; indexes: number[] };
	const heldGroups = $derived.by<MatGroup[]>(() => {
		const groups = new Map<string, MatGroup>();
		(player?.mats ?? []).forEach((slot, arrayIndex) => {
			if (!slot.hasRune) return;
			const key = matIdentity(slot);
			const existing = groups.get(key);
			if (existing) {
				existing.indexes.push(arrayIndex);
				return;
			}
			groups.set(key, {
				key,
				label: slot.name ?? 'Rune',
				image: slotIconUrl(slot),
				indexes: [arrayIndex]
			});
		});
		return [...groups.values()];
	});
	function slotAcceptsIndex(si: number, arrayIndex: number): boolean {
		return armedCostSlots[si]?.eligible.includes(arrayIndex) ?? false;
	}
	const armedCandidates = $derived.by<RackCandidate[]>(() => {
		if (!armedInteraction) return [];
		const filledSet = new Set(armedFill.filter((v): v is number => v !== null));
		const wildcardNeeds = armedCostSlots
			.filter((s, i) => s.wildcard && armedFill[i] === null)
			.map((s) => s.need);
		return heldGroups.map((g) => {
			const selected = g.indexes.filter((i) => filledSet.has(i)).length;
			// Assignable now: an unused copy fits some unfilled WILDCARD slot.
			const assignable = g.indexes.some(
				(idx) =>
					!filledSet.has(idx) &&
					armedCostSlots.some((s, si) => s.wildcard && armedFill[si] === null && slotAcceptsIndex(si, idx))
			);
			// Removable: one of its copies sits in a WILDCARD slot (specifics are fixed).
			const removable = armedCostSlots.some(
				(s, si) => s.wildcard && armedFill[si] !== null && g.indexes.includes(armedFill[si]!)
			);
			const anyWildcardEligible = armedCostSlots.some(
				(s) => s.wildcard && g.indexes.some((idx) => s.eligible.includes(idx))
			);
			const hasWildcards = armedCostSlots.some((s) => s.wildcard);
			const eligible = anyWildcardEligible;
			const auto = !eligible && selected > 0; // consumed by a specific cost only
			return {
				key: g.key,
				label: g.label,
				image: g.image,
				count: g.indexes.length,
				selected,
				eligible: eligible && (assignable || removable || selected > 0),
				auto,
				reason: eligible
					? undefined
					: auto
						? undefined
						: hasWildcards
							? `Can't pay “${wildcardNeeds[0] ?? armedCostSlots.find((s) => s.wildcard)?.need ?? 'this cost'}”`
							: 'Kept — not part of this cost'
			};
		});
	});
	function tapArmedGroup(key: string) {
		const g = heldGroups.find((x) => x.key === key);
		if (!g) return;
		const filledSet = new Set(armedFill.filter((v): v is number => v !== null));
		for (const idx of g.indexes) {
			if (filledSet.has(idx)) continue;
			const si = armedCostSlots.findIndex(
				(s, i) => s.wildcard && armedFill[i] === null && slotAcceptsIndex(i, idx)
			);
			if (si >= 0) {
				armedFill = armedFill.map((v, i) => (i === si ? idx : v));
				return;
			}
		}
		// Nothing to add — un-stage this group's wildcard picks.
		armedFill = armedFill.map((v, i) =>
			v !== null && armedCostSlots[i]?.wildcard && g.indexes.includes(v) ? null : v
		);
	}
	const armedMeter = $derived<MeterSlot[]>(
		armedCostSlots.map((slot, i) => {
			const idx = armedFill[i];
			const mat = idx !== null ? (player?.mats ?? [])[idx] : null;
			return {
				need: slot.need,
				needIcon: slot.needIcon,
				filled: mat ? { label: mat.name ?? 'Rune', icon: slotIconUrl(mat) } : null
			};
		})
	);
	const armedComplete = $derived(
		armedFill.every((v) => v !== null) && armedChoiceSel.every((v) => v !== null)
	);
	const armedUsesLeft = $derived.by(() => {
		const it = armedInteraction;
		if (!it) return 0;
		const aff = rowAffordances.get(it.rowIndex);
		return aff ? aff.usesRemaining : rowAllowance - usedCount(it);
	});
	function gainSummary(interaction: LocationInteraction): string {
		const parts = interaction.gains.map((g) => {
			if (g.type === 'rune') return g.rune.name;
			if (g.type === 'restoreBarrier') return 'Restore Barrier';
			if (g.type === 'vp') return `${g.amount} VP`;
			if (g.type === 'chooseRune') return 'your pick';
			if (g.type === 'action') {
				return g.action === 'cultivate'
					? 'Cultivate'
					: g.action === 'rest'
						? 'Rest'
						: 'Summon';
			}
			return '';
		});
		// Collapse duplicates ("Summon + Summon" → "2× Summon").
		const counts = new Map<string, number>();
		for (const p of parts) if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
		return [...counts.entries()].map(([p, n]) => (n > 1 ? `${n}× ${p}` : p)).join(' + ');
	}
	function confirmArmed() {
		const it = armedInteraction;
		if (!it || busy || !armedComplete) return;
		const costChoices = armedCostSlots
			.map((s, i) => (s.wildcard ? armedFill[i] : null))
			.filter((v): v is number => v !== null);
		const choices = armedChoiceSel.map((v) => v ?? 0);
		lastRow = it.rowIndex;
		onResolve?.(it.rowIndex, choices, costChoices);
		disarm();
	}

	function cardClick(interaction: LocationInteraction, inst: number) {
		if (instDisabled(interaction, inst)) return;
		if (needsArming(interaction)) {
			arm(interaction);
			return;
		}
		lastRow = interaction.rowIndex; // this card will show the detailed result
		onResolve?.(interaction.rowIndex, [], []);
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

{#snippet icon(url: string | null, size: 'act' | 'solo' | 'base', label: string | null = null)}
	<span class="ico {size}" title={label ?? undefined}>
		{#if url}
			<img src={url} alt="" loading="lazy" />
		{:else}
			<!-- Themed placeholder for tokens with no art — never a blank hole. The big
			     action size carries its label; small sizes tooltip it instead. -->
			<span class="ico-fb" role="img" aria-label={label ?? 'Reward'}>
				<span class="fb-glyph" aria-hidden="true">✦</span>
				{#if size === 'act' && label}<span class="fb-label">{label}</span>{/if}
			</span>
		{/if}
	</span>
{/snippet}

{#if interactions.length === 0}
	<div class="empty" data-testid="no-interactions">No interactions here — pass your turn.</div>
{:else if armedInteraction}
	{@const it = armedInteraction}
	<TakeoverStage
		{accent}
		testid={`interaction-armed-${it.rowIndex}`}
		onEscape={busy ? null : disarm}
	>
		{#snippet source()}
			<SourcePanel
				title={it.kind === 'trade' ? 'Trade' : 'Claim'}
				subtitle={armedFreeTrade
					? `Cost waived — take ${gainSummary(it)}`
					: `Pay the cost, take ${gainSummary(it)}`}
				{accent}
			>
				<span class="armed-flow" aria-hidden="true">
					{#if it.costTokens.length > 0}
						<span class="armed-side">
							{#each it.costTokens as token, ci (ci)}
								{#if !isOr(token)}{@render icon(iconUrl(token), 'base', tokenLabel(token))}{/if}
							{/each}
						</span>
						<span class="armed-arrow">→</span>
					{/if}
					<span class="armed-side">
						{#each it.gainTokens as token, ti (ti)}
							{#if isOr(token)}
								{#each token.icon_ids as optId, oi (optId + oi)}
									{@render icon(iconUrl(optId), 'base', tokenLabel(optId))}
								{/each}
							{:else}
								{@render icon(iconUrl(token), iconSize(token, false), tokenLabel(token))}
							{/if}
						{/each}
					</span>
				</span>
				{#if armedUsesLeft > 1}
					<span class="uses-chip">{armedUsesLeft} uses left this round</span>
				{/if}
				{#if armedFreeTrade}
					<span class="uses-chip free">Free — class ability</span>
				{/if}
			</SourcePanel>
		{/snippet}

		{#if armedChoiceGroups.length > 0}
			<div class="choice-groups">
				{#each armedChoiceGroups as group, gi (gi)}
					{#if group.type === 'chooseRune'}
						<div class="choice-group" role="group" aria-label="Choose one reward">
							<span class="choice-title">Choose one</span>
							<div class="choice-chips">
								{#each group.options as opt, oi (opt.runeId + oi)}
									<button
										type="button"
										class="choice-chip"
										class:picked={armedChoiceSel[gi] === oi}
										disabled={busy}
										aria-pressed={armedChoiceSel[gi] === oi}
										data-testid={`armed-choice-${gi}-${oi}`}
										onclick={() =>
											(armedChoiceSel = armedChoiceSel.map((v, k) => (k === gi ? oi : v)))}
									>
										{#if storageUrl(assets.matAssets.get(opt.runeId)?.icon_path ?? null)}
											<img
												src={storageUrl(assets.matAssets.get(opt.runeId)?.icon_path ?? null)}
												alt=""
											/>
										{/if}
										<span>{opt.name}</span>
									</button>
								{/each}
							</div>
						</div>
					{/if}
				{/each}
			</div>
		{/if}

		{#if armedCostSlots.length > 0}
			<p class="rack-hint">
				Your rack — tap what you'll pay with. Dimmed items stay yours.
			</p>
			<CandidateRack
				candidates={armedCandidates}
				onTap={tapArmedGroup}
				disabled={busy}
				{accent}
				testidPrefix="cost-option"
				testid="armed-cost-pick"
				ariaLabel="Choose which items to pay with"
			/>
		{/if}

		{#snippet bar()}
			<CommitBar
				slots={armedMeter}
				summary={armedCostSlots.length === 0 && armedChoiceGroups.length > 0
					? 'Pick your reward to continue'
					: null}
				warning={noEffectNow(it) ? 'No effect right now' : null}
				confirmLabel={it.kind === 'trade' ? 'Pay & take' : 'Take'}
				confirmDisabled={!armedComplete}
				confirmTestid="armed-confirm"
				onConfirm={confirmArmed}
				onCancel={disarm}
				{busy}
				{accent}
			/>
		{/snippet}
	</TakeoverStage>
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
					{@const nullNow = noEffectNow(interaction)}
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
						onclick={() => cardClick(interaction, inst)}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								cardClick(interaction, inst);
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
												{#if !isOr(token)}
													{@render icon(iconUrl(token), iconSize(token, soloCost), tokenLabel(token))}
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
												<span class="or-set" role="group" aria-label="You will choose one of these">
													<span class="or-label">
														<span class="tap-dot" aria-hidden="true"></span>Choose one
													</span>
													<span class="or-opts">
														{#each token.icon_ids as optId, oi (optId + oi)}
															{@render icon(iconUrl(optId), 'base', tokenLabel(optId))}
														{/each}
													</span>
												</span>
											{:else}
												{@render icon(iconUrl(token), iconSize(token, soloGain), tokenLabel(token))}
											{/if}
										{/each}
									</div>
								</div>

								{#if nullNow && !cantAfford}
									<span class="cta warn">
										<span class="warn-dot" aria-hidden="true">⚠</span>No effect right now
									</span>
								{:else}
									<span class="cta" class:locked={cantAfford}>
										{#if cantAfford}
											<span class="lock" aria-hidden="true"></span>Can't afford
										{:else if needsArming(interaction)}
											{isTrade ? 'Pay · Take' : 'Choose · Take'}
										{:else}
											Take
										{/if}
									</span>
								{/if}
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
	/* Placeholder for a token with no art — a sigil in a hairline tile, so a missing
	   asset reads as a designed token rather than a hole in the card. */
	.ico-fb {
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.2rem;
		border-radius: 22%;
		background: rgba(255, 255, 255, 0.05);
		box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.2);
	}
	.fb-glyph {
		font-size: calc(var(--icon) * 0.42);
		line-height: 1;
		color: color-mix(in srgb, var(--accent) 45%, #fff 35%);
		text-shadow: 0 0 8px color-mix(in srgb, var(--accent) 45%, transparent);
	}
	.fb-label {
		max-width: calc(var(--icon) * 0.92);
		font-family: var(--font-display);
		font-size: 0.62rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		text-align: center;
		line-height: 1.15;
		color: var(--color-parchment, #d8cfee);
	}
	@media (hover: hover) and (pointer: fine) {
		.int-card:not(.disabled):hover .ico img {
			transform: scale(1.06);
			filter: drop-shadow(0 6px 16px rgba(0, 0, 0, 0.6));
		}
	}

	/* ── "Or" preview on the card — the pick itself happens in the armed view. ── */
	.or-set {
		display: inline-flex;
		flex-direction: column;
		align-items: center;
		flex: 0 1 auto;
		min-width: 0;
		gap: 0.22rem;
		max-width: 100%;
	}
	.or-label {
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
	.or-opts {
		display: inline-flex;
		flex-wrap: nowrap;
		align-items: center;
		justify-content: center;
		flex: 0 1 auto;
		min-width: 0;
		gap: 0.28rem;
		max-width: 100%;
	}

	/* ── Armed takeover chrome ─────────────────────────────────────────────── */
	.armed-flow {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-wrap: wrap;
		gap: 0.35rem;
	}
	.armed-side {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.armed-arrow {
		font-size: 1.1rem;
		color: color-mix(in srgb, var(--accent, #5a2bff) 60%, var(--brand-amber, #ffba3d));
	}
	/* Inside the pinned source panel the flow is a summary, not the headline —
	   cap the action-token size that would otherwise dominate the column. */
	.armed-flow .ico.act {
		--icon: 3.4rem;
	}
	.armed-flow .ico.solo {
		--icon: 3rem;
	}
	.uses-chip {
		padding: 0.2rem 0.6rem;
		border-radius: 999px;
		font-family: var(--font-display);
		font-size: 0.58rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--color-parchment, #d8cfee);
		border: 1px solid rgba(255, 255, 255, 0.2);
	}
	.uses-chip.free {
		color: var(--brand-teal, #20e0c1);
		border-color: color-mix(in srgb, var(--brand-teal, #20e0c1) 45%, transparent);
	}
	.rack-hint {
		margin: 0;
		font-size: clamp(0.78rem, 1.2vw, 0.92rem);
		color: var(--color-parchment, #d8cfee);
		text-align: center;
	}
	.choice-groups {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.6rem;
		width: 100%;
	}
	.choice-group {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.4rem;
	}
	.choice-title {
		font-family: var(--font-display);
		font-size: 0.68rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--accent, #5a2bff) 55%, #fff 45%);
	}
	.choice-chips {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.5rem;
	}
	.choice-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		min-height: 44px;
		padding: 0.4rem 0.85rem;
		border-radius: 12px;
		border: 1.5px solid rgba(255, 255, 255, 0.2);
		background: rgba(15, 10, 28, 0.5);
		color: var(--color-bone, #efeaf7);
		font-family: var(--font-display);
		font-size: 0.72rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		cursor: pointer;
		transition:
			border-color 150ms ease,
			background 150ms ease,
			transform 150ms ease;
	}
	.choice-chip img {
		width: 1.7rem;
		height: 1.7rem;
		object-fit: contain;
	}
	.choice-chip:not(:disabled):hover {
		transform: translateY(-2px);
		border-color: color-mix(in srgb, var(--accent, #5a2bff) 55%, #fff 20%);
	}
	.choice-chip.picked {
		border-color: color-mix(in srgb, var(--accent, #5a2bff) 80%, #fff 15%);
		background: color-mix(in srgb, var(--accent, #5a2bff) 22%, rgba(15, 10, 28, 0.5));
		box-shadow: 0 0 14px color-mix(in srgb, var(--accent, #5a2bff) 35%, transparent);
	}
	.choice-chip:disabled {
		opacity: 0.5;
		cursor: not-allowed;
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
	/* A legal-but-worthless row is honest about it instead of selling a null trade. */
	.cta.warn {
		color: var(--brand-amber-soft, #ffd56a);
		background: color-mix(in srgb, var(--brand-amber, #ffba3d) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--brand-amber, #ffba3d) 45%, transparent);
	}
	.warn-dot {
		font-size: 0.85rem;
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

	/* ── Dense card — many reward icons. Shrink the icons, chrome and spacing so
	   every option stays visible inside the fixed-size card rather than overflowing
	   (and being clipped) or pushing the CTA off the bottom. ── */
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
	.int-card.dense .or-opts {
		gap: 0.18rem;
	}
	.int-card.dense .arrow {
		transform: scale(0.8);
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
			.or-opts {
				gap: 0.16rem;
			}
			.or-label {
				font-size: 0.58rem;
				letter-spacing: 0.1em;
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

<script lang="ts">
	import type {
		AwakenCostSlot,
		AwakenDiscardRef,
		AwakenGrant,
		SpectatorProjection,
		SeatColor,
		NavigationDestination,
		PendingDecision,
		PlayerProjection,
		DiceTier
	} from '$lib/play/types';
	import { RUNE_CARRY_LIMIT, isEvilAlignment } from '$lib/play/types';
	import { SPIRIT_AUGMENT_CLASSES, isSpiritAugmentClass } from '$lib/play/augments';
	import { getLocationConfig, LOCATION_ACCENT, splatFor } from '$lib/play/locations';
	import { relicOptions } from '$lib/play/locationInteractions';
	import { decisionPickerSpec } from '$lib/play/decisionPicker';
	import type { getAssetState } from '$lib/stores/assetStore.svelte';
	import { attackDieImageUrl, augmentIconForClass, runeIconUrl, seatAccent, spiritBackImageUrl, storageUrl } from './helpers';
	import HexGrid from '$lib/components/HexGrid.svelte';
	import SpiritWorldBoard from './SpiritWorldBoard.svelte';
	import type { NavigationSceneControls } from './navigationSceneControls';
	import ConfirmDestinationCircle from './ConfirmDestinationCircle.svelte';
	import DrawTray from './DrawTray.svelte';
	import CombatOverlay from './CombatOverlay.svelte';
	import LocationInteractionMenu from './LocationInteractionMenu.svelte';
	import ActionResult from './ActionResult.svelte';
	import StageCard from './StageCard.svelte';
	import TakeoverStage from './takeover/TakeoverStage.svelte';
	import SourcePanel from './takeover/SourcePanel.svelte';
	import CandidateRack from './takeover/CandidateRack.svelte';
	import CommitBar from './takeover/CommitBar.svelte';
	import type { MeterSlot, RackCandidate } from './takeover/types';
	import MonsterRewardTakeover from './MonsterRewardTakeover.svelte';
	import DecisionCard from './DecisionCard.svelte';
	import ManualPromptCard from './ManualPromptCard.svelte';
	import InfiltratorSwap from './InfiltratorSwap.svelte';
	import EncounterStage from './EncounterStage.svelte';
	import type { SeatAffordances } from '$lib/play/viewV2';
	import { iconPoolUrl, RESOURCE_ICON_IDS } from './helpers';

	export type ActiveAction = 'rest' | 'cultivate' | 'combat' | 'reward' | null;

	interface Props {
		room: SpectatorProjection;
		mySeat: SeatColor | null;
		myPlayer: PlayerProjection | null;
		assets: ReturnType<typeof getAssetState>;
		spiritImages?: Map<string, string>;
		activeAction: ActiveAction;
		/** Navigation: can this viewer still pick/lock a destination. */
		canPick: boolean;
		lockedDestination: NavigationDestination | null;
		/** When the local player has locked (navigation still open), the chosen
		 *  destination — drives the full-screen "confirmed" zoom panel. */
		confirmedDestination?: NavigationDestination | null;
		onExitConfirmed?: () => void;
		/** True once the local player has stepped into the committed realm. */
		inRealm?: boolean;
		/** While the reveal → realm-enter choreography is playing, keep the stage clear
		 *  so the location interaction UI doesn't flash in before the zoom completes. */
		holdRealmEntry?: boolean;
		/** The carousel card to render as the live "portal" (hover preview / locked pick). */
		focusedDestination?: NavigationDestination | null;
		onHoverDestination?: (destination: NavigationDestination | null) => void;
		onSelectDestination: (destination: NavigationDestination) => void;
		onSceneControls?: (controls: NavigationSceneControls | null) => void;
		onResolveInteraction: (rowIndex: number, choices: number[], costChoices: number[]) => void;
		onStartCombat: () => void;
		/** Claim monster-kill rewards (Arcane Abyss): picks = track indices. */
		onClaimReward: (picks: number[], choices: number[]) => void;
		onSummon: (guid: string) => void;
		onDiscard: () => void;
		/** Soul Weaver: return the current draw and draw again (one-shot per summon). */
		onRedraw: () => void;
		/** Dismiss a result/combat stage → back to the action grid. */
		onContinue: () => void;
		/** Awaken a face-down spirit; `discardRefs` names which items pay a discard
		 *  cost when the owner chose (omitted ⇒ engine auto-picks). */
		onAwaken: (slotIndex: number, discardRefs?: AwakenDiscardRef[]) => void;
		/** Discard held runes/relics during Cleanup to get under the carry limit —
		 *  the whole staged batch commits at once (W2c). */
		onDiscardRunes: (slotIndexes: number[]) => void;
		/** Infiltrator: swap one attack die with each co-located player. */
		onInfiltratorSwap: (
			swaps: { targetSeat: SeatColor; myInstanceId: string; theirInstanceId: string }[]
		) => void;
		/** Cast this Evil player's vote to attack the Good players sharing the location. */
		onAttackGroup: () => void;
		/** Hold/decline the encounter (an Evil decline cancels the group attack here). */
		onPass: () => void;
		/** Claim the Awakening-Phase rewards (Cleanup). `taintedPotential` = Cursed
		 *  Spirit Tainted units taken as potential (rest Enchanted Attack); `relicPicks`
		 *  = chosen relic index (into the 5 relics) per Cursed Spirit Corrupt unit. */
		onClaimAwakenReward: (taintedPotential: number, relicPicks: number[]) => void;
		/** Resolve an opt-in/choice ability card (Purifier class pick, etc.). */
		onResolveDecision: (
			decisionId: string,
			optionId: string,
			selectedInstanceIds?: string[]
		) => void;
		/** Dismiss a hand-resolved (manual) prompt. */
		onDismissManual: (id: string) => void;
		/** Place a chosen Spirit Augment (class) onto a spirit (in-stage placement). */
		onPlaceAugment: (
			augmentIndex: number,
			augmentRuneId: string,
			spiritSlotIndex: number,
			className: string
		) => void;
		/** Finish augment placement — forfeit any that remain unplaced. */
		onDiscardAugments: () => void;
		/** Discard spirits by slot index (forced corruption discard) — the whole
		 *  staged batch commits at once (W2c). */
		onDiscardSpirits: (slotIndexes: number[]) => void;
		busy?: boolean;
		/** This seat's engine-computed action surface (RoomView v2). Null for
		 *  spectators / when the projection predates affordances. */
		seatAffordances?: SeatAffordances | null;
		/** Fires when a stage takeover (payment picker / armed trade) opens or
		 *  closes, so the board can park the pass-turn control meanwhile. */
		onTakeoverOpenChange?: (open: boolean) => void;
	}

	let {
		room,
		mySeat,
		myPlayer,
		assets,
		spiritImages = new Map(),
		activeAction,
		canPick,
		lockedDestination,
		confirmedDestination = null,
		onExitConfirmed,
		inRealm = false,
		holdRealmEntry = false,
		focusedDestination = null,
		onHoverDestination,
		onSelectDestination,
		onSceneControls,
		onResolveInteraction,
		onStartCombat,
		onClaimReward,
		onSummon,
		onDiscard,
		onRedraw,
		onContinue,
		onAwaken,
		onDiscardRunes,
		onInfiltratorSwap,
		onAttackGroup,
		onPass,
		onClaimAwakenReward,
		onResolveDecision,
		onDismissManual,
		onPlaceAugment,
		onDiscardAugments,
		onDiscardSpirits,
		busy = false,
		seatAffordances = null,
		onTakeoverOpenChange
	}: Props = $props();

	const myLocationConfig = $derived(
		myPlayer?.navigationDestination ? getLocationConfig(myPlayer.navigationDestination) : null
	);
	const myLocationAsset = $derived(
		myPlayer?.navigationDestination
			? (assets.gameLocations.get(myPlayer.navigationDestination) ?? null)
			: null
	);
	const myAccent = $derived(
		myLocationConfig ? (LOCATION_ACCENT[myLocationConfig.name] ?? '#8d8aa1') : '#8d8aa1'
	);
	const pendingDraw = $derived(myPlayer?.pendingDraw ?? null);
	const pendingReward = $derived(myPlayer?.pendingReward ?? null);
	const myReady = $derived(myPlayer?.phaseReady ?? false);

	/** The unawakened (face-down) back-side art for the spirit in this slot. */
	function spiritArt(slotIndex: number): string | null {
		const id = myPlayer?.spirits.find((s) => s.slotIndex === slotIndex)?.id;
		return id ? spiritBackImageUrl(id) : null;
	}

	// Summon-style card flourishes for awakenable spirits.
	function spins(slotIndex: number): boolean {
		return slotIndex % 3 === 0;
	}
	const isFinePointer =
		typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches;
	function tilt(event: PointerEvent) {
		if (!isFinePointer) return;
		const card = event.currentTarget as HTMLElement;
		const inner = card.querySelector('.tiltable') as HTMLElement | null;
		if (!inner) return;
		const r = card.getBoundingClientRect();
		const px = (event.clientX - r.left) / r.width - 0.5;
		const py = (event.clientY - r.top) / r.height - 0.5;
		inner.style.transform = `rotateY(${px * 26}deg) rotateX(${-py * 26}deg) scale(1.06)`;
	}
	function untilt(event: PointerEvent) {
		if (!isFinePointer) return;
		const inner = (event.currentTarget as HTMLElement).querySelector(
			'.tiltable'
		) as HTMLElement | null;
		if (inner) inner.style.transform = '';
	}

	// ── Benefits / Awakening / Cleanup action data ───────────────────────────
	const awakenReward = $derived(myPlayer?.pendingAwakenReward ?? null);
	const grants = $derived<AwakenGrant[]>(awakenReward?.grants ?? []);
	const taintedGrant = $derived(grants.find((g) => g.kind === 'taintedChoice') ?? null);
	const relicGrant = $derived(grants.find((g) => g.kind === 'relicChoice') ?? null);
	const fixedGrants = $derived(
		grants.filter((g) => g.kind === 'vp' || g.kind === 'attackDice' || g.kind === 'augment')
	);
	const relicChoices = $derived(
		relicOptions().map((r) => ({
			name: r.name,
			icon: storageUrl(assets.matAssets.get(r.runeId)?.icon_path ?? null)
		}))
	);
	function grantLabel(g: AwakenGrant): string {
		if (g.kind === 'vp') return `Gain ${g.amount} Victory Point${g.amount === 1 ? '' : 's'}`;
		if (g.kind === 'attackDice') {
			const tier = g.tier.charAt(0).toUpperCase() + g.tier.slice(1);
			return `Gain ${g.amount} ${tier} Attack die${g.amount === 1 ? '' : 's'}`;
		}
		if (g.kind === 'augment') return `Gain ${g.amount} Spirit Augment${g.amount === 1 ? '' : 's'}`;
		return '';
	}
	// Tainted split: one heart↔die segment per unit (no ± arithmetic). Relic picks
	// start EMPTY — claiming is disabled until every unit has an explicit choice,
	// so a default relic is never silently taken.
	let taintedSeg = $state<boolean[]>([]); // true = Potential, false = Enchanted Attack
	let relicPicks = $state<(number | null)[]>([]);
	let hadAwakenReward = false;
	$effect(() => {
		const has = !!awakenReward;
		if (has && !hadAwakenReward) {
			taintedSeg = Array.from({ length: taintedGrant?.amount ?? 0 }, () => false);
			relicPicks = Array.from({ length: relicGrant?.amount ?? 0 }, () => null);
		}
		hadAwakenReward = has;
	});
	const taintedMax = $derived(taintedGrant?.amount ?? 0);
	const taintedPotentialClamped = $derived(taintedSeg.filter(Boolean).length);
	const taintedEnchanted = $derived(taintedMax - taintedPotentialClamped);
	function toggleTaintedSeg(i: number) {
		taintedSeg = taintedSeg.map((v, k) => (k === i ? !v : v));
	}
	function pickRelic(unit: number, choice: number) {
		relicPicks = relicPicks.map((v, i) => (i === unit ? choice : v));
	}
	const relicPicksComplete = $derived(relicPicks.every((p) => p !== null));
	const potentialIcon = $derived(iconPoolUrl(assets.iconPool, RESOURCE_ICON_IDS.barrier));
	function classIconFor(className: string): string | null {
		for (const cls of assets.classTraits.values()) {
			if (cls.name === className) return storageUrl(cls.icon_png ?? null);
		}
		return null;
	}
	function claimBenefits() {
		if (busy || !relicPicksComplete) return;
		onClaimAwakenReward(
			taintedPotentialClamped,
			relicPicks.map((p) => p ?? 0)
		);
	}
	const claimSummary = $derived.by(() => {
		const parts: string[] = [];
		if (taintedGrant) parts.push(`${taintedPotentialClamped} Potential · ${taintedEnchanted} Enchanted`);
		if (relicGrant) {
			const picked = relicPicks.filter((p) => p !== null).length;
			parts.push(`${picked}/${relicPicks.length} relic${relicPicks.length === 1 ? '' : 's'} chosen`);
		}
		return parts.join(' — ') || null;
	});

	const awakeningChoices = $derived(myPlayer?.pendingDecisions ?? []);
	// W2b: engine picker requirements (§5.4), keyed by decisionId — ship on the
	// 'decision' pendingWork descriptor. That descriptor exists only in Awakening
	// (pendingWork mirrors seatHasResolutionWork), but decisions also fire in the
	// Location phase (Arc Mage's onCultivate) — there we call the engine's OWN
	// decisionPickerSpec helper directly, the same single source the reducer
	// validates against, so eligibility still cannot drift.
	const decisionPickerSpecs = $derived(
		seatAffordances?.pendingWork?.find((w) => w.kind === 'decision')?.pickerSpecs ?? []
	);
	function pickerSpecFor(decision: PendingDecision) {
		const wired = decisionPickerSpecs.find((s) => s.decisionId === decision.id);
		if (wired) return wired;
		return myPlayer ? decisionPickerSpec(decision, myPlayer) : null;
	}
	const awakenOffers = $derived(myPlayer?.awakenOffers ?? []);
	const awakenLocked = $derived(myPlayer?.awakenLocked ?? []);
	const manualPrompts = $derived(myPlayer?.manualPrompts ?? []);

	// ── W1a payment takeover (plans/ux-overhaul.md §4.2) ─────────────────────
	// Eligibility is engine-owned: `offer.costSlots` lists every held item that can
	// satisfy each required unit. The payment rack renders ONLY that union — an
	// "Any Rune" cost must not show relics, even as dimmed cards. Because costSlots
	// scan the full held-mat array, eligible overflow runes beyond carry capacity are
	// still selectable. Scripted handlers ship no costSlots; their `options` are precise.
	let pickingSlot = $state<number | null>(null);
	/** The staged discard per cost-meter slot; nothing mutates until Confirm. */
	let awakenFilled = $state<(AwakenDiscardRef | null)[]>([]);
	const pickingOffer = $derived(
		pickingSlot === null ? null : (awakenOffers.find((o) => o.slotIndex === pickingSlot) ?? null)
	);
	$effect(() => {
		if (pickingSlot !== null && !pickingOffer) {
			pickingSlot = null;
			awakenFilled = [];
		}
	});
	const awakenCostSlots = $derived<AwakenCostSlot[] | null>(
		pickingOffer?.costSlots?.length ? pickingOffer.costSlots : null
	);
	const awakenSlotCount = $derived(
		awakenCostSlots ? awakenCostSlots.length : (pickingOffer?.discardCount ?? 0)
	);
	// Keep the staged-slot array in lockstep with the open offer's cost shape.
	$effect(() => {
		if (pickingOffer && awakenFilled.length !== awakenSlotCount) {
			awakenFilled = Array.from({ length: awakenSlotCount }, () => null);
		}
	});

	function refKey(ref: AwakenDiscardRef): string {
		if (ref.kind === 'augment') return 'augment';
		if (ref.kind === 'attackDie') return `attackDie:${ref.instanceId}`;
		return `${ref.kind}:${ref.slotIndex}`;
	}
	function matIconById(runeId: string | undefined): string | null {
		return runeId ? storageUrl(assets.matAssets.get(runeId)?.icon_path ?? null) : null;
	}
	/** Resolve a discard ref to its display identity: prefer the offer's own option
	 *  entry (label + runeId), then the live mats / spirits snapshots. */
	function refDisplay(ref: AwakenDiscardRef, labelHint?: string): { label: string; image: string | null; group: string } {
		const opt = pickingOffer?.options.find((o) => refKey(o.ref) === refKey(ref));
		if (ref.kind === 'spirit') {
			const spirit = myPlayer?.spirits.find((s) => s.slotIndex === ref.slotIndex);
			const label = labelHint ?? opt?.label ?? spirit?.name ?? 'Spirit';
			return {
				label,
				image: spirit ? spiritBackImageUrl(spirit.id) : null,
				group: `spirit:${spirit?.id ?? ref.slotIndex}`
			};
		}
		if (ref.kind === 'rune') {
			const mat = myPlayer?.mats.find((m) => m.slotIndex === ref.slotIndex);
			const label = labelHint ?? opt?.label ?? mat?.name ?? 'Rune';
			const runeId = opt?.runeId ?? mat?.id;
			return {
				label,
				image: runeIconUrl(assets, {
					slotIndex: ref.slotIndex,
					hasRune: true,
					id: runeId,
					name: label,
					type: mat?.type ?? (/relic/i.test(label) ? 'relic' : 'rune')
				}),
				group: runeId ?? `rune-name:${label}`
			};
		}
		if (ref.kind === 'attackDie') {
			const die = myPlayer?.attackDice.find((candidate) => candidate.instanceId === ref.instanceId);
			const tier = die?.tier ?? 'basic';
			return {
				label: labelHint ?? opt?.label ?? `${tier[0].toUpperCase()}${tier.slice(1)} Attack die`,
				image: attackDieImageUrl(assets, tier),
				group: `attackDie:${ref.instanceId}`
			};
		}
		return { label: labelHint ?? 'Augment', image: null, group: 'augment' };
	}

	type AwakenGroup = {
		key: string;
		label: string;
		image: string | null;
		refs: AwakenDiscardRef[];
		eligible: boolean;
		reason?: string;
	};
	const awakenGroups = $derived.by<AwakenGroup[]>(() => {
		const offer = pickingOffer;
		if (!offer) return [];
		const groups = new Map<string, AwakenGroup>();
		const add = (ref: AwakenDiscardRef, eligible: boolean, labelHint?: string, reason?: string) => {
			const d = refDisplay(ref, labelHint);
			const existing = groups.get(d.group);
			if (existing) {
				if (!existing.refs.some((r) => refKey(r) === refKey(ref))) existing.refs.push(ref);
				return;
			}
			groups.set(d.group, {
				key: d.group,
				label: d.label,
				image: d.image,
				refs: [ref],
				eligible,
				reason
			});
		};
		if (awakenCostSlots) {
			for (const slot of awakenCostSlots) for (const ref of slot.eligibleRefs) add(ref, true);
		} else {
			for (const opt of offer.options) add(opt.ref, true, opt.label);
		}
		return [...groups.values()];
	});

	function awakenSlotAccepts(slotIndex: number, ref: AwakenDiscardRef): boolean {
		if (!awakenCostSlots) return true;
		const slot = awakenCostSlots[slotIndex];
		return !!slot && slot.eligibleRefs.some((r) => refKey(r) === refKey(ref));
	}
	function tapAwakenGroup(key: string) {
		const group = awakenGroups.find((g) => g.key === key);
		if (!group || !group.eligible) return;
		const usedKeys = new Set(awakenFilled.filter((r): r is AwakenDiscardRef => !!r).map(refKey));
		// Stage one more copy from this card into the first open slot that accepts it…
		for (const ref of group.refs) {
			if (usedKeys.has(refKey(ref))) continue;
			const si = awakenFilled.findIndex((f, i) => !f && awakenSlotAccepts(i, ref));
			if (si >= 0) {
				awakenFilled = awakenFilled.map((f, i) => (i === si ? ref : f));
				return;
			}
		}
		// …or, with nothing left to stage, tapping the card un-stages all its copies.
		const groupKeys = new Set(group.refs.map(refKey));
		awakenFilled = awakenFilled.map((f) => (f && groupKeys.has(refKey(f)) ? null : f));
	}
	const awakenCandidates = $derived<RackCandidate[]>(
		awakenGroups.map((g) => {
			const groupKeys = new Set(g.refs.map(refKey));
			const selected = awakenFilled.filter((f) => f && groupKeys.has(refKey(f))).length;
			return {
				key: g.key,
				label: g.label,
				image: g.image,
				count: g.refs.length,
				selected,
				eligible: g.eligible,
				reason: g.reason
			};
		})
	);
	const awakenMeter = $derived<MeterSlot[]>(
		Array.from({ length: awakenSlotCount }, (_, i) => {
			const cs = awakenCostSlots?.[i];
			const filled = awakenFilled[i];
			const d = filled ? refDisplay(filled) : null;
			return {
				need: cs?.need ?? 'Discard',
				needIcon: matIconById(cs?.needRuneId),
				filled: d ? { label: d.label, icon: d.image } : null
			};
		})
	);
	const awakenFilledCount = $derived(awakenFilled.filter(Boolean).length);
	const pickingArt = $derived(pickingSlot === null ? null : spiritArt(pickingSlot));

	function clickOffer(offer: PlayerProjection['awakenOffers'][number]) {
		if (offer.requiresSelection) {
			pickingSlot = offer.slotIndex;
			awakenFilled = [];
			return;
		}
		onAwaken(offer.slotIndex);
	}
	function confirmAwakenPick() {
		const offer = pickingOffer;
		if (!offer) return;
		const refs = awakenFilled.filter((r): r is AwakenDiscardRef => !!r);
		if (refs.length !== awakenSlotCount) return;
		onAwaken(offer.slotIndex, refs);
		pickingSlot = null;
		awakenFilled = [];
	}
	function cancelPick() {
		pickingSlot = null;
		awakenFilled = [];
	}

	// The board parks pass-turn while a takeover is staging a decision.
	let interactionArmed = $state(false);
	let showInfiltrator = $state(false);
	const takeoverOpen = $derived(pickingSlot !== null || interactionArmed || showInfiltrator);
	$effect(() => {
		onTakeoverOpenChange?.(takeoverOpen);
	});

	// W2b: a decision's class (for the ability-card art header) is recovered from
	// its `kind` ("arcMageTrade" → "Arc Mage") by prefix-matching the class-trait
	// catalog. Purely cosmetic — never a rules derivation.
	function decisionClassName(kind: string): string | null {
		const norm = kind.toLowerCase();
		let best: string | null = null;
		for (const cls of assets.classTraits.values()) {
			const name = cls.name;
			if (!name) continue;
			const flat = name.toLowerCase().replace(/[^a-z]/g, '');
			if (flat && norm.startsWith(flat) && (!best || name.length > best.length)) best = name;
		}
		return best;
	}

	const heldRunes = $derived((myPlayer?.mats ?? []).filter((r) => r.hasRune));
	const runeOverLimit = $derived(heldRunes.length > RUNE_CARRY_LIMIT);

	// ── W2c staged rune-overflow discard (commit bar, undo before Confirm) ────
	const overflowCount = $derived(Math.max(0, heldRunes.length - RUNE_CARRY_LIMIT));
	/** §5.4 overflow extension: engine-owned held-slot list (fallback = own mats). */
	const overflowWork = $derived(
		seatAffordances?.pendingWork?.find((w) => w.kind === 'overflow') ?? null
	);
	const overflowRunes = $derived.by(() => {
		const engineSlots = overflowWork?.heldRuneSlotIndexes;
		if (!engineSlots) return heldRunes;
		const bySlot = new Map(heldRunes.map((r) => [r.slotIndex, r]));
		return engineSlots
			.map((s) => bySlot.get(s))
			.filter((r): r is (typeof heldRunes)[number] => !!r);
	});
	let stagedRunes = $state<number[]>([]);
	function toggleRuneStage(slotIndex: number) {
		if (busy) return;
		if (stagedRunes.includes(slotIndex)) {
			stagedRunes = stagedRunes.filter((s) => s !== slotIndex);
		} else if (stagedRunes.length < overflowCount) {
			stagedRunes = [...stagedRunes, slotIndex];
		}
	}
	const overflowMeter = $derived<MeterSlot[]>(
		Array.from({ length: overflowCount }, (_, i) => {
			const rune = stagedRunes[i] !== undefined
				? heldRunes.find((r) => r.slotIndex === stagedRunes[i])
				: null;
			return {
				need: 'Rune',
				needIcon: null,
				filled: rune ? { label: rune.name ?? 'Rune', icon: runeIconUrl(assets, rune) } : null
			};
		})
	);
	function confirmRuneDiscard() {
		if (busy || stagedRunes.length !== overflowCount) return;
		onDiscardRunes([...stagedRunes]);
		stagedRunes = [];
	}
	// Drop stale stages if the rack changes out from under the selection.
	$effect(() => {
		const held = new Set(heldRunes.map((r) => r.slotIndex));
		if (stagedRunes.some((s) => !held.has(s)))
			stagedRunes = stagedRunes.filter((s) => held.has(s));
		if (stagedRunes.length > overflowCount) stagedRunes = stagedRunes.slice(0, overflowCount);
	});

	// ── W2c staged corruption discard (commit bar, undo before Confirm) ───────
	const corruptionCount = $derived(myPlayer?.pendingCorruptionDiscard?.count ?? 0);
	const corruptionReason = $derived(myPlayer?.pendingCorruptionDiscard?.reason ?? null);
	/** §5.4 corruptionDiscard extension: engine-owned eligible slots + reason copy. */
	const corruptionWork = $derived(
		seatAffordances?.pendingWork?.find((w) => w.kind === 'corruptionDiscard') ?? null
	);
	const corruptionEligibleSlots = $derived(corruptionWork?.eligibleSpiritSlots);
	let stagedCorruption = $state<number[]>([]);
	function toggleCorruptionStage(slotIndex: number) {
		if (busy) return;
		if (stagedCorruption.includes(slotIndex)) {
			stagedCorruption = stagedCorruption.filter((s) => s !== slotIndex);
		} else if (stagedCorruption.length < corruptionCount) {
			stagedCorruption = [...stagedCorruption, slotIndex];
		}
	}
	function spiritMeterIcon(slotIndex: number): string | null {
		const spirit = myPlayer?.spirits.find((s) => s.slotIndex === slotIndex);
		if (!spirit) return null;
		if (spirit.isFaceDown) return spiritBackImageUrl(spirit.id);
		return spiritImages.get(spirit.id) ?? spiritBackImageUrl(spirit.id);
	}
	const corruptionMeter = $derived<MeterSlot[]>(
		Array.from({ length: corruptionCount }, (_, i) => {
			const slot = stagedCorruption[i];
			const spirit =
				slot !== undefined ? myPlayer?.spirits.find((s) => s.slotIndex === slot) : null;
			return {
				need: 'Spirit',
				needIcon: null,
				filled: spirit
					? { label: spirit.name, icon: slot !== undefined ? spiritMeterIcon(slot) : null }
					: null
			};
		})
	);
	function confirmCorruptionDiscard() {
		if (busy || stagedCorruption.length !== corruptionCount) return;
		onDiscardSpirits([...stagedCorruption]);
		stagedCorruption = [];
	}
	$effect(() => {
		const owned = new Set((myPlayer?.spirits ?? []).map((s) => s.slotIndex));
		if (stagedCorruption.some((s) => !owned.has(s)))
			stagedCorruption = stagedCorruption.filter((s) => owned.has(s));
		if (stagedCorruption.length > corruptionCount)
			stagedCorruption = stagedCorruption.slice(0, corruptionCount);
	});

	// At the Abyss, monster combat is once per round (plus any extra-action credits).
	// Once it's spent, the "Fight the Monster" card becomes a passive prompt.
	// Monster-combat allowance is 1 + extra credits (Ironmane grants +1 ⇒ two fights),
	// so we render ONE fight card per allowed fight; each is spent left-to-right as
	// `combatUsedCount` rises.
	const combatUsedCount = $derived(
		(myPlayer?.actionsUsedThisRound ?? []).filter((a) => a === 'combat').length
	);
	const combatAllowance = $derived(1 + (myPlayer?.extraActions?.combat ?? 0));
	const spiritAugmentsBySlot = $derived.by(() => {
		const map = new Map<number, { runeId: string; name: string; icon: string | null }[]>();
		for (const att of myPlayer?.spiritAugmentAttachments ?? []) {
			const className = typeof att.className === 'string' ? att.className : null;
			if (!className) continue;
			const arr = map.get(att.spiritSlotIndex) ?? [];
			arr.push({
				runeId: att.runeId,
				name: `${className} Augment`,
				icon: augmentIconForClass(assets, className)
			});
			map.set(att.spiritSlotIndex, arr);
		}
		return map;
	});
	const faceDownBackImageBySlot = $derived.by(() => {
		const map = new Map<number, string>();
		for (const s of myPlayer?.spirits ?? []) {
			if (s.isFaceDown) map.set(s.slotIndex, spiritBackImageUrl(s.id));
		}
		return map;
	});

	const pendingAugments = $derived(myPlayer?.unplacedAugments ?? []);
	const currentAugment = $derived(pendingAugments[0] ?? null);
	// ── W2e: placement eligibility is ENGINE-OWNED (§5.4 augment extension) — the
	// client `isAugmentEligible` re-derivation is gone (S5). One entry per unplaced
	// augment, order-matched to `unplacedAugments` (runeId re-checked defensively).
	const augmentWork = $derived(
		seatAffordances?.pendingWork?.find((w) => w.kind === 'augment') ?? null
	);
	const engineAugment = $derived.by(() => {
		const list = augmentWork?.augments;
		if (!list?.length || !currentAugment) return null;
		return list.find((a) => a.runeId === currentAugment.runeId) ?? list[0];
	});
	const designatedAugmentClass = $derived.by(() => {
		const id = currentAugment?.classId;
		if (!id) return null;
		const name = assets.classTraits.get(id)?.name;
		return name && isSpiritAugmentClass(name) ? name : null;
	});
	const augmentClassNames = $derived(
		engineAugment?.classChoices ??
			(designatedAugmentClass ? [designatedAugmentClass] : [...SPIRIT_AUGMENT_CLASSES])
	);
	const augmentChoices = $derived(
		augmentClassNames.map((className) => ({
			className,
			icon: augmentIconForClass(assets, className)
		}))
	);
	let pickedAugmentClass = $state<string | null>(null);
	const armedAugmentClass = $derived(
		augmentClassNames.length === 1 ? augmentClassNames[0] : pickedAugmentClass
	);

	const augmentEligibleSlots = $derived(engineAugment?.eligibleSpiritSlots ?? []);
	const augmentSlotReasons = $derived(engineAugment?.slotReasons ?? {});
	const noAugmentTarget = $derived(pendingAugments.length > 0 && augmentEligibleSlots.length === 0);
	function dropAugmentOn(slotIndex: number) {
		if (busy || !currentAugment || !armedAugmentClass || !augmentEligibleSlots.includes(slotIndex))
			return;
		onPlaceAugment(0, currentAugment.runeId, slotIndex, armedAugmentClass);
		pickedAugmentClass = null;
	}
	// Button honesty (F6): forfeiting live augments takes a confirm beat; the
	// no-target state admits what it does in one step (there is nothing to place).
	let forfeitArmed = $state(false);
	$effect(() => {
		if (pendingAugments.length === 0) forfeitArmed = false;
	});
	function forfeitAugments() {
		if (busy) return;
		if (!noAugmentTarget && !forfeitArmed) {
			forfeitArmed = true;
			return;
		}
		forfeitArmed = false;
		onDiscardAugments();
	}

	// ── Infiltrator: Location-phase dice swap (W2d — InfiltratorSwap takeover) ──
	// The opportunity is ENGINE-OWNED (§5.4 `SeatAffordances.infiltratorSwap`,
	// voluntary so it rides beside pendingWork): present exactly when the seat has
	// an awakened, unused Infiltrator sharing a location. The client only decorates
	// seats with names/accents.
	const infiltratorWork = $derived(seatAffordances?.infiltratorSwap ?? null);
	const infiltratorTargets = $derived(
		(infiltratorWork?.targets ?? [])
			.map((t) => ({
				seat: t.seat,
				name: room.players[t.seat]?.displayName ?? t.seat,
				accent: seatAccent(t.seat),
				dice: t.dice
			}))
			.filter((t) => t.dice.length > 0)
	);
	const canInfiltrate = $derived(
		infiltratorWork != null &&
			(infiltratorWork.myDice.length ?? 0) > 0 &&
			infiltratorTargets.length > 0
	);
	$effect(() => {
		// Auto-close the swap screen if eligibility lapses (swap done / left location).
		if (showInfiltrator && !canInfiltrate) showInfiltrator = false;
	});

	// Spectators always see the read-only destination board.
	const showNavBoard = $derived(room.phase === 'navigation' || !mySeat);

	const myDestination = $derived(myPlayer?.navigationDestination ?? null);
	const amEvil = $derived(myPlayer ? isEvilAlignment(myPlayer.statusLevel) : false);
	// ── W2d encounter surface. Targets/votes are ENGINE-OWNED (§5.4
	// `SeatAffordances.encounter`, voluntary so it rides beside pendingWork); the
	// fallback mirrors the projection-derived set the old chips used, for views
	// that predate the affordance (spectator-style renders never take this branch).
	const encounterWork = $derived(seatAffordances?.encounter ?? null);
	const encounterTargets = $derived.by(() => {
		if (encounterWork) return encounterWork.eligibleTargets;
		if (!amEvil || !myDestination || myDestination === 'Arcane Abyss') return [] as SeatColor[];
		return room.activeSeats.filter(
			(s) =>
				s !== mySeat &&
				room.players[s]?.navigationDestination === myDestination &&
				!isEvilAlignment(room.players[s]?.statusLevel ?? 0)
		);
	});
	function guardianArt(seat: SeatColor): string | null {
		const name = room.players[seat]?.selectedGuardian;
		const g = name ? assets.guardianAssets.get(name) : null;
		return storageUrl(g?.icon_image_path ?? g?.chibi_image_path ?? null);
	}
	const encounterTargetCards = $derived(
		encounterTargets.map((seat) => ({
			seat,
			name: room.players[seat]?.displayName ?? seat,
			accent: seatAccent(seat),
			art: guardianArt(seat)
		}))
	);
	const myEncounterVote = $derived(myPlayer?.encounterVote ?? null);
	/** Every Evil player here (me included) — the set whose unanimous "attack"
	 *  fires the strike; `voted` = has cast the attack vote. */
	const encounterVoters = $derived.by(() => {
		if (!myDestination) return [];
		const evilHere = room.activeSeats.filter(
			(s) =>
				room.players[s]?.navigationDestination === myDestination &&
				isEvilAlignment(room.players[s]?.statusLevel ?? 0)
		);
		const pending = encounterWork?.votesPending;
		return evilHere.map((seat) => ({
			seat,
			name: room.players[seat]?.displayName ?? seat,
			accent: seatAccent(seat),
			voted: pending
				? !pending.includes(seat)
				: (room.players[seat]?.encounterVote ?? null) === 'attack',
			isMe: seat === mySeat
		}));
	});

	const needsCorruptionDiscard = $derived(
		activeAction !== 'combat' && (myPlayer?.pendingCorruptionDiscard?.count ?? 0) > 0
	);
	const needsAugmentPlacement = $derived(
		activeAction !== 'combat' && (myPlayer?.unplacedAugments?.length ?? 0) > 0
	);
	const needsAbilityDecision = $derived(
		activeAction !== 'combat' &&
			(room.phase === 'location' || room.phase === 'encounter') &&
			(myPlayer?.pendingDecisions?.length ?? 0) > 0
	);
	const mainInstruction = $derived.by(() => {
		if (holdRealmEntry) return '';
		if (showNavBoard) {
			return confirmedDestination && mySeat ? 'Destination Locked.' : 'Choose a Destination.';
		}
		if (needsCorruptionDiscard) return 'Discard Spirits.';
		if (needsAugmentPlacement) return 'Place Augments.';
		if (needsAbilityDecision) return 'Resolve Ability.';
		if (room.phase === 'encounter') {
			if (encounterTargets.length > 0) {
				return myEncounterVote === 'attack' ? 'Waiting for Allies.' : 'Choose Encounter Action.';
			}
			if (myReady) return 'Waiting for Players.';
			return 'Resolving Encounters.';
		}
		if (room.phase === 'location') {
			if (pendingDraw) return 'Choose a Spirit.';
			if (activeAction === 'combat') return pendingReward ? 'Claim Rewards.' : 'Resolve Combat.';
			if (pendingReward) return 'Claim Rewards.';
			if (activeAction === 'rest' || activeAction === 'cultivate' || activeAction === 'reward') {
				return 'Review Result.';
			}
			if (myReady) return 'Waiting for Players.';
			if (showInfiltrator) return 'Swap Dice.';
			return 'Choose an Action.';
		}
		if (room.phase === 'benefits') {
			if (myReady) return 'Waiting for Players.';
			return awakenReward ? 'Claim Benefits.' : '';
		}
		if (room.phase === 'awakening') {
			if (myReady) return 'Waiting for Players.';
			if (awakeningChoices.length > 0 || manualPrompts.length > 0) return 'Resolve Ability.';
			if (pickingOffer || awakenOffers.length > 0) return 'Awaken Spirits.';
			return '';
		}
		if (room.phase === 'cleanup') {
			if (myReady) return 'Waiting for Players.';
			return runeOverLimit ? 'Discard Runes.' : '';
		}
		return '';
	});
</script>

<div class="stage" class:realm={inRealm} data-testid="main-stage" data-phase={room.phase}>
	{#if inRealm}<div class="realm-veil" aria-hidden="true"></div>{/if}
	<div class="view">
		<div class="main-instruction" data-testid="main-scene-instruction" aria-live="polite">
			{mainInstruction}
		</div>
		<div class="view-body">
			{#if holdRealmEntry}
				<!-- Reveal → realm-enter choreography is playing over the splat; hold the stage
		     clear so the location interaction UI doesn't flash in before the zoom. -->
			{:else if showNavBoard}
				{#if confirmedDestination && mySeat}
					<!-- The navigator clears to an enhanced "Going to {World}" circle hosting the
			     chosen world's OWN masked splat. It measures its cell and sizes itself with
			     compassDiameter (like the compass) so it is never cropped, and falls back to
			     the plain confirmed panel when a circle won't fit. -->
					<ConfirmDestinationCircle
						destination={confirmedDestination}
						location={assets.gameLocations.get(confirmedDestination) ?? null}
						iconPool={assets.iconPool}
						accent={LOCATION_ACCENT[confirmedDestination] ?? '#8d8aa1'}
						monster={room.monster}
						splatSrc={splatFor(confirmedDestination)}
						canExit={true}
						onExit={() => onExitConfirmed?.()}
					/>
				{:else}
					<SpiritWorldBoard
						{room}
						{mySeat}
						selectable={canPick}
						selectedDestination={lockedDestination}
						{focusedDestination}
						onHover={onHoverDestination}
						onSelect={onSelectDestination}
						{onSceneControls}
						monster={room.monster}
						gameLocations={assets.gameLocations}
						iconPool={assets.iconPool}
					/>
				{/if}
			{:else if needsCorruptionDiscard}
				<!-- W2c: forced corruption discard, STAGED — marks accumulate on the hex board
		     and nothing is sent back to the bag until the commit bar confirms (undo by
		     tapping a marked hex again). Surfaced in-stage in whatever phase it's
		     pending (combat sets it in location/encounter). -->
				<div class="scene-flow board-decision corruption-decision" data-testid="corruption-discard">
					<p class="scene-prompt danger">
						{corruptionReason ?? corruptionWork?.reason ?? 'You were corrupted'} — mark
						{corruptionCount}
						spirit{corruptionCount === 1 ? '' : 's'} to send back to the bag.
					</p>
					<div class="scene-hex-wrap" data-testid="corruption-discard-hexes">
						<HexGrid
							spirits={myPlayer?.spirits ?? []}
							spiritAssets={spiritImages}
							backImageBySlot={faceDownBackImageBySlot}
							augmentsBySlot={spiritAugmentsBySlot}
							discardMode={!busy}
							stagedSlots={stagedCorruption}
							discardEligibleSlots={corruptionEligibleSlots}
							onDiscard={toggleCorruptionStage}
						/>
					</div>
					<CommitBar
						slots={corruptionMeter}
						confirmLabel={`Discard ${stagedCorruption.length}/${corruptionCount} spirit${corruptionCount === 1 ? '' : 's'}`}
						confirmDisabled={stagedCorruption.length !== corruptionCount}
						confirmTestid="corruption-confirm"
						onConfirm={confirmCorruptionDiscard}
						{busy}
						accent="var(--color-blood, #e05858)"
					/>
				</div>
				{:else if needsAugmentPlacement}
					<!-- Spirit Augment placement — in-stage (pick an augment icon, click a spirit). -->
					<div class="scene-flow board-decision augment-decision" data-testid="augment-placement">
						<p class="scene-prompt">
							{pendingAugments.length} augment{pendingAugments.length === 1 ? '' : 's'} to place{currentAugment?.boundLabel
								? ` for ${currentAugment.boundLabel}`
								: ''}.
						</p>
						<div class="aug-list" data-testid="augment-icons">
							{#each augmentChoices as a (a.className)}
								<button
									type="button"
									class="aug-icon"
									class:armed={armedAugmentClass === a.className}
									disabled={busy || augmentClassNames.length === 1}
									title={a.className}
									aria-pressed={armedAugmentClass === a.className}
									data-testid={`augment-icon-${a.className}`}
									onclick={() =>
										(pickedAugmentClass = pickedAugmentClass === a.className ? null : a.className)}
								>
									{#if a.icon}<img src={a.icon} alt={a.className} />{:else}<span class="aug-fb"
											>{a.className}</span
										>{/if}
								</button>
							{/each}
						</div>
						<p class="scene-hint">
							{#if armedAugmentClass}
								Click a spirit to place the <strong>{armedAugmentClass}</strong> augment{currentAugment?.boundLabel
									? ` on ${currentAugment.boundLabel}`
									: ''}.
							{:else}
								Click an augment, then a spirit on your board.
							{/if}
						</p>
						<div class="scene-hex-wrap">
							<HexGrid
								spirits={myPlayer?.spirits ?? []}
								spiritAssets={spiritImages}
								backImageBySlot={faceDownBackImageBySlot}
								augmentsBySlot={spiritAugmentsBySlot}
								augmentDropMode={!busy && armedAugmentClass !== null}
								augmentEligibleSlots={augmentEligibleSlots}
								slotReasons={augmentSlotReasons}
								onDropAugment={dropAugmentOn}
							/>
						</div>
						<div class="scene-actions">
							{#if noAugmentTarget}
								<span class="scene-note" data-testid="augment-no-target">
									No spirit can hold {pendingAugments.length === 1 ? 'this augment' : 'these augments'}.
								</span>
							{:else if forfeitArmed}
								<span class="scene-note" data-testid="augment-forfeit-warning">
									{pendingAugments.length === 1 ? 'This augment' : `These ${pendingAugments.length} augments`}
									will be destroyed, not saved.
								</span>
								<button
									type="button"
									class="ghost-btn"
									disabled={busy}
									data-testid="augment-keep-placing"
									onclick={() => (forfeitArmed = false)}>Keep placing</button
								>
							{/if}
							<!-- Button honesty (F6): "Done" never silently destroys augments — the
							     label says forfeit, and forfeiting live targets takes a confirm beat. -->
							<button
								type="button"
								class="primary-btn"
								class:urgent={noAugmentTarget || forfeitArmed}
								disabled={busy}
								data-testid="augment-done"
								onclick={forfeitAugments}
								>{noAugmentTarget
									? `Discard ${pendingAugments.length} & continue`
									: forfeitArmed
										? `Really forfeit ${pendingAugments.length}?`
										: `Forfeit ${pendingAugments.length} unplaced`}</button
							>
						</div>
					</div>
				{:else if needsAbilityDecision}
					<!-- W2b: decisions as ability cards — class art header, prompt headline,
					     full-width choice rows; pickers (Arc Mage dice) live inside the card. -->
					<div class="scene-flow decision-flow" data-testid="decision-cards">
						{#each awakeningChoices as choice (choice.id)}
							{@const cls = decisionClassName(choice.kind)}
							<DecisionCard
								decision={choice}
								pickerSpec={pickerSpecFor(choice)}
								attackDice={myPlayer?.attackDice ?? []}
								dieImage={(tier) => attackDieImageUrl(assets, tier)}
								classIcon={cls ? classIconFor(cls) : null}
								sourceLabel={cls}
								{busy}
								testidPrefix="decision"
								onResolve={onResolveDecision}
							/>
						{/each}
					</div>
			{:else if room.phase === 'encounter'}
				{#if encounterTargets.length > 0}
					<!-- W2d: targets as guardian-portrait cards, Attack/Hold in the commit bar,
					     the unanimity requirement shown as live per-seat vote chips. Stays on
					     stage AFTER voting (readiness flips then) so the aggressor watches the
					     ally votes come in instead of a blank waiting screen. -->
					<EncounterStage
						targets={encounterTargetCards}
						voters={encounterVoters}
						myVote={myEncounterVote}
						{busy}
						onAttack={onAttackGroup}
						onHold={onPass}
					/>
				{:else if myReady}
					<div class="waiting" data-testid="stage-waiting">Waiting for other players…</div>
				{:else}
					<div class="waiting">Resolving encounters…</div>
				{/if}
			{:else if room.phase === 'location'}
				{#if pendingDraw}
					<div class="summon-stage">
						<DrawTray
							player={myPlayer}
							{spiritImages}
							disabled={busy}
							{onSummon}
							{onDiscard}
							{onRedraw}
						/>
					</div>
				{:else if activeAction === 'combat'}
					<div class="combat-stage">
						<CombatOverlay combats={room.combats} {mySeat} />
						<button
							type="button"
							class="continue"
							data-testid="combat-continue"
							onclick={() => onContinue()}
						>
							{pendingReward ? 'Claim rewards' : 'Continue'}
						</button>
					</div>
				{:else if pendingReward}
					<!-- W2a: the loot moment as a stage takeover (medallion fan + pick meter). -->
					<MonsterRewardTakeover
						reward={pendingReward}
						resolved={seatAffordances?.pendingReward ?? null}
						{assets}
						accent={myAccent}
						{busy}
						onClaim={onClaimReward}
					/>
				{:else if activeAction === 'rest' || activeAction === 'cultivate' || activeAction === 'reward'}
					<ActionResult result={myPlayer?.lastAction ?? null} {onContinue} />
				{:else if myReady}
					<div class="waiting" data-testid="stage-waiting">Waiting for other players…</div>
				{:else}
					<div class="location-action-view">
						<div class="location-action-body">
							{#if myLocationConfig?.combatOnly}
								<div class="combat-action-lane">
									<div class="card-grid">
										{#each Array(combatAllowance) as _, i (i)}
											{@const spent = i < combatUsedCount}
											<StageCard
												title="Fight the Monster"
												subtitle={combatAllowance > 1
													? spent
														? `Fight ${i + 1} of ${combatAllowance} — done.`
														: `Fight ${i + 1} of ${combatAllowance} — battle the invading monster.`
													: spent
														? 'You have fought this round — pass your turn.'
														: 'Battle the invading monster for Victory Points and rewards.'}
												glyph="⚔"
												accent={myAccent}
												disabled={busy || spent}
												testid={combatAllowance > 1
													? `action-monsterCombat-${i}`
													: 'action-monsterCombat'}
												onClick={() => onStartCombat()}
											/>
										{/each}
									</div>
									<!-- The Abyss also carries its own location actions (a free Arcane Abyss
							     Summon), shown alongside the monster fight. -->
									<LocationInteractionMenu
										location={myLocationAsset}
										iconPool={assets.iconPool}
										{assets}
										player={myPlayer}
										accent={myAccent}
										{busy}
										{seatAffordances}
										onArmedChange={(armed) => (interactionArmed = armed)}
										onResolve={onResolveInteraction}
									/>
								</div>
							{:else if showInfiltrator}
								<!-- W2d: real gem-token dice in facing rows, staged pairs, commit bar. -->
								<InfiltratorSwap
									targets={infiltratorTargets}
									myDice={infiltratorWork?.myDice ?? []}
									dieImage={(tier) => attackDieImageUrl(assets, tier)}
									classIcon={classIconFor('Infiltrator')}
									{busy}
									onConfirm={(swaps) => {
										onInfiltratorSwap(swaps);
										showInfiltrator = false;
									}}
									onCancel={() => (showInfiltrator = false)}
								/>
							{:else}
								{#if canInfiltrate}
									<button
										type="button"
										class="infil-open"
										disabled={busy}
										data-testid="infiltrator-open"
										onclick={() => (showInfiltrator = true)}
									>
										🎴 Infiltrator — swap dice with co-located players
									</button>
								{/if}
								<LocationInteractionMenu
									location={myLocationAsset}
									iconPool={assets.iconPool}
									{assets}
									player={myPlayer}
									accent={myAccent}
									{busy}
									{seatAffordances}
									onArmedChange={(armed) => (interactionArmed = armed)}
									onResolve={onResolveInteraction}
								/>
							{/if}
						</div>
					</div>
				{/if}
				{:else if room.phase === 'benefits'}
					{#if awakenReward}
						<!-- W1c benefits claim: grant cards at full stage width, a segmented
						     heart↔die split (no ± arithmetic), and full-size relic racks. The
						     commit bar claims everything at once. -->
						<div class="claim-stage" data-testid="awaken-claim">
							<div class="claim-scroll">
								{#each fixedGrants as g (g.source + g.kind)}
									{@const icon = classIconFor(g.source)}
									<section class="grant-card">
										<span class="grant-art">
											{#if icon}<img src={icon} alt={g.source} />{:else}<span class="grant-fb">✦</span
												>{/if}
										</span>
										<span class="grant-body">
											<span class="grant-source">{g.source}</span>
											<span class="grant-what">{grantLabel(g)}</span>
											{#if g.kind === 'vp' && g.note}<span class="grant-note">{g.note}</span>{/if}
										</span>
									</section>
								{/each}
								{#if taintedGrant}
									<section class="grant-card choice-card">
										<span class="grant-art">
											{#if classIconFor('Cursed Spirit')}<img
													src={classIconFor('Cursed Spirit')}
													alt="Cursed Spirit"
												/>{:else}<span class="grant-fb">✦</span>{/if}
										</span>
										<span class="grant-body">
											<span class="grant-source">Cursed Spirit · Tainted</span>
											<span class="grant-what"
												>Split {taintedMax} between Potential and Enchanted Attack — tap a token to
												flip it.</span
											>
											<div class="tainted-row" role="group" aria-label="Split tainted units">
												{#each taintedSeg as seg, i (i)}
													<button
														type="button"
														class="tainted-seg"
														class:potential={seg}
														disabled={busy}
														aria-label={seg ? 'Potential — tap for Enchanted Attack' : 'Enchanted Attack — tap for Potential'}
														data-testid={`tainted-seg-${i}`}
														onclick={() => toggleTaintedSeg(i)}
													>
														{#if seg}
															{#if potentialIcon}<img src={potentialIcon} alt="" />{:else}<span
																	class="seg-glyph">♥</span
																>{/if}
															<span class="seg-label">Potential</span>
														{:else}
															<span class="seg-die" aria-hidden="true"></span>
															<span class="seg-label">Attack</span>
														{/if}
													</button>
												{/each}
											</div>
											<span class="tainted-total">
												<strong data-testid="claim-potential">{taintedPotentialClamped}</strong>
												Potential ·
												<strong data-testid="claim-enchanted">{taintedEnchanted}</strong> Enchanted
												Attack
											</span>
										</span>
									</section>
								{/if}
								{#if relicGrant}
									<section class="grant-card choice-card relic-card">
										<span class="grant-art">
											{#if classIconFor('Cursed Spirit')}<img
													src={classIconFor('Cursed Spirit')}
													alt="Cursed Spirit"
												/>{:else}<span class="grant-fb">✦</span>{/if}
										</span>
										<span class="grant-body">
											<span class="grant-source">Cursed Spirit · Corrupt</span>
											<span class="grant-what"
												>Choose {relicGrant.amount} relic{relicGrant.amount === 1 ? '' : 's'} — one per
												row.</span
											>
											<div class="relic-rows" data-testid="claim-relic-picks">
												{#each relicPicks as pick, unit (unit)}
													<div class="relic-row" class:done={pick !== null}>
														<span class="relic-row-tag">{unit + 1}</span>
														<CandidateRack
															size="md"
															candidates={relicChoices.map((rc, ri) => ({
																key: String(ri),
																label: rc.name,
																image: rc.icon,
																count: 1,
																selected: pick === ri ? 1 : 0,
																eligible: true
															}))}
															onTap={(key) => pickRelic(unit, Number(key))}
															disabled={busy}
															testidPrefix={`claim-relic-${unit}`}
															ariaLabel={`Choose relic ${unit + 1}`}
														/>
													</div>
												{/each}
											</div>
										</span>
									</section>
								{/if}
							</div>
							<CommitBar
								summary={claimSummary}
								warning={relicGrant && !relicPicksComplete ? 'Pick your relics to claim' : null}
								confirmLabel="Claim rewards"
								confirmDisabled={!relicPicksComplete}
								confirmTestid="awaken-claim-btn"
								onConfirm={claimBenefits}
								{busy}
							/>
						</div>
					{/if}
				{:else if room.phase === 'awakening'}
				{#if awakeningChoices.length > 0 || pickingOffer || awakenOffers.length > 0 || awakenLocked.length > 0 || manualPrompts.length > 0}
					<div class="scene-flow" class:takeover-host={!!pickingOffer} data-testid="awakening-actions">
						{#if pickingOffer}
							<!-- W1a payment takeover: the stage becomes the picker. Selections stage
							     into the cost meter; nothing is spent until Confirm sends the exact
							     refs (the engine rejects any that don't satisfy the cost). -->
							<TakeoverStage
								accent="var(--brand-magenta, #ff2bc7)"
								testid="awaken-discard-pick"
								onEscape={busy ? null : cancelPick}
							>
								{#snippet source()}
									<SourcePanel
										title={pickingOffer.spiritName}
										subtitle={pickingOffer.requirement}
										image={pickingArt}
										imageAlt={pickingOffer.spiritName}
										flip
									/>
								{/snippet}
								<p class="rack-hint">
									Tap {awakenSlotCount === 1 ? 'the item' : `${awakenSlotCount} items`} to pay with —
									locked cards can't pay this cost.
								</p>
								<CandidateRack
									candidates={awakenCandidates}
									onTap={tapAwakenGroup}
									disabled={busy}
									testidPrefix="discard-option"
									ariaLabel="Choose which items to discard"
								/>
								{#snippet bar()}
									<CommitBar
										slots={awakenMeter}
										confirmLabel={`Discard ${awakenFilledCount}/${awakenSlotCount} & Awaken`}
										confirmDisabled={awakenFilledCount !== awakenSlotCount}
										confirmTestid="awaken-discard-confirm"
										onConfirm={confirmAwakenPick}
										onCancel={cancelPick}
										{busy}
									/>
								{/snippet}
							</TakeoverStage>
						{:else}
							{#each awakeningChoices as choice (choice.id)}
								{@const cls = decisionClassName(choice.kind)}
								<DecisionCard
									decision={choice}
									pickerSpec={pickerSpecFor(choice)}
									attackDice={myPlayer?.attackDice ?? []}
									dieImage={(tier) => attackDieImageUrl(assets, tier)}
									classIcon={cls ? classIconFor(cls) : null}
									sourceLabel={cls}
									{busy}
									testidPrefix="ability-choice"
									onResolve={onResolveDecision}
								/>
							{/each}

							{#if awakenOffers.length > 0 || awakenLocked.length > 0}
								<!-- Everything that could ever flip is on stage: eligible offers lit,
								     locked spirits dimmed with the requirement they still need. -->
								<div class="offer-grid" data-testid="awaken-offers">
									{#each awakenOffers as offer, i (offer.slotIndex)}
										{@const art = spiritArt(offer.slotIndex)}
										<button
											type="button"
											class="offer"
											class:spin={spins(offer.slotIndex)}
											style="--i: {i}; --art: {art ? `url('${art}')` : 'none'};"
											data-testid={`awaken-${offer.slotIndex}`}
											disabled={busy}
											onclick={() => clickOffer(offer)}
											onpointermove={tilt}
											onpointerleave={untilt}
										>
											<span class="floater">
												<span class="tiltable">
													<span class="aura" aria-hidden="true"></span>
													{#if art}
														<img src={art} alt={offer.spiritName} loading="lazy" />
													{:else}
														<span class="offer-glyph" aria-hidden="true">✦</span>
													{/if}
													<span class="sheen" aria-hidden="true"></span>
												</span>
											</span>
											<span class="offer-name">{offer.spiritName}</span>
											<span class="offer-req">
												{offer.discardCount > 0 ? offer.requirement : 'Free — tap to awaken'}
											</span>
										</button>
									{/each}
									{#each awakenLocked as locked, i (locked.slotIndex)}
										{@const art = spiritArt(locked.slotIndex)}
										<div
											class="offer locked"
											style="--i: {awakenOffers.length + i}; --art: {art ? `url('${art}')` : 'none'};"
											data-testid={`awaken-locked-${locked.slotIndex}`}
										>
											<span class="floater still">
												<span class="tiltable">
													{#if art}
														<img src={art} alt={locked.spiritName} loading="lazy" />
													{:else}
														<span class="offer-glyph" aria-hidden="true">✦</span>
													{/if}
													<span class="offer-lock" aria-hidden="true">
														<svg viewBox="0 0 24 24" width="13" height="13">
															<path
																d="M7 10V7a5 5 0 0 1 10 0v3"
																fill="none"
																stroke="currentColor"
																stroke-width="2.4"
																stroke-linecap="round"
															/>
															<rect x="5" y="10" width="14" height="10" rx="2" fill="currentColor" />
														</svg>
													</span>
												</span>
											</span>
											<span class="offer-name">{locked.spiritName}</span>
											<span class="offer-req need">Needs: {locked.requirement}</span>
										</div>
									{/each}
								</div>
							{/if}

							{#each manualPrompts as prompt (prompt.id)}
								<ManualPromptCard
									{prompt}
									classIcon={classIconFor(prompt.source)}
									{busy}
									onDismiss={onDismissManual}
								/>
							{/each}
						{/if}
					</div>
				{/if}
				{:else if room.phase === 'cleanup'}
					{#if runeOverLimit}
						<!-- W2c: overflow trimming is STAGED — crossed runes accumulate and nothing
						     is discarded until the commit bar confirms (tap again to keep). -->
						<section class="scene-panel overflow" data-testid="rune-discard">
							<p class="scene-prompt overflow-note">
								Only {RUNE_CARRY_LIMIT} runes carry over — mark {overflowCount} to discard.
							</p>
							<!-- The grid scrolls; the commit bar stays pinned below it. -->
							<div class="rune-scroll">
								<div class="rune-grid">
									{#each overflowRunes as rune (rune.slotIndex)}
										{@const url = runeIconUrl(assets, rune)}
										{@const isStaged = stagedRunes.includes(rune.slotIndex)}
										<button
											type="button"
											class="rune-pick"
											class:staged={isStaged}
											disabled={busy}
											aria-pressed={isStaged}
											title={isStaged ? `Keep ${rune.name ?? 'rune'}` : `Discard ${rune.name ?? 'rune'}`}
											data-testid={`discard-rune-${rune.slotIndex}`}
											onclick={() => toggleRuneStage(rune.slotIndex)}
										>
											{#if url}<img src={url} alt={rune.name ?? 'Rune'} />{/if}
											<span class="x" aria-hidden="true">✕</span>
										</button>
									{/each}
								</div>
							</div>
							<CommitBar
								slots={overflowMeter}
								confirmLabel={`Discard ${stagedRunes.length}/${overflowCount} rune${overflowCount === 1 ? '' : 's'}`}
								confirmDisabled={stagedRunes.length !== overflowCount}
								confirmTestid="rune-discard-confirm"
								onConfirm={confirmRuneDiscard}
								{busy}
								accent="var(--brand-coral, #ff704d)"
							/>
						</section>
					{/if}
			{/if}
		</div>
	</div>
</div>

<style>
	/* Each phase renders exactly ONE .view. The stage is a robust full-area grid
	   that centers that view on both axes — independent of any other view's
	   layout, and with no bottom reservation pinning it upward. */
	.stage {
		width: 100%;
		height: 100%;
		display: grid;
		/* minmax(0,1fr) caps the column at the container width. Without it the
		   implicit `auto` column sizes to its content's max-content — which a wide
		   child (e.g. the mobile nav carousel's 5 slides) blows past the viewport,
		   overflowing/clipping instead of letting overflow-x scroll. */
		grid-template-columns: minmax(0, 1fr);
		place-items: center;
		min-height: 0;
		overflow: hidden;
	}
	/* A self-contained stage shell. The instruction owns a stable top row while the
	   active interaction gets the full remaining area, so child components never
	   push their own "what to do" labels around. It takes
	   the FULL stage height (not shrink-to-content) so children that need a definite
	   container — the location interaction menu's scroll region, and the navigator
	   board whose compass-vs-cards decision measures the available area — get a
	   stable size. */
	.view {
		position: relative;
		z-index: 1;
		display: grid;
		grid-template-rows: minmax(0, 1fr);
		justify-items: center;
		align-items: stretch;
		gap: 0;
		width: 100%;
		max-width: 100%;
		height: 100%;
		max-height: 100%;
		min-height: 0;
	}
	.main-instruction {
		position: absolute;
		inset: var(--stage-instruction-top, 0.75rem) 0 auto;
		z-index: 3;
		height: var(--stage-instruction-height, calc(var(--rune-row-slot-size, 3rem) + 2px));
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 0;
		padding-inline: 0.5rem;
		font-family: var(--font-display);
		font-size: var(--stage-title-size, clamp(1.8rem, 3.2vw, 2.8rem));
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: #fff;
		text-align: center;
		line-height: 1.1;
		text-shadow: 0 2px 16px rgba(0, 0, 0, 0.45);
		pointer-events: none;
		user-select: none;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.view-body {
		--stage-content-top-inset: calc(
			var(--stage-instruction-top, 0.75rem) +
				var(--stage-instruction-height, calc(var(--rune-row-slot-size, 3rem) + 2px)) +
				var(--stage-view-gap, 1rem)
		);
		box-sizing: border-box;
		grid-row: 1;
		min-height: 0;
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--stage-view-gap, 1rem);
		overflow: hidden;
		padding-top: var(--stage-content-top-inset);
	}
	/* Inside the realm the splat is sharp and full behind the HUD — a soft pool of
	   shade under the centered content keeps it legible against the live world
	   without hiding the surrounding scene. */
	.realm-veil {
		position: absolute;
		inset: 0;
		z-index: 0;
		pointer-events: none;
		background: radial-gradient(
			ellipse 58% 54% at 50% 52%,
			rgba(8, 5, 16, 0.62) 0%,
			rgba(8, 5, 16, 0.32) 55%,
			transparent 100%
		);
		animation: veil-in 700ms ease forwards;
	}
	/* The HUD rises into place as the camera dollies into the realm. */
	.stage.realm .view-body {
		animation: hud-rise 620ms cubic-bezier(0.22, 1, 0.36, 1) 200ms both;
	}
	@keyframes veil-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@keyframes hud-rise {
		from {
			opacity: 0;
			transform: translateY(20px) scale(0.97);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.realm-veil,
		.stage.realm .view-body {
			animation-duration: 1ms;
			animation-delay: 0ms;
		}
	}
	.view-body :global(.board) {
		width: 100%;
		align-self: center;
	}
	.view-body :global([data-testid='confirmed-destination']),
	.view-body :global([data-testid='monster-reward-menu']),
	.view-body :global([data-testid='draw-tray']),
	.view-body :global([data-testid='action-result']),
	.view-body :global([data-testid='awaken-claim']),
	.view-body :global([data-testid='awakening-actions']),
	.view-body :global([data-testid='rune-discard']),
	.view-body :global([data-testid='decision-cards']),
	.view-body :global([data-testid='augment-placement']),
	.view-body :global([data-testid='corruption-discard']),
	.view-body :global([data-testid='infiltrator-swap']),
	.view-body :global([data-testid='combat-overlay']) {
		box-sizing: border-box;
		max-height: 100%;
		min-height: 0;
	}
	/* Takeover-rooted views (monster rewards, infiltrator swap) scroll inside their
	   own rack column — they are NOT in this overflow list. */
	.view-body :global([data-testid='confirmed-destination']),
	.view-body :global([data-testid='draw-tray']),
	.view-body :global([data-testid='action-result']),
	.view-body :global([data-testid='awaken-claim']),
	.view-body :global([data-testid='awakening-actions']) {
		overflow-y: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
		touch-action: pan-y;
	}
		.scene-flow {
			box-sizing: border-box;
			width: min(1120px, 100%);
			min-height: 1px;
			max-height: 100%;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: clamp(0.8rem, 2.1vh, 1.35rem);
			padding: clamp(0.25rem, 1.4vh, 0.9rem) clamp(0.25rem, 2vw, 1rem);
			text-align: center;
		}
		.scene-panel {
			box-sizing: border-box;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: clamp(0.65rem, 1.7vh, 1rem);
			width: min(860px, 100%);
			min-height: 1px;
			max-height: 100%;
			text-align: center;
		}
		.primary-btn {
			align-self: center;
			padding: 0.55rem 1.2rem;
			font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		border: none;
		border-radius: 6px;
		background: var(--brand-magenta, #ff2bc7);
		color: #fff;
		cursor: pointer;
		transition:
			background 140ms ease,
			opacity 140ms ease;
	}
	.primary-btn:not(:disabled):hover {
		background: var(--brand-magenta-soft, #ff7fd9);
	}
	.primary-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.ghost-btn {
		padding: 0.5rem 1rem;
		font: inherit;
		border-radius: 6px;
		border: 1px solid rgba(255, 255, 255, 0.25);
		background: transparent;
		color: inherit;
		cursor: pointer;
	}
	.ghost-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.board-decision {
		width: min(720px, 100%);
		height: 100%;
		justify-content: center;
		gap: clamp(0.55rem, 1.6vh, 0.9rem);
	}
	.scene-hex-wrap {
		flex: 1 1 auto;
		min-height: 0;
		width: 100%;
		display: grid;
		place-items: center;
	}
	.scene-hex-wrap :global(.hex-grid) {
		width: 100%;
		height: 100%;
		max-height: 100%;
	}
	.scene-hint {
		margin: 0;
		font-size: clamp(0.78rem, 1.2vw, 0.9rem);
		text-align: center;
		color: var(--color-parchment, #d8cfee);
	}
	.scene-hint strong {
		color: var(--brand-amber-soft, #ffd56a);
	}
	.scene-note {
		font-size: clamp(0.74rem, 1vw, 0.86rem);
		color: var(--brand-amber-soft, #ffd56a);
		text-align: center;
	}
	.scene-actions {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.7rem;
		flex-wrap: wrap;
	}
	.primary-btn.urgent {
		background: var(--brand-amber, #ffba3d);
		color: var(--color-void, #0c0518);
	}
	.scene-prompt.danger {
		color: var(--brand-coral, #ff704d);
	}
	.aug-list {
		display: flex;
		justify-content: center;
		flex-wrap: wrap;
		gap: clamp(0.55rem, 1.5vw, 0.85rem);
	}
	.aug-icon {
		position: relative;
		width: clamp(3.8rem, 8vw, 5rem);
		height: clamp(3.8rem, 8vw, 5rem);
		display: grid;
		place-items: center;
		padding: 0;
		border: 0;
		background: none;
		cursor: pointer;
		opacity: 0.86;
		transition:
			transform 140ms ease,
			filter 140ms ease,
			opacity 140ms ease;
	}
	.aug-icon:not(:disabled):hover {
		transform: translateY(-2px) scale(1.05);
		opacity: 1;
	}
	.aug-icon.armed {
		opacity: 1;
		transform: translateY(-3px) scale(1.06);
		filter: drop-shadow(0 0 14px color-mix(in srgb, var(--brand-amber-soft, #ffd56a) 68%, transparent));
	}
	.aug-list:has(.aug-icon.armed) .aug-icon:not(.armed) {
		opacity: 0.32;
	}
	.aug-icon.armed::after {
		content: '✓';
		position: absolute;
		top: -0.3rem;
		left: 50%;
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 50%;
		display: grid;
		place-items: center;
		transform: translateX(-50%);
		background: var(--brand-amber-soft, #ffd56a);
		color: var(--color-void, #080510);
		font-family: var(--font-display);
		font-size: 0.82rem;
		box-shadow:
			0 0 0 2px rgba(8, 5, 16, 0.78),
			0 0 14px color-mix(in srgb, var(--brand-amber-soft, #ffd56a) 64%, transparent);
	}
	.aug-icon:disabled {
		cursor: not-allowed;
	}
	.aug-icon img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.48));
	}
	.aug-fb {
		font-family: var(--font-display);
		font-size: 0.58rem;
		line-height: 1;
		text-align: center;
		color: var(--brand-amber-soft, #ffd56a);
	}
	/* ── W1c benefits claim: full-width grant cards + commit bar ─────────────── */
	.claim-stage {
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		gap: clamp(0.6rem, 1.6vh, 1rem);
		width: min(980px, 100%);
		height: 100%;
		min-height: 0;
		padding: clamp(0.25rem, 1.2vh, 0.75rem) clamp(0.25rem, 1.6vw, 1rem)
			clamp(0.35rem, 1.4vh, 0.9rem);
	}
	.claim-scroll {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: clamp(0.55rem, 1.5vh, 0.9rem);
		overflow-y: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
	}
	/* Center when short WITHOUT justify-content:center — that combination makes
	   overflowing content unreachable above the scroll origin. */
	.claim-scroll > :first-child {
		margin-top: auto;
	}
	.claim-scroll > :last-child {
		margin-bottom: auto;
	}
	.grant-card {
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: clamp(0.7rem, 2vw, 1.1rem);
		width: 100%;
		padding: clamp(0.6rem, 1.6vh, 0.9rem) clamp(0.75rem, 2vw, 1.2rem);
		border-radius: 16px;
		border: 1px solid rgba(255, 255, 255, 0.13);
		background: rgba(15, 10, 28, 0.32);
		-webkit-backdrop-filter: blur(24px) saturate(1.3);
		backdrop-filter: blur(24px) saturate(1.3);
		box-shadow:
			0 12px 32px rgba(0, 0, 0, 0.4),
			inset 0 1px 0 rgba(255, 255, 255, 0.14);
		text-align: left;
	}
	.grant-art {
		flex: none;
		width: clamp(3rem, 6vh, 4rem);
		height: clamp(3rem, 6vh, 4rem);
		display: grid;
		place-items: center;
	}
	.grant-art img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.55));
	}
	.grant-fb {
		font-size: 1.4rem;
		color: var(--color-fog, #8d8aa1);
	}
	.grant-body {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		min-width: 0;
		flex: 1;
	}
	.grant-source {
		font-family: var(--font-display);
		font-size: 0.7rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--brand-cyan, #5cdfff);
	}
	.grant-what {
		font-size: clamp(0.9rem, 1.4vw, 1.05rem);
		line-height: 1.35;
		color: var(--color-bone, #efeaf7);
	}
	.grant-note {
		font-size: 0.8rem;
		font-style: italic;
		color: var(--color-fog, #9a93b0);
	}
	.tainted-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		padding-top: 0.15rem;
	}
	.tainted-seg {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.22rem;
		width: clamp(3.4rem, 7vh, 4.2rem);
		height: clamp(3.4rem, 7vh, 4.2rem);
		padding: 0.3rem;
		border-radius: 12px;
		border: 1.5px solid color-mix(in srgb, #4d8bf0 55%, transparent);
		background: color-mix(in srgb, #4d8bf0 14%, rgba(8, 5, 16, 0.5));
		cursor: pointer;
		transition:
			border-color 160ms ease,
			background 160ms ease,
			transform 160ms ease;
	}
	.tainted-seg.potential {
		border-color: color-mix(in srgb, var(--brand-amber-soft, #ffd56a) 65%, transparent);
		background: color-mix(in srgb, var(--brand-amber, #ffba3d) 14%, rgba(8, 5, 16, 0.5));
	}
	.tainted-seg:not(:disabled):hover {
		transform: translateY(-2px);
	}
	.tainted-seg:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	.tainted-seg img {
		width: 55%;
		height: 55%;
		object-fit: contain;
	}
	.seg-glyph {
		font-size: 1.25rem;
		color: var(--brand-amber-soft, #ffd56a);
	}
	/* Enchanted Attack die token — tier-colored gem. */
	.seg-die {
		width: 1.35rem;
		height: 1.35rem;
		border-radius: 4px;
		transform: rotate(45deg);
		background: linear-gradient(135deg, #7fb0ff 0%, #4d8bf0 55%, #2b5cc0 100%);
		box-shadow:
			0 0 10px rgba(77, 139, 240, 0.55),
			inset 0 1px 1px rgba(255, 255, 255, 0.5);
	}
	.seg-label {
		font-family: var(--font-display);
		font-size: 0.52rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.78);
	}
	.tainted-total {
		font-size: 0.88rem;
		color: var(--color-bone, #efeaf7);
	}
	.tainted-total strong {
		font-family: var(--font-display);
		font-size: 1.05rem;
		color: #fff;
	}
	.relic-rows {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		width: 100%;
	}
	.relic-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.3rem 0.4rem;
		border-radius: 12px;
		background: rgba(255, 255, 255, 0.03);
	}
	.relic-row.done {
		background: color-mix(in srgb, var(--brand-magenta, #ff2bc7) 7%, transparent);
	}
	.relic-row-tag {
		flex: none;
		width: 1.5rem;
		height: 1.5rem;
		display: grid;
		place-items: center;
		border-radius: 50%;
		font-family: var(--font-display);
		font-size: 0.72rem;
		color: rgba(255, 255, 255, 0.75);
		box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, 0.22);
	}
	.relic-row.done .relic-row-tag {
		background: var(--brand-magenta, #ff2bc7);
		color: #fff;
		box-shadow: none;
	}
	.relic-row :global(.rack) {
		justify-content: flex-start;
	}
	@media (orientation: landscape) and (max-height: 520px) and (pointer: coarse) {
		.claim-stage {
			padding: 0.2rem 0.3rem 0.3rem;
			gap: 0.4rem;
		}
		.grant-card {
			padding: 0.45rem 0.6rem;
			gap: 0.55rem;
			border-radius: 12px;
		}
		.grant-art {
			width: 2.2rem;
			height: 2.2rem;
		}
		.grant-what {
			font-size: 0.78rem;
		}
		.tainted-seg {
			width: 2.7rem;
			height: 2.7rem;
		}
	}
		.scene-prompt {
			margin: 0;
			max-width: 46rem;
			font-size: clamp(0.98rem, 1.6vw, 1.35rem);
			line-height: 1.35;
			color: #fff;
			text-wrap: balance;
			text-shadow:
				0 0 16px color-mix(in srgb, var(--brand-violet, #5a2bff) 62%, transparent),
				0 2px 14px rgba(0, 0, 0, 0.55);
		}
		.decision-flow {
			gap: clamp(0.6rem, 1.6vh, 1rem);
			overflow-y: auto;
			overscroll-behavior: contain;
			-webkit-overflow-scrolling: touch;
		}
		.offer-grid {
			display: flex;
			gap: 1.4rem;
			flex-wrap: nowrap;
			justify-content: center;
			align-items: center;
			width: 100%;
			min-height: clamp(8rem, 32vh, 15rem);
			margin: 0 auto;
			padding: 2.5rem 0;
			perspective: 1200px;
		perspective-origin: 50% 40%;
	}
	.offer {
		display: block;
		flex: 1 1 0;
		min-width: 0;
		max-width: 17rem;
		padding: 0;
		border: 0;
		background: none;
		cursor: pointer;
		color: inherit;
		font: inherit;
		transform-style: preserve-3d;
	}
	.offer:disabled {
		cursor: not-allowed;
	}
	.offer:disabled .floater {
		opacity: 0.5;
		animation-play-state: paused;
	}
	.floater {
		display: block;
		transform-style: preserve-3d;
		animation:
			summon-in 0.95s cubic-bezier(0.18, 0.7, 0.2, 1) calc(var(--i) * 0.1s) both,
			float3d calc(5.5s + var(--i) * 0.5s) ease-in-out calc(var(--i) * 0.1s + 0.95s) infinite;
	}
	.offer.spin .floater {
		animation:
			summon-in-spin 1.05s cubic-bezier(0.18, 0.7, 0.2, 1) calc(var(--i) * 0.1s) both,
			float3d calc(5.5s + var(--i) * 0.5s) ease-in-out calc(var(--i) * 0.1s + 1.05s) infinite;
	}
	.tiltable {
		position: relative;
		display: block;
		transform-style: preserve-3d;
		transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.offer img {
		display: block;
		width: 100%;
		height: auto;
		object-fit: contain;
		border-radius: 10px;
		position: relative;
		z-index: 1;
		backface-visibility: hidden;
		filter: drop-shadow(0 14px 26px rgba(0, 0, 0, 0.55));
		transition: filter 200ms ease;
	}
	@media (hover: hover) and (pointer: fine) {
		.offer:hover img {
			filter: drop-shadow(0 18px 34px rgba(0, 0, 0, 0.6))
				drop-shadow(0 0 22px color-mix(in srgb, var(--brand-magenta, #ff2bc7) 60%, transparent));
		}
	}
	.offer-glyph {
		display: grid;
		place-items: center;
		aspect-ratio: 13 / 17;
		font-size: 2.2rem;
		color: var(--brand-violet-soft, #b9a7ff);
	}
	.aura {
		position: absolute;
		inset: -14%;
		z-index: 0;
		border-radius: 50%;
		background: radial-gradient(
			circle,
			color-mix(in srgb, var(--brand-violet, #5a2bff) 55%, transparent) 0%,
			color-mix(in srgb, var(--brand-magenta, #ff2bc7) 28%, transparent) 45%,
			transparent 70%
		);
		filter: blur(10px);
		opacity: 0.55;
		animation: aura-pulse 3.6s ease-in-out infinite;
		transform: translateZ(-40px);
	}
	@media (hover: hover) and (pointer: fine) {
		.offer:hover .aura {
			opacity: 0.9;
		}
	}
	.sheen {
		position: absolute;
		inset: 0;
		z-index: 2;
		background: linear-gradient(
			115deg,
			transparent 30%,
			rgba(255, 255, 255, 0.34) 47%,
			rgba(180, 230, 255, 0.2) 53%,
			transparent 70%
		);
		background-size: 280% 280%;
		mix-blend-mode: screen;
		opacity: 0;
		pointer-events: none;
		transition: opacity 200ms ease;
		-webkit-mask-image: var(--art, none);
		mask-image: var(--art, none);
		-webkit-mask-size: contain;
		mask-size: contain;
		-webkit-mask-repeat: no-repeat;
		mask-repeat: no-repeat;
		-webkit-mask-position: center;
		mask-position: center;
	}
	@media (hover: hover) and (pointer: fine) {
		.offer:hover .sheen {
			opacity: 1;
			animation: sheen-sweep 1.1s ease-in-out;
		}
	}
		/* ── W1a takeover host + offers spread chrome ─────────────────────────── */
		.scene-flow.takeover-host {
			height: 100%;
			padding: 0;
			gap: 0;
		}
		.rack-hint {
			margin: 0;
			font-size: clamp(0.78rem, 1.2vw, 0.92rem);
			color: var(--color-parchment, #d8cfee);
			text-align: center;
		}
		.offer-name {
			display: block;
			margin-top: 0.55rem;
			font-family: var(--font-display);
			font-size: clamp(0.66rem, 1.1vw, 0.8rem);
			letter-spacing: 0.1em;
			text-transform: uppercase;
			color: #fff;
			text-align: center;
			text-shadow: 0 2px 8px rgba(0, 0, 0, 0.65);
		}
		.offer-req {
			display: block;
			margin-top: 0.25rem;
			margin-inline: auto;
			width: fit-content;
			max-width: 100%;
			padding: 0.2rem 0.55rem;
			border-radius: 999px;
			font-size: clamp(0.62rem, 1vw, 0.72rem);
			line-height: 1.3;
			color: color-mix(in srgb, var(--brand-magenta, #ff2bc7) 45%, #fff 55%);
			background: color-mix(in srgb, var(--brand-magenta, #ff2bc7) 12%, transparent);
			border: 1px solid color-mix(in srgb, var(--brand-magenta, #ff2bc7) 35%, transparent);
			text-align: center;
		}
		.offer-req.need {
			color: var(--color-fog, #a49fc0);
			background: rgba(255, 255, 255, 0.05);
			border-color: rgba(255, 255, 255, 0.16);
		}
		/* A locked spirit is on stage but visibly not payable yet. */
		.offer.locked {
			cursor: default;
		}
		.offer.locked .tiltable {
			opacity: 0.42;
			filter: grayscale(0.8) saturate(0.5);
		}
		.offer.locked .offer-name {
			color: var(--color-fog, #a49fc0);
		}
		.floater.still {
			animation: summon-in 0.95s cubic-bezier(0.18, 0.7, 0.2, 1) calc(var(--i) * 0.1s) both;
		}
		.offer-lock {
			position: absolute;
			right: 6%;
			bottom: 6%;
			z-index: 3;
			width: 1.5rem;
			height: 1.5rem;
			display: grid;
			place-items: center;
			border-radius: 50%;
			background: rgba(10, 6, 20, 0.92);
			color: var(--color-fog, #b9b4cc);
			box-shadow: 0 0 0 1.5px rgba(255, 255, 255, 0.22);
		}
		.overflow-note {
			color: var(--brand-coral, #ff704d);
		}
		.rune-grid {
			display: flex;
			flex-wrap: wrap;
			justify-content: center;
			gap: clamp(0.65rem, 2vw, 1rem);
		}
		.rune-pick {
			position: relative;
			display: grid;
			place-items: center;
			width: clamp(4rem, 11vw, 5.2rem);
			height: clamp(4rem, 11vw, 5.2rem);
			padding: 0.35rem;
			border: 0;
			background: transparent;
			cursor: pointer;
			transition:
				transform 140ms ease,
				filter 140ms ease,
				opacity 140ms ease;
		}
		.rune-pick:not(:disabled):hover {
			transform: translateY(-3px);
			filter: drop-shadow(0 0 14px color-mix(in srgb, var(--brand-coral, #ff704d) 58%, transparent));
		}
	.rune-pick:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
		.rune-pick img {
			width: 100%;
			height: 100%;
			object-fit: contain;
			filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.5));
		}
	.rune-pick .x {
		position: absolute;
		top: -8px;
		right: -8px;
		width: 20px;
		height: 20px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		font-size: 0.8rem;
		color: #fff;
		background: var(--brand-coral, #ff704d);
		opacity: 0;
		transition: opacity 140ms ease;
	}
	.rune-pick:not(:disabled):hover .x {
		opacity: 1;
	}
	/* Staged for discard (W2c): the cross holds without hover and the art recedes —
	   this rune WILL be lost when the commit bar confirms. Tap again to keep it. */
	.rune-pick.staged .x {
		opacity: 1;
		box-shadow: 0 0 0 2px rgba(8, 5, 16, 0.8);
	}
	.rune-pick.staged img {
		opacity: 0.45;
		filter: grayscale(0.6) drop-shadow(0 10px 18px rgba(0, 0, 0, 0.5));
	}
	.rune-pick.staged {
		filter: drop-shadow(0 0 12px color-mix(in srgb, var(--brand-coral, #ff704d) 45%, transparent));
	}
	.scene-panel.overflow {
		width: min(860px, 100%);
		height: 100%;
		gap: clamp(0.65rem, 1.7vh, 1rem);
	}
	.rune-scroll {
		flex: 1 1 auto;
		min-height: 0;
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow-y: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
		touch-action: pan-y;
	}
	.rune-scroll .rune-grid {
		max-height: 100%;
		margin-block: auto;
	}
	.scene-panel.overflow :global(.commit-bar),
	.scene-panel.overflow .overflow-note {
		flex: none;
	}
	.corruption-decision :global(.commit-bar) {
		flex: none;
	}
	@keyframes summon-in {
		0% {
			opacity: 0;
			transform: translateY(190px) translateZ(-420px) rotateX(38deg) rotateZ(-10deg) scale(0.16);
			filter: blur(8px) brightness(2.6);
		}
		45% {
			opacity: 1;
			filter: blur(0) brightness(1.45);
		}
		72% {
			transform: translateY(-10px) translateZ(0) rotateX(0) rotateZ(2deg) scale(1.09);
			filter: brightness(1.12);
		}
		100% {
			opacity: 1;
			transform: translateY(0) translateZ(0) rotateX(0) rotateZ(0) scale(1);
			filter: blur(0) brightness(1);
		}
	}
	@keyframes summon-in-spin {
		0% {
			opacity: 0;
			transform: translateY(190px) translateZ(-420px) rotateY(-360deg) scale(0.16);
			filter: blur(8px) brightness(2.6);
		}
		45% {
			opacity: 1;
			filter: blur(0) brightness(1.45);
		}
		72% {
			transform: translateY(-10px) translateZ(0) rotateY(0deg) scale(1.09);
			filter: brightness(1.12);
		}
		100% {
			opacity: 1;
			transform: translateY(0) translateZ(0) rotateY(0deg) scale(1);
			filter: blur(0) brightness(1);
		}
	}
	@keyframes float3d {
		0% {
			transform: translate3d(0, 0, 0) rotateZ(0deg) rotateY(-7deg) rotateX(3deg);
		}
		25% {
			transform: translate3d(7px, -11px, 0) rotateZ(1.6deg) rotateY(6deg) rotateX(-2deg);
		}
		50% {
			transform: translate3d(0, -17px, 0) rotateZ(0deg) rotateY(9deg) rotateX(-3deg);
		}
		75% {
			transform: translate3d(-7px, -9px, 0) rotateZ(-1.6deg) rotateY(2deg) rotateX(2deg);
		}
		100% {
			transform: translate3d(0, 0, 0) rotateZ(0deg) rotateY(-7deg) rotateX(3deg);
		}
	}
	@keyframes aura-pulse {
		0%,
		100% {
			opacity: 0.45;
			transform: translateZ(-40px) scale(0.94);
		}
		50% {
			opacity: 0.75;
			transform: translateZ(-40px) scale(1.06);
		}
	}
	@keyframes sheen-sweep {
		0% {
			background-position: 150% 0;
		}
		100% {
			background-position: -150% 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.floater,
		.aura {
			animation: none;
		}
		}
		@media (max-width: 600px) {
			.scene-panel {
				max-width: min(860px, 94vw);
			}
			.offer-grid {
				flex-wrap: wrap;
			gap: 1rem;
			padding: 1.5rem 0.75rem;
		}
		.offer {
			flex: 0 1 calc(50% - 0.5rem);
			max-width: calc(50% - 0.5rem);
			touch-action: manipulation;
			-webkit-tap-highlight-color: transparent;
			user-select: none;
		}
	}
	.card-grid {
		display: flex;
		flex-wrap: nowrap; /* always a single row */
		gap: var(--stage-card-gap, 0.85rem);
		justify-content: center;
		align-items: stretch;
		/* The parent stage grid already reserves room for the side HUD columns. Keep
		   action cards sized to this container instead of subtracting viewport guesses. */
		width: 100%;
		max-width: min(1100px, 100%);
		margin: 0 auto;
	}
	.card-grid > :global(.stage-card) {
		flex: 1 1 0;
		min-width: 0;
		width: auto;
		max-width: var(--stage-card-max, 16rem);
	}
	.location-action-view {
		box-sizing: border-box;
		width: 100%;
		height: 100%;
		min-height: 0;
		max-height: 100%;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		justify-content: center;
		overflow: hidden;
	}
	.location-action-body {
		width: 100%;
		height: 100%;
		min-height: 0;
		max-height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--stage-card-gap, 0.85rem);
		overflow: hidden;
	}
	.location-action-body :global(.int-scroll) {
		flex: 1 1 auto;
		align-self: stretch;
	}
	.combat-action-lane {
		width: min(42rem, 100%);
		height: 100%;
		max-height: 100%;
		min-height: 0;
		display: grid;
		grid-template-columns: minmax(0, 0.82fr) minmax(0, 1fr);
		align-items: center;
		justify-content: center;
		gap: var(--stage-card-gap, 0.85rem);
		margin: 0 auto;
		overflow: hidden;
	}
	.combat-action-lane .card-grid {
		width: 100%;
		max-width: 100%;
		min-width: 0;
	}
	.combat-action-lane .card-grid > :global(.stage-card) {
		width: 100%;
		max-width: 100%;
	}
	.combat-action-lane :global(.int-scroll) {
		width: 100%;
		height: 100%;
		flex: 0 1 auto;
		align-self: stretch;
		align-items: center;
		padding: 0;
	}
	.combat-action-lane :global(.int-grid) {
		width: 100%;
		max-width: 100%;
		align-items: stretch;
	}
	.combat-action-lane :global(.int-card) {
		max-width: 100%;
	}
	.waiting {
		font-family: var(--font-display);
		font-size: clamp(1.4rem, 2.4vw, 2rem);
		letter-spacing: 0.06em;
		color: var(--brand-cyan, #5cdfff);
		text-align: center;
	}
	.summon-stage {
		width: 100%;
		height: 100%;
		min-height: 0;
		max-height: 100%;
	}
	.infil-open {
		font: inherit;
		font-family: var(--font-display);
		font-size: 0.85rem;
		letter-spacing: 0.04em;
		padding: 0.6rem 1.1rem;
		margin-bottom: 0.8rem;
		border-radius: 10px;
		border: 1px solid color-mix(in srgb, var(--brand-violet, #5a2bff) 60%, transparent);
		background: color-mix(in srgb, var(--brand-violet, #5a2bff) 18%, rgba(15, 10, 28, 0.5));
		color: #fff;
		cursor: pointer;
		transition:
			transform 140ms ease,
			box-shadow 140ms ease;
	}
	.infil-open:not(:disabled):hover {
		transform: translateY(-2px);
		box-shadow: 0 6px 18px color-mix(in srgb, var(--brand-violet, #5a2bff) 35%, transparent);
	}
	.infil-open:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.combat-stage {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.9rem;
		width: min(560px, 100%);
	}
	.continue {
		padding: 10px 22px;
		font-family: var(--font-display);
		font-size: 0.82rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		border: none;
		border-radius: 3px;
		background: var(--brand-magenta, #ff2bc7);
		color: #fff;
		cursor: pointer;
		transition: background 140ms ease;
	}
	.continue:hover {
		background: var(--brand-magenta-soft, #ff7fd9);
	}

	@media (orientation: landscape) and (max-height: 520px) and (pointer: coarse) {
		.view {
			gap: 0;
		}
		.view-body {
			gap: var(--stage-view-gap, 0.55rem);
		}
		.main-instruction {
			font-size: var(--stage-title-size, 1.15rem);
			line-height: 1;
		}
		.location-action-body {
			gap: 0.45rem;
		}
		.combat-action-lane {
			width: min(31rem, 100%);
			grid-template-columns: minmax(0, 0.82fr) minmax(0, 1fr);
			gap: var(--stage-card-gap, 0.5rem);
		}
		.card-grid {
			gap: var(--stage-card-gap, 0.55rem);
			max-width: 100%;
		}
		.card-grid > :global(.stage-card) {
			max-width: var(--stage-card-max, 11.5rem);
		}
		.waiting {
			font-size: 1rem;
		}
		/* Augment placement must keep the hex board alive at ~390px height: compress
		   the icon row + prompts so the board owns the remaining space. */
		.aug-list {
			gap: 0.35rem;
		}
		.aug-icon {
			width: 2.3rem;
			height: 2.3rem;
		}
		.board-decision {
			gap: 0.3rem;
		}
		.board-decision .scene-prompt {
			font-size: 0.82rem;
			line-height: 1.2;
		}
		.board-decision .scene-hint {
			font-size: 0.68rem;
		}
		.scene-hex-wrap {
			min-height: 7.5rem;
		}
		/* Rune overflow: smaller tokens + tighter panel so grid AND commit bar fit. */
		.scene-panel.overflow {
			gap: 0.4rem;
		}
		.rune-grid {
			gap: 0.4rem;
		}
		.rune-pick {
			width: 2.7rem;
			height: 2.7rem;
			padding: 0.2rem;
		}
		.overflow-note {
			font-size: 0.8rem;
		}
		.infil-open {
			margin-bottom: 0.35rem;
			padding: 0.45rem 0.8rem;
			font-size: 0.72rem;
			border-radius: 8px;
		}
		.combat-stage {
			gap: 0.55rem;
			width: min(460px, 100%);
		}
		.continue {
			padding: 8px 18px;
			font-size: 0.72rem;
		}
		}
		@media (orientation: landscape) and (max-height: 520px) {
			.scene-flow {
				gap: 0.45rem;
			}
		.offer-grid {
			gap: 0.75rem;
			padding: 0.45rem 0.5rem;
		}
		.offer {
			max-width: 10.5rem;
		}
	}
</style>

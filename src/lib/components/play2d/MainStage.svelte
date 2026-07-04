<script lang="ts">
	import type {
		AwakenDiscardOption,
		AwakenDiscardRef,
		AwakenGrant,
		SpectatorProjection,
		SeatColor,
		NavigationDestination,
		PlayerProjection,
		DiceTier
	} from '$lib/play/types';
	import { RUNE_CARRY_LIMIT, isEvilAlignment } from '$lib/play/types';
	import {
		SPIRIT_AUGMENT_CLASSES,
		augmentCapacityForSpirit,
		isSpiritAugmentClass
	} from '$lib/play/augments';
	import { getLocationConfig, LOCATION_ACCENT, splatFor } from '$lib/play/locations';
	import { relicOptions } from '$lib/play/locationInteractions';
	import { buildMonsterRewards, type MonsterRewardOption } from '$lib/play/monsterRewards';
	import type { getAssetState } from '$lib/stores/assetStore.svelte';
	import { augmentIconForClass, runeIconUrl, seatAccent, spiritBackImageUrl, storageUrl } from './helpers';
	import HexGrid from '$lib/components/HexGrid.svelte';
	import SpiritWorldBoard from './SpiritWorldBoard.svelte';
	import type { NavigationSceneControls } from './navigationSceneControls';
	import ConfirmDestinationCircle from './ConfirmDestinationCircle.svelte';
	import DrawTray from './DrawTray.svelte';
	import CombatOverlay from './CombatOverlay.svelte';
	import LocationInteractionMenu from './LocationInteractionMenu.svelte';
	import ActionResult from './ActionResult.svelte';
	import StageCard from './StageCard.svelte';

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
		/** Discard a held rune/relic during Cleanup to get under the carry limit. */
		onDiscardRune: (slotIndex: number) => void;
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
		/** Discard a spirit by slot index (forced corruption discard). */
		onDiscardSpirit: (slotIndex: number) => void;
		busy?: boolean;
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
		onDiscardRune,
		onInfiltratorSwap,
		onAttackGroup,
		onPass,
		onClaimAwakenReward,
		onResolveDecision,
		onDismissManual,
		onPlaceAugment,
		onDiscardAugments,
		onDiscardSpirit,
		busy = false
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
	let taintedPotential = $state(0);
	let relicPicks = $state<number[]>([]);
	let hadAwakenReward = false;
	$effect(() => {
		const has = !!awakenReward;
		if (has && !hadAwakenReward) {
			taintedPotential = 0;
			relicPicks = Array.from({ length: relicGrant?.amount ?? 0 }, () => 0);
		}
		hadAwakenReward = has;
	});
	const taintedMax = $derived(taintedGrant?.amount ?? 0);
	const taintedPotentialClamped = $derived(Math.max(0, Math.min(taintedPotential, taintedMax)));
	const taintedEnchanted = $derived(taintedMax - taintedPotentialClamped);
	function pickRelic(unit: number, choice: number) {
		relicPicks = relicPicks.map((v, i) => (i === unit ? choice : v));
	}

	const awakeningChoices = $derived(myPlayer?.pendingDecisions ?? []);
	const awakenOffers = $derived(myPlayer?.awakenOffers ?? []);
	const manualPrompts = $derived(myPlayer?.manualPrompts ?? []);
	let pickingSlot = $state<number | null>(null);
	let pickedIdx = $state<number[]>([]);
	const pickingOffer = $derived(
		pickingSlot === null ? null : (awakenOffers.find((o) => o.slotIndex === pickingSlot) ?? null)
	);
	$effect(() => {
		if (pickingSlot !== null && !pickingOffer) {
			pickingSlot = null;
			pickedIdx = [];
		}
	});
	function optionIcon(option: AwakenDiscardOption): string | null {
		if (option.ref.kind === 'spirit') {
			const slotIndex = option.ref.slotIndex;
			const id = myPlayer?.spirits.find((s) => s.slotIndex === slotIndex)?.id;
			return id ? spiritBackImageUrl(id) : null;
		}
		if (option.ref.kind === 'rune') {
			const slotIndex = option.ref.slotIndex;
			return runeIconUrl(assets, {
				slotIndex,
				hasRune: true,
				id: option.runeId,
				name: option.label,
				type: /relic/i.test(option.label) ? 'relic' : 'rune'
			});
		}
		return null;
	}
	function clickOffer(offer: PlayerProjection['awakenOffers'][number]) {
		if (offer.discardCount > 0 && offer.options.length >= offer.discardCount) {
			pickingSlot = offer.slotIndex;
			pickedIdx = [];
			return;
		}
		onAwaken(offer.slotIndex);
	}
	function togglePick(offer: PlayerProjection['awakenOffers'][number], index: number) {
		if (pickedIdx.includes(index)) pickedIdx = pickedIdx.filter((i) => i !== index);
		else if (pickedIdx.length < offer.discardCount) pickedIdx = [...pickedIdx, index];
	}
	function confirmPick(offer: PlayerProjection['awakenOffers'][number]) {
		if (pickedIdx.length !== offer.discardCount) return;
		onAwaken(
			offer.slotIndex,
			pickedIdx.map((i) => offer.options[i].ref)
		);
		pickingSlot = null;
		pickedIdx = [];
	}
	function cancelPick() {
		pickingSlot = null;
		pickedIdx = [];
	}

	// Arc Mage convert: the owner clicks exactly 4 attack dice to spend, then confirms
	// → gain 1 Arcane. A picker embedded in the decision card so an Arcane is never
	// spent by accident. Done once per cultivate.
	const ARC_MAGE_CONVERT_COST = 4;
	let arcMagePick = $state<string[]>([]);
	function isArcMageDecision(kind: string): boolean {
		return kind === 'arcMageTrade';
	}
	function toggleArcMageDie(instanceId: string) {
		if (arcMagePick.includes(instanceId))
			arcMagePick = arcMagePick.filter((id) => id !== instanceId);
		else if (arcMagePick.length < ARC_MAGE_CONVERT_COST) arcMagePick = [...arcMagePick, instanceId];
	}
	function confirmArcMage(decisionId: string) {
		if (arcMagePick.length !== ARC_MAGE_CONVERT_COST) return;
		onResolveDecision(decisionId, 'yes', arcMagePick);
		arcMagePick = [];
	}
	function declineArcMage(decisionId: string) {
		onResolveDecision(decisionId, 'no');
		arcMagePick = [];
	}
	// Drop stale selections if the decision clears or dice change out from under it.
	$effect(() => {
		const owned = new Set((myPlayer?.attackDice ?? []).map((d) => d.instanceId));
		if (arcMagePick.some((id) => !owned.has(id)))
			arcMagePick = arcMagePick.filter((id) => owned.has(id));
	});
	const heldRunes = $derived((myPlayer?.mats ?? []).filter((r) => r.hasRune));
	const runeOverLimit = $derived(heldRunes.length > RUNE_CARRY_LIMIT);

	// At the Abyss, monster combat is once per round (plus any extra-action credits).
	// Once it's spent, the "Fight the Monster" card becomes a passive prompt.
	// Monster-combat allowance is 1 + extra credits (Ironmane grants +1 ⇒ two fights),
	// so we render ONE fight card per allowed fight; each is spent left-to-right as
	// `combatUsedCount` rises.
	const combatUsedCount = $derived(
		(myPlayer?.actionsUsedThisRound ?? []).filter((a) => a === 'combat').length
	);
	const combatAllowance = $derived(1 + (myPlayer?.extraActions?.combat ?? 0));
	const monsterRewardOptions = $derived(buildMonsterRewards(pendingReward?.rewardTrack));
	const monsterRewardMax = $derived(pendingReward?.chooseAmount ?? 0);
	let monsterRewardSelected = $state<number[]>([]);
	let monsterRuneChoice = $state<Record<number, number>>({});
	const monsterRewardAtMax = $derived(monsterRewardSelected.length >= monsterRewardMax);
	function monsterRewardIconUrl(id: string): string | null {
		return storageUrl(assets.iconPool.get(id)?.file_path ?? null);
	}
	function isMonsterRewardSelected(opt: MonsterRewardOption): boolean {
		return monsterRewardSelected.includes(opt.index);
	}
	function toggleMonsterReward(opt: MonsterRewardOption) {
		if (busy) return;
		if (isMonsterRewardSelected(opt)) {
			monsterRewardSelected = monsterRewardSelected.filter((i) => i !== opt.index);
		} else if (!monsterRewardAtMax) {
			monsterRewardSelected = [...monsterRewardSelected, opt.index];
		}
	}
	function chooseMonsterRune(opt: MonsterRewardOption, optionIndex: number) {
		if (busy) return;
		monsterRuneChoice = { ...monsterRuneChoice, [opt.index]: optionIndex };
		if (!isMonsterRewardSelected(opt) && !monsterRewardAtMax) {
			monsterRewardSelected = [...monsterRewardSelected, opt.index];
		}
	}
	function selectedMonsterRune(opt: MonsterRewardOption): number {
		return monsterRuneChoice[opt.index] ?? 0;
	}
	function claimMonsterRewards() {
		if (busy || monsterRewardSelected.length === 0) return;
		const byIndex = new Map(monsterRewardOptions.map((o) => [o.index, o]));
		const choices: number[] = [];
		for (const idx of monsterRewardSelected) {
			const opt = byIndex.get(idx);
			if (opt?.effect.type === 'chooseRune') choices.push(monsterRuneChoice[idx] ?? 0);
		}
		onClaimReward([...monsterRewardSelected], choices);
	}
	$effect(() => {
		if (!pendingReward) {
			monsterRewardSelected = [];
			monsterRuneChoice = {};
			return;
		}
		const valid = new Set(monsterRewardOptions.map((o) => o.index));
		if (monsterRewardSelected.some((idx) => !valid.has(idx))) {
			monsterRewardSelected = monsterRewardSelected.filter((idx) => valid.has(idx));
		}
	});

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
	const designatedAugmentClass = $derived.by(() => {
		const id = currentAugment?.classId;
		if (!id) return null;
		const name = assets.classTraits.get(id)?.name;
		return name && isSpiritAugmentClass(name) ? name : null;
	});
	const augmentChoices = $derived(
		(designatedAugmentClass ? [designatedAugmentClass] : [...SPIRIT_AUGMENT_CLASSES]).map(
			(className) => ({
				className,
				icon: augmentIconForClass(assets, className)
			})
		)
	);
	let pickedAugmentClass = $state<string | null>(null);
	const armedAugmentClass = $derived(designatedAugmentClass ?? pickedAugmentClass);

	function placedAugmentsOn(slotIndex: number): number {
		return (myPlayer?.spiritAugmentAttachments ?? []).filter(
			(a) => a.spiritSlotIndex === slotIndex && typeof a.className === 'string'
		).length;
	}
	function isAugmentEligible(slotIndex: number): boolean {
		if (!currentAugment) return false;
		if (currentAugment.boundSlotIndex != null) return slotIndex === currentAugment.boundSlotIndex;
		const spirit = (myPlayer?.spirits ?? []).find((s) => s.slotIndex === slotIndex);
		if (!spirit) return false;
		if (currentAugment.hostClass != null && (spirit.classes?.[currentAugment.hostClass] ?? 0) <= 0) return false;
		const cap = Math.max(augmentCapacityForSpirit(spirit), currentAugment.hostCapacity ?? 0);
		return placedAugmentsOn(slotIndex) < cap;
	}
	const augmentEligibleSlots = $derived(
		(myPlayer?.spirits ?? []).map((s) => s.slotIndex).filter((slot) => isAugmentEligible(slot))
	);
	const noAugmentTarget = $derived(pendingAugments.length > 0 && augmentEligibleSlots.length === 0);
	function dropAugmentOn(slotIndex: number) {
		if (busy || !currentAugment || !armedAugmentClass || !isAugmentEligible(slotIndex)) return;
		onPlaceAugment(0, currentAugment.runeId, slotIndex, armedAugmentClass);
		pickedAugmentClass = null;
	}
	function discardCorruptedSpirit(slotIndex: number) {
		if (!busy) onDiscardSpirit(slotIndex);
	}

	// ── Infiltrator: Location-phase dice swap in the main scene ────────────────
	// Eligible when the local player has an awakened Infiltrator, hasn't swapped
	// this round, holds ≥1 attack die, and shares a location with players who have
	// dice to swap. Targets carry each co-located player's (public) attack pool.
	const TIER_LABEL: Record<DiceTier, string> = {
		basic: 'Basic',
		enchanted: 'Enchanted',
		exalted: 'Exalted',
		arcane: 'Arcane'
	};
	const TIER_COLOR: Record<DiceTier, string> = {
		basic: '#8d8aa1',
		enchanted: '#4d8bf0',
		exalted: '#b06bff',
		arcane: '#ff2bc7'
	};
	let infiltratorPick = $state<Record<string, { mine?: string; theirs?: string }>>({});
	const infiltratorTargets = $derived.by(() => {
		const dest = myPlayer?.navigationDestination;
		if (!dest || dest === 'Arcane Abyss') return [];
		return room.activeSeats
			.filter((s) => s !== mySeat && room.players[s]?.navigationDestination === dest)
			.map((s) => ({
				seat: s,
				name: room.players[s]?.playerColor ?? s,
				accent: seatAccent(s),
				dice: room.players[s]?.attackDice ?? []
			}))
			.filter((t) => t.dice.length > 0);
	});
	const canInfiltrate = $derived(
		(myPlayer?.spirits ?? []).some((s) => !s.isFaceDown && (s.classes?.Infiltrator ?? 0) > 0) &&
			!(myPlayer?.actionsUsedThisRound ?? []).includes('infiltratorSwap') &&
			(myPlayer?.attackDice.length ?? 0) > 0 &&
			infiltratorTargets.length > 0
	);
	let showInfiltrator = $state(false);
	$effect(() => {
		// Auto-close the swap screen if eligibility lapses (swap done / left location).
		if (showInfiltrator && !canInfiltrate) showInfiltrator = false;
	});
	function mineDieUsedElsewhere(seat: SeatColor, instanceId: string): boolean {
		return Object.entries(infiltratorPick).some(([s, p]) => s !== seat && p.mine === instanceId);
	}
	function setInfiltratorMine(seat: SeatColor, instanceId: string) {
		const cur = infiltratorPick[seat] ?? {};
		infiltratorPick = {
			...infiltratorPick,
			[seat]: { ...cur, mine: cur.mine === instanceId ? undefined : instanceId }
		};
	}
	function setInfiltratorTheirs(seat: SeatColor, instanceId: string) {
		const cur = infiltratorPick[seat] ?? {};
		infiltratorPick = {
			...infiltratorPick,
			[seat]: { ...cur, theirs: cur.theirs === instanceId ? undefined : instanceId }
		};
	}
	const infiltratorSwaps = $derived(
		infiltratorTargets
			.map((t) => ({
				targetSeat: t.seat,
				myInstanceId: infiltratorPick[t.seat]?.mine,
				theirInstanceId: infiltratorPick[t.seat]?.theirs
			}))
			.filter((s): s is { targetSeat: SeatColor; myInstanceId: string; theirInstanceId: string } =>
				Boolean(s.myInstanceId && s.theirInstanceId)
			)
	);
	function confirmInfiltratorSwap() {
		if (infiltratorSwaps.length === 0) return;
		onInfiltratorSwap(infiltratorSwaps);
		infiltratorPick = {};
		showInfiltrator = false;
	}
	function cancelInfiltratorSwap() {
		infiltratorPick = {};
		showInfiltrator = false;
	}

	// Spectators always see the read-only destination board.
	const showNavBoard = $derived(room.phase === 'navigation' || !mySeat);

	const myDestination = $derived(myPlayer?.navigationDestination ?? null);
	const amEvil = $derived(myPlayer ? isEvilAlignment(myPlayer.statusLevel) : false);
	const encounterTargets = $derived.by(() => {
		if (!amEvil || !myDestination || myDestination === 'Arcane Abyss') return [] as SeatColor[];
		return room.activeSeats.filter(
			(s) =>
				s !== mySeat &&
				room.players[s]?.navigationDestination === myDestination &&
				!isEvilAlignment(room.players[s]?.statusLevel ?? 0)
		);
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
			if (myReady) return 'Waiting for Players.';
			if (encounterTargets.length > 0) return 'Choose Encounter Action.';
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
				<!-- Forced corruption discard — a sacrifice owed the moment you corrupt; surfaced
		     in-stage in whatever phase it's pending (combat sets it in location/encounter). -->
				<div class="scene-flow board-decision corruption-decision" data-testid="corruption-discard">
					<p class="scene-prompt danger">
						You were corrupted — tap {myPlayer?.pendingCorruptionDiscard?.count ?? 0}
						spirit{(myPlayer?.pendingCorruptionDiscard?.count ?? 0) === 1 ? '' : 's'} to send
						back to the bag.
					</p>
					<div class="scene-hex-wrap" data-testid="corruption-discard-hexes">
						<HexGrid
							spirits={myPlayer?.spirits ?? []}
							spiritAssets={spiritImages}
							backImageBySlot={faceDownBackImageBySlot}
							augmentsBySlot={spiritAugmentsBySlot}
							discardMode={!busy}
							onDiscard={discardCorruptedSpirit}
						/>
					</div>
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
									disabled={busy || designatedAugmentClass != null}
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
								onDropAugment={dropAugmentOn}
							/>
						</div>
						<div class="scene-actions">
							{#if noAugmentTarget}
								<span class="scene-note" data-testid="augment-no-target">
									No spirit can hold {pendingAugments.length === 1 ? 'this augment' : 'these augments'}.
								</span>
							{/if}
							<button
								type="button"
								class="primary-btn"
								class:urgent={noAugmentTarget}
								disabled={busy}
								data-testid="augment-done"
								onclick={() => onDiscardAugments()}
								>{noAugmentTarget
									? `Discard ${pendingAugments.length} & continue`
									: 'Done'}</button
							>
						</div>
					</div>
				{:else if needsAbilityDecision}
					<div class="scene-flow decision-flow" data-testid="decision-cards">
						{#each awakeningChoices as choice (choice.id)}
							<section class="scene-panel decision-panel" data-testid={`decision-${choice.id}`}>
								<p class="scene-prompt">{choice.prompt}</p>
								{#if isArcMageDecision(choice.kind)}
									<div class="arc-convert" data-testid={`arc-convert-${choice.id}`}>
										<div class="infil-dice" class:hasPick={arcMagePick.length > 0}>
											{#if (myPlayer?.attackDice.length ?? 0) === 0}
												<span class="scene-note">No attack dice</span>
											{/if}
											{#each myPlayer?.attackDice ?? [] as die (die.instanceId)}
												<button
													type="button"
													class="die-token"
													class:selected={arcMagePick.includes(die.instanceId)}
													style="--tier: {TIER_COLOR[die.tier]}"
													disabled={busy}
													data-testid={`arc-die-${die.instanceId}`}
													onclick={() => toggleArcMageDie(die.instanceId)}
												>
													{TIER_LABEL[die.tier]}
												</button>
											{/each}
										</div>
										<div class="choice-opts" role="group" aria-label="Convert dice">
											<button
												type="button"
												class="opt-btn"
												data-testid={`decision-${choice.id}-yes`}
												disabled={busy || arcMagePick.length !== ARC_MAGE_CONVERT_COST}
												onclick={() => confirmArcMage(choice.id)}
												>Convert ({arcMagePick.length}/{ARC_MAGE_CONVERT_COST}) → 1 Arcane</button
											>
											<button
												type="button"
												class="opt-btn decline"
												data-testid={`decision-${choice.id}-no`}
												disabled={busy}
												onclick={() => declineArcMage(choice.id)}>No</button
											>
										</div>
									</div>
								{:else}
									<div class="choice-opts" role="group" aria-label="Choose an option">
										{#each choice.options as option (option.id)}
											<button
												type="button"
												class="opt-btn"
												class:decline={option.id === 'no'}
												data-testid={`decision-${choice.id}-${option.id}`}
												disabled={busy}
												onclick={() => onResolveDecision(choice.id, option.id)}
												>{option.label}</button
											>
										{/each}
									</div>
								{/if}
							</section>
						{/each}
					</div>
			{:else if room.phase === 'encounter'}
				{#if myReady}
					<div class="waiting" data-testid="stage-waiting">Waiting for other players…</div>
				{:else if encounterTargets.length > 0}
					<div class="enc-sub">
						Attack the Good players here for +2 VP. Every Evil player at this location must agree.
					</div>
					<div class="encounter-targets" data-testid="encounter-targets">
						{#each encounterTargets as target (target)}
							<span class="enc-target" style={`--c:${seatAccent(target)}`}>{target}</span>
						{/each}
					</div>
					<div class="encounter-actions">
						<button
							type="button"
							class="enc-btn attack"
							data-testid="encounter-attack"
							disabled={busy}
							onclick={() => onAttackGroup()}>⚔ Attack together</button
						>
						<button
							type="button"
							class="enc-btn hold"
							data-testid="encounter-hold"
							disabled={busy}
							onclick={() => onPass()}>Hold</button
						>
					</div>
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
					<div
						class="scene-flow reward-scene"
						style="--accent: {myAccent}"
						data-testid="monster-reward-menu"
					>
						<p class="scene-prompt">{pendingReward.monsterName} defeated</p>
						<p class="scene-hint" data-testid="reward-pick-count">
							Claim {monsterRewardMax} reward{monsterRewardMax === 1 ? '' : 's'} — selected
							{monsterRewardSelected.length}/{monsterRewardMax}
						</p>
						<div class="reward-grid" data-testid="reward-grid">
							{#each monsterRewardOptions as opt (opt.index)}
								{@const chosen = isMonsterRewardSelected(opt)}
								{@const isChoice = opt.effect.type === 'chooseRune'}
								{@const full = monsterRewardAtMax && !chosen}
								<div
									class="reward-card"
									class:selected={chosen}
									class:disabled={busy || full}
									role="button"
									tabindex={busy || full ? -1 : 0}
									data-testid={`reward-${opt.index}`}
									aria-pressed={chosen}
									onclick={() => toggleMonsterReward(opt)}
									onkeydown={(e) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											toggleMonsterReward(opt);
										}
									}}
								>
									<span class="reward-check" aria-hidden="true">✓</span>
									<span class="reward-icon">
										{#if monsterRewardIconUrl(opt.token)}
											<img src={monsterRewardIconUrl(opt.token)} alt="" loading="lazy" />
										{/if}
									</span>
									<span class="reward-label">{opt.label}</span>
									{#if isChoice && opt.effect.type === 'chooseRune'}
										<div class="rune-chooser" role="group" aria-label="Choose a rune">
											{#each opt.effect.options as runeOpt, oi (runeOpt.runeId + oi)}
												<button
													type="button"
													class="rune-choice"
													class:active={selectedMonsterRune(opt) === oi}
													disabled={busy || full}
													onclick={(e) => {
														e.stopPropagation();
														chooseMonsterRune(opt, oi);
													}}
												>
													{runeOpt.name}
												</button>
											{/each}
										</div>
									{/if}
								</div>
							{/each}
						</div>
						<button
							type="button"
							class="primary-btn"
							data-testid="reward-claim"
							disabled={busy || monsterRewardSelected.length === 0}
							onclick={claimMonsterRewards}
						>
							{monsterRewardSelected.length === 0
								? 'Select a reward'
								: `Claim ${monsterRewardSelected.length} reward${monsterRewardSelected.length === 1 ? '' : 's'}`}
						</button>
					</div>
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
										onResolve={onResolveInteraction}
									/>
								</div>
							{:else if showInfiltrator}
								<div class="scene-flow infiltrator-flow" data-testid="infiltrator-swap">
									<p class="scene-prompt">
										Choose one of their attack dice to take, and one of yours to give back.
									</p>
									<div class="infil-targets">
										{#each infiltratorTargets as t (t.seat)}
											<section class="infil-target" style="--seat: {t.accent}">
												<div class="infil-name">{t.name}</div>
												<div class="infil-line">
													<span class="infil-label">Take</span>
													<div class="infil-dice" class:hasPick={!!infiltratorPick[t.seat]?.theirs}>
														{#each t.dice as die (die.instanceId)}
															<button
																type="button"
																class="die-token"
																class:selected={infiltratorPick[t.seat]?.theirs === die.instanceId}
																style="--tier: {TIER_COLOR[die.tier]}"
																disabled={busy}
																data-testid={`infil-theirs-${t.seat}-${die.instanceId}`}
																onclick={() => setInfiltratorTheirs(t.seat, die.instanceId)}
															>
																{TIER_LABEL[die.tier]}
															</button>
														{/each}
													</div>
												</div>
												<div class="infil-line">
													<span class="infil-label">Give</span>
													<div class="infil-dice" class:hasPick={!!infiltratorPick[t.seat]?.mine}>
														{#if (myPlayer?.attackDice.length ?? 0) === 0}
															<span class="scene-note">No attack dice</span>
														{/if}
														{#each (myPlayer?.attackDice ?? []) as die (die.instanceId)}
															<button
																type="button"
																class="die-token"
																class:selected={infiltratorPick[t.seat]?.mine === die.instanceId}
																style="--tier: {TIER_COLOR[die.tier]}"
																disabled={busy || mineDieUsedElsewhere(t.seat, die.instanceId)}
																data-testid={`infil-mine-${t.seat}-${die.instanceId}`}
																onclick={() => setInfiltratorMine(t.seat, die.instanceId)}
															>
																{TIER_LABEL[die.tier]}
															</button>
														{/each}
													</div>
												</div>
											</section>
										{/each}
									</div>
									<div class="scene-actions">
										<button
											type="button"
											class="primary-btn"
											disabled={busy || infiltratorSwaps.length === 0}
											data-testid="infil-confirm"
											onclick={confirmInfiltratorSwap}
										>
											Swap {infiltratorSwaps.length} die{infiltratorSwaps.length === 1 ? '' : 's'}
										</button>
										<button type="button" class="ghost-btn" disabled={busy} onclick={cancelInfiltratorSwap}
											>Cancel</button
										>
									</div>
								</div>
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
									onResolve={onResolveInteraction}
								/>
							{/if}
						</div>
					</div>
				{/if}
				{:else if room.phase === 'benefits'}
					{#if awakenReward}
						<section class="scene-panel claim" data-testid="awaken-claim">
							{#each fixedGrants as g (g.source + g.kind)}
								<div class="claim-line">
								<span class="claim-label">{g.source}</span>
								<span class="claim-fixed">{grantLabel(g)}</span>
								{#if g.kind === 'vp' && g.note}<span class="claim-note">{g.note}</span>{/if}
							</div>
						{/each}
						{#if taintedGrant}
							<div class="claim-line">
								<span class="claim-label">Cursed Spirit · Tainted — split {taintedMax}:</span>
								<div class="claim-split">
									<button
										type="button"
										class="step"
										data-testid="claim-potential-minus"
										disabled={busy || taintedPotentialClamped <= 0}
										aria-label="Fewer potential"
										onclick={() => (taintedPotential = Math.max(0, taintedPotentialClamped - 1))}
										>−</button
									>
									<span class="claim-choice"
										><strong data-testid="claim-potential">{taintedPotentialClamped}</strong> Potential</span
									>
									<button
										type="button"
										class="step"
										data-testid="claim-potential-plus"
										disabled={busy || taintedPotentialClamped >= taintedMax}
										aria-label="More potential"
										onclick={() =>
											(taintedPotential = Math.min(taintedMax, taintedPotentialClamped + 1))}
										>+</button
									>
									<span class="claim-sep" aria-hidden="true">·</span>
									<span class="claim-choice"
										><strong data-testid="claim-enchanted">{taintedEnchanted}</strong> Enchanted Attack</span
									>
								</div>
							</div>
						{/if}
						{#if relicGrant}
							<div class="claim-line">
								<span class="claim-label"
									>Cursed Spirit · Corrupt — choose {relicGrant.amount} relic{relicGrant.amount ===
									1
										? ''
										: 's'}:</span
								>
								<div class="relic-picks" data-testid="claim-relic-picks">
									{#each relicPicks as pick, unit (unit)}
										<div class="relic-pick">
											{#each relicChoices as rc, ri (ri)}
												<button
													type="button"
													class="relic-opt"
													class:sel={pick === ri}
													disabled={busy}
													title={rc.name}
													aria-label={rc.name}
													aria-pressed={pick === ri}
													data-testid={`claim-relic-${unit}-${ri}`}
													onclick={() => pickRelic(unit, ri)}
												>
													{#if rc.icon}<img src={rc.icon} alt={rc.name} />{:else}<span
															class="relic-fb">{rc.name.slice(0, 1)}</span
														>{/if}
												</button>
											{/each}
										</div>
									{/each}
								</div>
							</div>
						{/if}
						<button
							type="button"
							class="primary-btn"
							data-testid="awaken-claim-btn"
							disabled={busy}
							onclick={() => onClaimAwakenReward(taintedPotentialClamped, relicPicks)}
							>Claim rewards</button
						>
					</section>
				{/if}
				{:else if room.phase === 'awakening'}
				{#if awakeningChoices.length > 0 || pickingOffer || awakenOffers.length > 0 || manualPrompts.length > 0}
					<div class="scene-flow" data-testid="awakening-actions">
						{#each awakeningChoices as choice (choice.id)}
							<section class="scene-panel choice" data-testid={`ability-choice-${choice.id}`}>
								<p class="scene-prompt">{choice.prompt}</p>
								<div class="choice-opts">
									{#each choice.options as option (option.id)}
										<button
											type="button"
											class="opt-btn"
											class:decline={option.id === 'no'}
											data-testid={`ability-choice-${choice.id}-${option.id}`}
											disabled={busy}
											onclick={() => onResolveDecision(choice.id, option.id)}>{option.label}</button
										>
									{/each}
								</div>
							</section>
						{/each}

						{#if pickingOffer}
							<section class="scene-panel awaken-pick">
								<p class="scene-prompt pick-req">
									{pickingOffer.requirement} — choose {pickingOffer.discardCount} to discard
								</p>
								<div class="pick-grid" data-testid="awaken-discard-pick">
									{#each pickingOffer.options as option, i (i)}
										{@const url = optionIcon(option)}
										<button
											type="button"
											class="pick-opt"
											class:selected={pickedIdx.includes(i)}
											disabled={busy}
											title={option.label}
											data-testid={`discard-option-${i}`}
											onclick={() => togglePick(pickingOffer, i)}
										>
											{#if url}<img src={url} alt={option.label} />{/if}
											<span class="pick-label">{option.label}</span>
										</button>
									{/each}
								</div>
								<div class="pick-actions">
									<button
										type="button"
										class="primary-btn"
										disabled={busy || pickedIdx.length !== pickingOffer.discardCount}
										data-testid="awaken-discard-confirm"
										onclick={() => confirmPick(pickingOffer)}
										>Discard &amp; awaken ({pickedIdx.length}/{pickingOffer.discardCount})</button
									>
									<button type="button" class="ghost-btn" disabled={busy} onclick={cancelPick}
										>Cancel</button
									>
								</div>
							</section>
						{:else if awakenOffers.length > 0}
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
									</button>
								{/each}
							</div>
						{/if}

							{#each manualPrompts as prompt (prompt.id)}
								<section class="scene-panel manual" data-testid={`ability-manual-${prompt.id}`}>
									<p class="scene-prompt">{prompt.text}</p>
									<button
									type="button"
									class="ghost-btn"
									disabled={busy}
									onclick={() => onDismissManual(prompt.id)}
								>
									Done
								</button>
							</section>
						{/each}
					</div>
				{/if}
				{:else if room.phase === 'cleanup'}
					{#if runeOverLimit}
						<section class="scene-panel overflow" data-testid="rune-discard">
							<p class="scene-prompt overflow-note">
								Only {RUNE_CARRY_LIMIT} runes carry over — discard {heldRunes.length -
									RUNE_CARRY_LIMIT} more.
						</p>
						<div class="rune-grid">
							{#each heldRunes as rune (rune.slotIndex)}
								{@const url = runeIconUrl(assets, rune)}
								<button
									type="button"
									class="rune-pick"
									disabled={busy}
									title={`Discard ${rune.name ?? 'rune'}`}
									data-testid={`discard-rune-${rune.slotIndex}`}
									onclick={() => onDiscardRune(rune.slotIndex)}
								>
									{#if url}<img src={url} alt={rune.name ?? 'Rune'} />{/if}
									<span class="x" aria-hidden="true">✕</span>
								</button>
							{/each}
						</div>
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
	.view-body :global([data-testid='confirmed-destination']),
	.view-body :global([data-testid='monster-reward-menu']),
	.view-body :global([data-testid='draw-tray']),
	.view-body :global([data-testid='action-result']),
	.view-body :global([data-testid='awaken-claim']),
	.view-body :global([data-testid='awakening-actions']),
	.view-body :global([data-testid='rune-discard']),
	.view-body :global([data-testid='infiltrator-swap']) {
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
		.scene-panel.claim {
			width: min(900px, 100%);
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
	.infiltrator-flow {
		width: min(820px, 100%);
	}
	.infil-targets {
		width: min(760px, 100%);
		display: flex;
		flex-direction: column;
		gap: clamp(0.45rem, 1.5vh, 0.75rem);
	}
	.infil-target {
		display: grid;
		grid-template-columns: minmax(5rem, 0.45fr) minmax(0, 1fr);
		gap: 0.45rem 0.8rem;
		align-items: center;
		width: 100%;
		padding-block: 0.45rem;
		border-top: 1px solid color-mix(in srgb, var(--seat) 45%, transparent);
	}
	.infil-target:last-child {
		border-bottom: 1px solid color-mix(in srgb, var(--seat) 28%, transparent);
	}
	.infil-name {
		grid-row: span 2;
		font-family: var(--font-display);
		font-size: clamp(0.82rem, 1.4vw, 1rem);
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--seat);
		text-align: right;
	}
	.infil-line {
		min-width: 0;
		display: grid;
		grid-template-columns: 3.4rem minmax(0, 1fr);
		align-items: center;
		gap: 0.55rem;
	}
	.infil-label {
		font-family: var(--font-display);
		font-size: 0.68rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.7);
		text-align: right;
	}
	.infil-dice {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.38rem;
	}
	.die-token {
		position: relative;
		min-height: 34px;
		padding: 0.34rem 0.68rem;
		border: 0;
		border-radius: 4px;
		background: color-mix(in srgb, var(--tier) 22%, rgba(8, 5, 16, 0.45));
		color: #fff;
		font: inherit;
		font-family: var(--font-display);
		font-size: 0.72rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		cursor: pointer;
		transition:
			transform 140ms ease,
			filter 140ms ease,
			opacity 140ms ease;
	}
	.die-token:not(:disabled):hover {
		transform: translateY(-2px);
		filter: drop-shadow(0 0 10px color-mix(in srgb, var(--tier) 54%, transparent));
	}
	.infil-dice.hasPick .die-token:not(.selected) {
		opacity: 0.32;
	}
	.die-token.selected {
		transform: translateY(-3px);
		filter: drop-shadow(0 0 14px color-mix(in srgb, var(--tier) 68%, transparent));
	}
	.die-token.selected::after {
		content: '✓';
		position: absolute;
		top: -0.45rem;
		left: 50%;
		width: 1.1rem;
		height: 1.1rem;
		border-radius: 50%;
		display: grid;
		place-items: center;
		transform: translateX(-50%);
		background: var(--tier);
		color: #fff;
		font-size: 0.72rem;
		box-shadow: 0 0 0 2px rgba(8, 5, 16, 0.78);
	}
	.die-token:disabled {
		opacity: 0.32;
		cursor: not-allowed;
	}
	.reward-scene {
		width: min(1100px, 100%);
	}
	.reward-grid {
		display: flex;
		flex-wrap: nowrap;
		gap: clamp(0.7rem, 1.8vw, 1.1rem);
		justify-content: center;
		align-items: flex-start;
		width: 100%;
	}
	.reward-card {
		position: relative;
		display: flex;
		flex: 1 1 0;
		min-width: 0;
		max-width: 12rem;
		flex-direction: column;
		align-items: center;
		justify-content: flex-start;
		gap: 0.55rem;
		min-height: 8.5rem;
		padding: 0.8rem 0.35rem 0.35rem;
		text-align: center;
		border: 0;
		background: transparent;
		cursor: pointer;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
		contain: layout;
		transition:
			transform 140ms ease,
			filter 140ms ease,
			opacity 140ms ease;
	}
	@media (hover: hover) and (pointer: fine) {
		.reward-card:not(.disabled):hover {
			transform: translateY(-4px);
			filter: drop-shadow(0 0 16px color-mix(in srgb, var(--accent) 45%, transparent));
		}
	}
	.reward-card.selected {
		transform: translateY(-4px);
		filter: drop-shadow(0 0 18px color-mix(in srgb, var(--accent) 58%, transparent));
	}
	.reward-grid:has(.reward-card.selected) .reward-card:not(.selected) {
		opacity: 0.36;
	}
	.reward-card.disabled {
		cursor: not-allowed;
		opacity: 0.4;
	}
	.reward-card:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.reward-check {
		position: absolute;
		top: -0.35rem;
		left: 50%;
		width: 1.35rem;
		height: 1.35rem;
		border-radius: 50%;
		display: grid;
		place-items: center;
		transform: translateX(-50%);
		font-family: var(--font-display);
		font-size: 0.8rem;
		color: var(--color-void, #0c0518);
		background: var(--accent);
		opacity: 0;
		box-shadow:
			0 0 0 2px rgba(8, 5, 16, 0.78),
			0 0 14px color-mix(in srgb, var(--accent) 64%, transparent);
		transition: opacity 120ms ease;
	}
	.reward-card.selected .reward-check {
		opacity: 1;
	}
	.reward-icon {
		width: clamp(52px, 8vw, 72px);
		height: clamp(52px, 8vw, 72px);
		display: grid;
		place-items: center;
	}
	.reward-icon img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.48));
	}
	.reward-label {
		font-family: var(--font-display);
		font-size: 0.96rem;
		letter-spacing: 0.03em;
		color: #fff;
		line-height: 1.15;
		text-shadow: 0 2px 8px rgba(0, 0, 0, 0.65);
	}
	.rune-chooser {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		justify-content: center;
		margin-top: auto;
	}
	.rune-choice {
		min-height: 38px;
		padding: 4px 10px;
		border-radius: 4px;
		border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
		background: rgba(0, 0, 0, 0.3);
		color: var(--color-fog, #b9b4cc);
		font-family: var(--font-display);
		font-size: 0.72rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		cursor: pointer;
		transition:
			background 120ms ease,
			color 120ms ease,
			border-color 120ms ease;
	}
	.rune-choice.active {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--color-void, #0c0518);
	}
	.rune-choice:disabled {
		cursor: not-allowed;
		opacity: 0.45;
	}
		.claim-line {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			justify-content: center;
			gap: 0.5rem 0.75rem;
			padding-bottom: 0.5rem;
			border-bottom: 1px solid rgba(255, 255, 255, 0.12);
			width: 100%;
		}
	.claim-label {
		font-family: var(--font-display);
		font-size: 0.85rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--brand-cyan, #5cdfff);
	}
		.claim-split {
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 0.5rem;
			flex-wrap: wrap;
	}
	.step {
		width: 1.9rem;
		height: 1.9rem;
		display: grid;
		place-items: center;
		border-radius: 4px;
		border: 1px solid rgba(255, 255, 255, 0.28);
		background: rgba(10, 7, 20, 0.6);
		color: #fff;
		font-size: 1.1rem;
		line-height: 1;
		cursor: pointer;
	}
	.step:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.claim-choice {
		font-size: 0.9rem;
		color: var(--color-bone, #efeaf7);
	}
	.claim-choice strong {
		font-family: var(--font-display);
		font-size: 1.15rem;
		color: #fff;
	}
	.claim-sep {
		color: var(--color-fog, #8d8aa1);
	}
	.claim-fixed {
		font-size: 0.95rem;
		color: var(--color-bone, #efeaf7);
	}
	.claim-note {
		font-size: 0.82rem;
		font-style: italic;
		color: var(--color-fog, #9a93b0);
	}
		.relic-picks {
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 0.4rem;
		}
		.relic-pick {
			display: flex;
			justify-content: center;
			gap: 0.4rem;
			flex-wrap: wrap;
	}
	.relic-opt {
		width: 2.4rem;
		height: 2.4rem;
		display: grid;
		place-items: center;
		padding: 0;
		border-radius: 8px;
		border: 1px solid rgba(255, 255, 255, 0.16);
		background: rgba(10, 7, 20, 0.5);
		cursor: pointer;
		opacity: 0.55;
		transition:
			opacity 120ms ease,
			border-color 120ms ease,
			box-shadow 120ms ease;
	}
	.relic-opt:not(:disabled):hover {
		opacity: 0.85;
	}
	.relic-opt.sel {
		opacity: 1;
		border-color: var(--brand-amber-soft, #ffd56a);
		box-shadow:
			0 0 0 1px var(--brand-amber-soft, #ffd56a),
			0 0 10px rgba(255, 213, 106, 0.4);
	}
	.relic-opt:disabled {
		cursor: not-allowed;
	}
	.relic-opt img {
		width: 1.8rem;
		height: 1.8rem;
		object-fit: contain;
	}
	.relic-fb {
		font-family: var(--font-display);
		font-size: 1rem;
		color: var(--color-bone, #efeaf7);
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
		.choice-opts {
			display: flex;
			flex-wrap: wrap;
			justify-content: center;
			gap: 0.5rem;
		}
		.arc-convert {
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 0.7rem;
		}
		.arc-convert .infil-dice {
			justify-content: center;
		}
		.opt-btn {
			flex: 0 1 auto;
			min-height: 40px;
		padding: 0.5rem 0.95rem;
		font-family: var(--font-display);
		font-size: 0.78rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		border: 1px solid var(--brand-cyan, #24d4ff);
		border-radius: 6px;
		background: rgba(0, 0, 0, 0.3);
		color: var(--color-parchment, #d8cfee);
			cursor: pointer;
			transition:
				background 140ms ease,
				color 140ms ease,
				transform 140ms ease,
				opacity 140ms ease;
		}
		.opt-btn:not(:disabled):hover {
			background: color-mix(in srgb, var(--brand-cyan, #24d4ff) 25%, transparent);
			color: #fff;
			transform: translateY(-2px);
		}
	.opt-btn.decline {
		border-color: rgba(255, 255, 255, 0.25);
		color: var(--color-fog, #9a8fb8);
	}
	.opt-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
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
		.pick-req {
			color: var(--brand-violet-soft, #b6a8ff);
		}
		.pick-grid {
			display: flex;
			flex-wrap: wrap;
			justify-content: center;
			gap: clamp(0.65rem, 2vw, 1.2rem);
			width: 100%;
		}
		.pick-opt {
			position: relative;
			display: grid;
			grid-template-rows: 1fr auto;
			place-items: center;
			gap: 0.4rem;
			width: clamp(4.6rem, 12vw, 6rem);
			min-height: clamp(5.3rem, 14vw, 6.5rem);
			padding: 0.35rem;
			border: 0;
			background: transparent;
			color: inherit;
			font: inherit;
			cursor: pointer;
			opacity: 0.92;
			transition:
				transform 140ms ease,
				filter 140ms ease,
				opacity 140ms ease;
		}
		.pick-opt:not(:disabled):hover {
			transform: translateY(-3px);
			opacity: 1;
		}
		.pick-opt.selected {
			opacity: 1;
			filter: drop-shadow(0 0 16px color-mix(in srgb, var(--brand-cyan, #24d4ff) 62%, transparent));
			transform: translateY(-4px);
		}
		.pick-grid:has(.pick-opt.selected) .pick-opt:not(.selected) {
			opacity: 0.34;
		}
		.pick-opt.selected::after {
			content: '✓';
			position: absolute;
			top: -0.42rem;
			left: 50%;
			width: 1.35rem;
			height: 1.35rem;
			border-radius: 50%;
			display: grid;
			place-items: center;
			transform: translateX(-50%);
			background: var(--brand-cyan, #24d4ff);
			color: var(--color-void, #080510);
			font-family: var(--font-display);
			font-size: 0.9rem;
			box-shadow:
				0 0 0 2px rgba(8, 5, 16, 0.78),
				0 0 14px color-mix(in srgb, var(--brand-cyan, #24d4ff) 72%, transparent);
		}
	.pick-opt:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
		.pick-opt img {
			width: clamp(3.2rem, 9vw, 4.4rem);
			height: clamp(3.2rem, 9vw, 4.4rem);
			object-fit: contain;
			filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.5));
		}
		.pick-label {
			font-family: var(--font-display);
			font-size: clamp(0.68rem, 1.6vw, 0.82rem);
			line-height: 1.1;
			text-align: center;
			color: #fff;
			opacity: 0.92;
			text-shadow: 0 2px 8px rgba(0, 0, 0, 0.65);
		}
		.pick-actions {
			display: flex;
			justify-content: center;
			gap: 0.7rem;
			flex-wrap: wrap;
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

	/* ── Encounter (group PvP) decision ─────────────────────────────────────── */
	.enc-sub {
		font-size: clamp(0.95rem, 1.6vw, 1.15rem);
		color: var(--color-parchment, #d8d2e8);
		text-align: center;
		max-width: 34rem;
		line-height: 1.5;
	}
	.encounter-targets {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		justify-content: center;
	}
	.enc-target {
		font-family: var(--font-display);
		font-size: 1.1rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #fff;
		padding: 0.3rem 0.85rem;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--c) 60%, transparent);
		background: color-mix(in srgb, var(--c) 16%, rgba(10, 7, 24, 0.6));
	}
	.encounter-actions {
		display: flex;
		gap: 0.85rem;
		justify-content: center;
		flex-wrap: wrap;
	}
	.enc-btn {
		padding: 12px 26px;
		font-family: var(--font-display);
		font-size: 1rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		border-radius: 4px;
		border: 1px solid transparent;
		cursor: pointer;
		transition:
			background 140ms ease,
			border-color 140ms ease,
			color 140ms ease;
	}
	.enc-btn.attack {
		border: none;
		background: var(--color-blood, #e05858);
		color: #fff;
	}
	.enc-btn.attack:not(:disabled):hover {
		background: #ff7373;
	}
	.enc-btn.hold {
		background: rgba(10, 7, 24, 0.6);
		border-color: var(--color-mist, #3a2670);
		color: var(--color-fog, #b9b2cf);
	}
	.enc-btn.hold:not(:disabled):hover {
		border-color: var(--color-fog, #b9b2cf);
		color: #fff;
	}
	.enc-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
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
		.enc-sub {
			font-size: 0.82rem;
			line-height: 1.3;
			max-width: 24rem;
		}
		.encounter-actions {
			gap: 0.5rem;
		}
		.enc-btn {
			padding: 8px 18px;
			font-size: 0.82rem;
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

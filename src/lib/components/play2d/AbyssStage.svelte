<script lang="ts" module>
	export type AbyssView = 'home' | 'decks' | 'reveal';

	/** A location action of the Abyss itself (the free Arcane Abyss Summon), shown as a
	 *  ghost button on the home view. */
	export interface AbyssAction {
		key: string;
		label: string;
		icon: string | null;
		disabled?: boolean;
		testid?: string;
		/** Small text after the label ("uses your battle action"). */
		note?: string;
	}

	/** How a monster draw works in this game. */
	export interface AbyssDrawRules {
		/** Cards one draw reveals: 1 (keep it or put it back), or 2 (keep one). */
		reveals: 1 | 2;
		/** The revealed card may go back on top of its deck, a kept card may take the place of a
		 *  held one, and a full hand may still draw. */
		canReturn: boolean;
		/** The player who draws from the decks before this one, while this one has to wait. */
		waitsOn: string | null;
	}
	/** Battle actions: a fight uses one; the Arcane Abyss Summon action may use one too. */
	export interface AbyssBattleActions {
		left: number;
		total: number;
		/** The Arcane Abyss Summon action uses a battle action. */
		summonUsesOne: boolean;
		/** The player took the Arcane Abyss Summon action this round. */
		summonTaken: boolean;
	}
	export interface KeepOptions {
		/** Put the revealed card back on top of its deck. */
		returnToDeck?: boolean;
		/** Keep the revealed card and put this held card back on top of its deck. */
		replaceHandIndex?: number;
	}
</script>

<script lang="ts">
	/**
	 * The Arcane Abyss location, in the spirit-draw style: tarot cards floating on the
	 * scene, a subtitle, and one row of ghost buttons. MainStage renders the title.
	 *
	 *  home   — the three decks as a stack of card backs (tap to draw) beside the
	 *           player's hand of monster cards (tap one to fight it).
	 *  decks  — the three decks fan out; tap one to draw from it.
	 *  reveal — the chosen deck slides left, two cards fly out of it and flip face
	 *           up; tap one to keep it. The kept card flies into the hand, the other
	 *           flips back under the deck, and the view returns home.
	 *           When a draw reveals ONE card (`draw.reveals === 1`): keep it, put it
	 *           back on top of its deck, or keep it and put a held card back instead.
	 *
	 * What the player may do (cards a draw reveals, battle actions left, whose turn it
	 * is to draw) comes from the game's rules through the `draw` and `battle` props;
	 * without them the screen plays the rules before 2026-11-22.
	 *
	 * Continuity between views is one crossfade: a deck or card keeps its key from
	 * view to view, so it moves to its new place instead of popping.
	 */
	import { crossfade, fade, type TransitionConfig } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';
	import type { MonsterDeckSummary, MonsterDrawState, MonsterState } from '$lib/play/types';
	import { MONSTER_DECK_NAMES } from '$lib/play/runtime';
	import { buildMonsterRewards } from '$lib/play/monsterRewards';
	import { getAssetState } from '$lib/stores/assetStore.svelte';
	import TakeoverStage from './takeover/TakeoverStage.svelte';
	import MonsterCard from './MonsterCard.svelte';
	import {
		iconPoolUrl,
		MONSTER_DIFFICULTY_COLOR,
		MONSTER_NUMERAL,
		RESOURCE_ICON_IDS,
		rangeText,
		vpText,
		type MonsterDifficulty
	} from './helpers';

	interface Props {
		hand: MonsterState[];
		pending: MonsterDrawState | null | undefined;
		/** Difficulty decks with cards-left counts (room projection). */
		decks: MonsterDeckSummary[];
		/** The permanent monster (always available; a copy goes straight to the hand), if any. */
		permanent?: MonsterState | null;
		/** The player already drew a monster card this visit. */
		drawUsed: boolean;
		/** Battle actions this round (a fight uses one). */
		battle: AbyssBattleActions;
		/** How a draw works in this game. */
		draw?: AbyssDrawRules;
		/** The initiative die: sides that give this player the initiative. */
		initiative: { hits: number; sides: number };
		/** The player's Barrier, for the "it will likely corrupt you" warning. */
		barrier: number;
		/** The Abyss's own location actions (free Arcane Abyss Summon). */
		actions?: AbyssAction[];
		busy?: boolean;
		onDraw: (difficulty: MonsterDifficulty, permanent?: boolean) => void | Promise<unknown>;
		onKeep: (index: number, options?: KeepOptions) => void | Promise<unknown>;
		onFight: (handIndex: number) => void;
		onAction?: (key: string) => void;
		/** The current view, so the host can title the stage and park its pass control. */
		onViewChange?: (view: AbyssView) => void;
	}

	let {
		hand,
		pending,
		decks,
		permanent = null,
		drawUsed,
		battle,
		draw: drawRules = { reveals: 2, canReturn: false, waitsOn: null },
		initiative,
		barrier,
		actions = [],
		busy = false,
		onDraw,
		onKeep,
		onFight,
		onAction,
		onViewChange
	}: Props = $props();

	const HAND_LIMIT = 3;
	const DIFFICULTIES = [1, 2, 3] as const;
	const assets = getAssetState();
	const vpIcon = $derived(iconPoolUrl(assets.iconPool, RESOURCE_ICON_IDS.vp));

	function reducedMotion(): boolean {
		return (
			typeof window !== 'undefined' &&
			!!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
		);
	}

	// ── View state ───────────────────────────────────────────────────────────
	/** The deck picker is open. */
	let picking = $state(false);
	/** The deck the player tapped (set before the server answers, so the motion starts at once). */
	let chosen = $state<MonsterDifficulty | null>(null);
	/** The revealed card the player tapped to keep (set before the server answers). */
	let keeping = $state<number | null>(null);
	/** The kept card and the crossfade key it hands over to its new hand slot. Plain
	 *  variables: the outro reads them after the reveal has already been reset. */
	let keptIndex: number | null = null;
	let keptKey: string | null = null;
	/** Offset from the unkept card to the deck, so it slides back under it. */
	let returnShift = $state<{ x: number; y: number } | null>(null);
	/** The revealed cards finished their flight and turn face up. */
	let revealed = $state(false);
	let deckSlot = $state<HTMLElement | null>(null);

	const revealCards = $derived(pending?.cards ?? []);
	const hasReveal = $derived(revealCards.length > 0);
	const revealDeck = $derived<MonsterDifficulty | null>(
		hasReveal ? (revealCards[0].difficulty ?? 1) : chosen
	);
	// Once a keep is in flight, the view goes home in the SAME update that empties the
	// reveal and adds the card to the hand — that is what lets the card fly across.
	const view = $derived<AbyssView>(
		hasReveal || (chosen !== null && keeping === null)
			? 'reveal'
			: picking && keeping === null
				? 'decks'
				: 'home'
	);

	$effect(() => {
		onViewChange?.(view);
	});
	$effect(() => () => onViewChange?.('home'));

	// The reveal closed (kept, or resolved for the player at a deadline): reset.
	let hadReveal = false;
	$effect(() => {
		if (hasReveal) {
			hadReveal = true;
			return;
		}
		if (!hadReveal) return;
		hadReveal = false;
		picking = false;
		chosen = null;
		keeping = null;
		returnShift = null;
	});

	// Flip the revealed cards face up once they have flown out of the deck. Keyed on the
	// card ids, not the object: every poll hands us a fresh `pending`.
	const revealKey = $derived(revealCards.map((c) => c.id).join('|'));
	$effect(() => {
		if (!revealKey) {
			revealed = false;
			return;
		}
		if (reducedMotion()) {
			revealed = true;
			return;
		}
		const timer = setTimeout(() => (revealed = true), 640);
		return () => clearTimeout(timer);
	});

	// ── Data ─────────────────────────────────────────────────────────────────
	function deckOf(difficulty: MonsterDifficulty): MonsterDeckSummary {
		return (
			decks.find((d) => d.difficulty === difficulty) ?? {
				difficulty,
				total: 0,
				count: 0,
				barrierMin: 0,
				barrierMax: 0,
				vpValues: [],
				summonMin: 0,
				summonMax: 0,
				extraRewards: []
			}
		);
	}
	function cardsLeft(difficulty: MonsterDifficulty): number {
		const deck = deckOf(difficulty);
		return deck.count ?? deck.total;
	}
	function rewardsLine(deck: MonsterDeckSummary): string {
		const summons =
			deck.summonMax > 0
				? `${rangeText(deck.summonMin, deck.summonMax)} Summon${deck.summonMax === 1 ? '' : 's'}`
				: null;
		const extras = deck.extraRewards.length ? deck.extraRewards.join(' + ') : null;
		return [summons, extras].filter(Boolean).join(' + ');
	}
	function deckAria(deck: MonsterDeckSummary): string {
		const rewards = rewardsLine(deck);
		return `Difficulty ${MONSTER_NUMERAL[deck.difficulty]} deck, ${MONSTER_DECK_NAMES[deck.difficulty]}: ${vpText(deck.vpValues, ' or ')} Victory Points, Barrier ${rangeText(deck.barrierMin, deck.barrierMax)}${rewards ? `, ${rewards}` : ''}, ${cardsLeft(deck.difficulty)} cards left`;
	}

	const anyCardsLeft = $derived(DIFFICULTIES.some((d) => cardsLeft(d) > 0));
	const handFull = $derived(hand.length >= HAND_LIMIT);
	const fightsLeft = $derived(Math.max(0, battle.left));
	/** Another player draws from the decks first (the permanent monster needs no turn). */
	const waitsOn = $derived(drawUsed ? null : drawRules.waitsOn);
	/** A deck may be drawn from: a full hand too, when the drawn card can take a held card's place. */
	const deckDrawOpen = $derived(anyCardsLeft && !waitsOn && (!handFull || drawRules.canReturn));
	const permanentOpen = $derived(!!permanent && !handFull);
	const drawBlocked = $derived(
		drawUsed
			? 'Drawn this visit'
			: deckDrawOpen || permanentOpen
				? null
				: handFull
					? 'Hand full · fight one first'
					: waitsOn
						? `${waitsOn} draws first`
						: 'All decks are empty'
	);

	/** Stable crossfade key per hand card (ids can repeat, so count earlier copies). */
	function handKey(cards: MonsterState[], index: number): string {
		const id = cards[index].id;
		const copy = cards.slice(0, index).filter((c) => c.id === id).length;
		return `card-${id}#${copy}`;
	}
	const slots = $derived(
		Array.from({ length: HAND_LIMIT }, (_, i) => {
			const card = hand[i] ?? null;
			return { index: i, card, key: card ? handKey(hand, i) : `empty-${i}` };
		})
	);

	function fightWarning(card: MonsterState): string | null {
		if (card.damage < barrier) return null;
		return `Warning: it deals ${card.damage} and you have ${barrier} Barrier, so it will likely corrupt you. If your initiative die hits (${initiative.hits} of ${initiative.sides} sides) you attack at the same time and your damage still lands; if it misses, the monster attacks first and you cannot strike back.`;
	}

	/** One card is revealed and it may be kept, put back, or swapped for a held card. */
	const oneCard = $derived(drawRules.canReturn && revealCards.length === 1);
	const actionWord = (n: number) => `${n} battle action${n === 1 ? '' : 's'}`;

	const subtitle = $derived.by(() => {
		if (view === 'decks') {
			const how =
				drawRules.reveals === 1
					? 'Reveal the top card of a deck: keep it or put it back'
					: 'Reveal 2 from a deck and keep 1';
			const wait = waitsOn ? `${waitsOn} draws from the decks first` : how;
			return permanent ? `${wait} · or take ${permanent.name}` : wait;
		}
		if (view === 'reveal' && revealDeck) {
			const deck = `Deck ${MONSTER_NUMERAL[revealDeck]}`;
			if (!hasReveal) return `Drawing from ${deck}…`;
			if (oneCard)
				return handFull
					? `The top card of ${deck} · Your hand is full: swap it for one of your cards, or put it back`
					: `The top card of ${deck} · Keep it, or put it back on top of the deck`;
			return revealCards.length > 1
				? `Two cards from ${deck} · Tap one to add it to your hand`
				: `The last card of ${deck} · Tap it to add it to your hand`;
		}
		if (battle.summonUsesOne) {
			if (fightsLeft <= 0) return 'No battle action left this round';
			const summonOpen = actions.some((a) => !a.disabled);
			return `${actionWord(fightsLeft)} left · ${summonOpen ? 'Fight a card or take the Arcane Abyss Summon' : 'Fight a card from your hand'}`;
		}
		return 'Draw a monster card, or fight one from your hand';
	});

	// ── Actions ──────────────────────────────────────────────────────────────
	function openDecks() {
		if (busy || drawBlocked) return;
		picking = true;
	}
	function back() {
		if (chosen !== null || hasReveal) return;
		picking = false;
	}
	async function draw(difficulty: MonsterDifficulty) {
		if (busy || chosen !== null || cardsLeft(difficulty) === 0 || !deckDrawOpen) return;
		keptIndex = null;
		keptKey = null;
		chosen = difficulty;
		await onDraw(difficulty);
		// Rejected (no reveal came back): return to the deck picker.
		if (!pending?.cards.length) chosen = null;
	}
	/** Take a copy of the permanent monster: it goes straight into the hand (no reveal). */
	let takingPermanent = $state(false);
	async function takePermanent() {
		if (busy || chosen !== null || takingPermanent || !permanent || handFull) return;
		takingPermanent = true;
		const before = hand.length;
		try {
			await onDraw(1, true);
		} finally {
			takingPermanent = false;
		}
		// Taken: back to the hand. Rejected: stay on the picker.
		if (hand.length > before) picking = false;
	}
	function permanentRewards(card: MonsterState): string {
		const rewards = buildMonsterRewards(card.rewardTrack);
		const vp = rewards.reduce((n, r) => n + (r.effect.type === 'vp' ? r.effect.amount : 0), 0);
		const summons = rewards.filter(
			(r) => r.effect.type === 'action' && r.effect.action === 'abyssSummon'
		).length;
		const gains = [vp ? `${vp} VP` : '', summons ? `${summons === 1 ? '' : `${summons} `}Abyss Summon${summons === 1 ? '' : 's'}` : '']
			.filter(Boolean)
			.join(' + ');
		return `Barrier ${card.maxHp} · ${card.damage} damage${gains ? ` · ${gains}` : ''}`;
	}
	/** Slide a revealed card (the one not kept) back under the deck. */
	function slideBack(from: Element | null | undefined) {
		if (!deckSlot || !from) return;
		const box = from.getBoundingClientRect();
		const to = deckSlot.getBoundingClientRect();
		returnShift = {
			x: to.left + to.width / 2 - (box.left + box.width / 2),
			y: to.top + to.height / 2 - (box.top + box.height / 2)
		};
	}
	/** Undo the optimistic motion when the server refused the choice (the reveal is still open). */
	function settleKeep() {
		if (!pending?.cards.length) return;
		keeping = null;
		keptIndex = null;
		keptKey = null;
		returnShift = null;
	}
	async function keep(index: number, event: MouseEvent) {
		if (busy || keeping !== null) return;
		const card = revealCards[index];
		if (!card) return;
		// A full hand cannot take the card: it needs a swap (the cards beside it) or goes back.
		if (handFull) return;
		keptIndex = index;
		keptKey = `card-${card.id}#${hand.filter((c) => c.id === card.id).length}`;
		const other = revealCards.length > 1 ? 1 - index : null;
		if (other !== null) {
			const row = (event.currentTarget as HTMLElement).parentElement;
			slideBack(row?.querySelector<HTMLElement>(`[data-reveal-index="${other}"]`));
		}
		keeping = index;
		await onKeep(index);
		settleKeep();
	}
	/** One-card draw: keep the revealed card and put the held card at `handIndex` back on its deck. */
	async function swapFor(handIndex: number) {
		if (busy || keeping !== null || !oneCard) return;
		const card = revealCards[0];
		const old = hand[handIndex];
		if (!card || !old) return;
		keptIndex = 0;
		// The hand after the swap: the old card is gone, the new one is last.
		keptKey = `card-${card.id}#${hand.filter((c, i) => i !== handIndex && c.id === card.id).length}`;
		keeping = 0;
		await onKeep(0, { replaceHandIndex: handIndex });
		settleKeep();
	}
	let revealRow = $state<HTMLElement | null>(null);
	/** One-card draw: put the revealed card back on top of its deck. It was the draw of this visit. */
	async function putBack() {
		if (busy || keeping !== null || !oneCard) return;
		keptIndex = null;
		keptKey = null;
		slideBack(revealRow?.querySelector<HTMLElement>('[data-reveal-index="0"]'));
		// No index is kept: the card flips face down and slides under the deck.
		keeping = -1;
		await onKeep(0, { returnToDeck: true });
		settleKeep();
	}
	/** What a held card loses when it goes back on its deck. */
	function swapNote(card: MonsterState): string {
		if (card.permanent) return 'Leaves your hand';
		const dealt = Math.max(0, card.maxHp - card.hp);
		return dealt > 0 ? `Back on its deck · the ${dealt} damage is lost` : 'Back on top of its deck';
	}

	// ── Motion ───────────────────────────────────────────────────────────────
	const DURATION = 480;
	function settle(node: Element, intro: boolean): TransitionConfig {
		if (reducedMotion()) return { duration: 0 };
		const base = getComputedStyle(node).transform;
		const start = base === 'none' ? '' : base;
		return {
			duration: intro ? 320 : 200,
			easing: cubicOut,
			css: (t) => `opacity: ${t}; transform: ${start} scale(${0.9 + 0.1 * t});`
		};
	}
	const [send, receive] = crossfade({
		duration: () => (reducedMotion() ? 0 : DURATION),
		easing: cubicOut,
		fallback: (node, _params, intro) => settle(node, intro)
	});

	/** Labels fade with their view while the cards themselves fly between views. */
	function label(
		_node: Element,
		{ intro = false, delay = 200 }: { intro?: boolean; delay?: number } = {}
	): TransitionConfig {
		if (reducedMotion()) return { duration: 0 };
		return intro
			? { delay, duration: 220, css: (t) => `opacity: ${t}` }
			: { duration: 120, css: (t) => `opacity: ${t}` };
	}

	/** The revealed cards fly out of the deck slot, one after the other. */
	function flyFromDeck(node: HTMLElement, { index }: { index: number }): TransitionConfig {
		if (reducedMotion() || !deckSlot) return { duration: 0 };
		const from = deckSlot.getBoundingClientRect();
		const to = node.getBoundingClientRect();
		const dx = from.left + from.width / 2 - (to.left + to.width / 2);
		const dy = from.top + from.height / 2 - (to.top + to.height / 2);
		const scale = to.width ? from.width / to.width : 1;
		return {
			delay: 60 + index * 140,
			duration: 560,
			easing: cubicOut,
			css: (t, u) =>
				`transform: translate(${dx * u}px, ${dy * u}px) scale(${scale + (1 - scale) * t}) rotate(${-8 * u}deg); opacity: ${Math.min(1, t * 4)};`
		};
	}
	/** Leaving the reveal: the kept card hands over to the hand, the other one fades. */
	function leaveReveal(
		node: HTMLElement,
		{ index }: { index: number }
	): TransitionConfig | (() => TransitionConfig) {
		if (index === keptIndex && keptKey) return send(node, { key: keptKey });
		return fade(node, { duration: reducedMotion() ? 0 : 180 });
	}
</script>

<TakeoverStage
	accent={revealDeck ? MONSTER_DIFFICULTY_COLOR[revealDeck] : 'var(--brand-magenta, #ff2bc7)'}
	testid="abyss-stage"
	onEscape={view === 'decks' ? back : null}
>
	<div class="abyss" data-view={view}>
		<p class="sub" aria-live="polite">{subtitle}</p>
		<div class="scene">
			{#if view === 'home'}
				<div class="row home">
					<button
						type="button"
						class="obj stack"
						class:blocked={!!drawBlocked}
						data-testid="abyss-draw-stack"
						disabled={busy || !!drawBlocked}
						aria-label={drawBlocked
							? `Monster decks: ${drawBlocked}`
							: 'Monster decks: tap to draw a monster card'}
						onclick={openDecks}
					>
						<span class="floater" style="--i: 0">
							<span class="pile">
								{#each DIFFICULTIES as d (d)}
									<span
										class="pile-card p{d}"
										class:spent={cardsLeft(d) === 0}
										in:receive|global={{ key: `deck-${d}` }}
										out:send|global={{ key: `deck-${d}` }}
									>
										<MonsterCard difficulty={d} faceUp={false} />
									</span>
								{/each}
							</span>
						</span>
						<span class="labels" in:label|global={{ intro: true }} out:label|global>
							<span class="name">Monster decks</span>
							{#if drawBlocked}
								<span class="cta">{drawBlocked}</span>
							{:else if waitsOn}
								<span class="cta wait" data-testid="abyss-draw-wait"
									>{waitsOn} draws first<span class="cta-soft"
										>{permanent ? `or take ${permanent.name}` : ''}</span
									></span
								>
							{:else}
								<span class="cta"
									>Tap to draw<span class="cta-soft"
										>{handFull ? 'swap one of your cards' : '1 per visit'}</span
									></span
								>
							{/if}
						</span>
					</button>
					<span class="spacer" aria-hidden="true"></span>
					{#each slots as slot (slot.key)}
						<div
							class="slot"
							animate:flip={{ duration: reducedMotion() ? 0 : 320 }}
							in:receive|global={{ key: slot.key }}
							out:send|global={{ key: slot.key }}
						>
							{#if slot.card}
								{@const warning = fightWarning(slot.card)}
								<button
									type="button"
									class="obj hand"
									class:spent={fightsLeft <= 0}
									data-testid="monster-hand-{slot.index}"
									disabled={busy || fightsLeft <= 0}
									title={warning ?? undefined}
									onclick={() => onFight(slot.index)}
								>
									<span class="floater" style="--i: {slot.index + 1}">
										<MonsterCard card={slot.card} />
									</span>
									<span class="labels" in:label|global={{ intro: true }} out:label|global>
										<span class="cta">
											{#if fightsLeft <= 0}
												{battle.summonTaken ? 'No battle action left' : 'Fought this round'}
											{:else if battle.total > 1}
												Tap to fight · {fightsLeft} left
											{:else}
												Tap to fight
											{/if}
										</span>
										{#if warning && fightsLeft > 0}
											<span class="warn">⚠ Likely corrupts you</span>
										{/if}
									</span>
								</button>
							{:else}
								<div class="obj empty" aria-hidden={slot.index !== hand.length}>
									<span class="outline"><span class="plus" aria-hidden="true">+</span></span>
									<span class="cta muted">
										{slot.index === hand.length ? `Hand ${hand.length} / ${HAND_LIMIT}` : ''}
									</span>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{:else if view === 'decks'}
				<div class="row decks" class:four={!!permanent} role="group" aria-label="Monster decks">
					{#each DIFFICULTIES as d (d)}
						{@const deck = deckOf(d)}
						{@const left = cardsLeft(d)}
						<button
							type="button"
							class="obj deck"
							style="--c: {MONSTER_DIFFICULTY_COLOR[d]}"
							data-testid="monster-difficulty-{d}"
							disabled={busy || left === 0 || !deckDrawOpen}
							aria-label={deckAria(deck)}
							onclick={() => draw(d)}
						>
							<span class="floater" style="--i: {d - 1}">
								<span
									class="deck-card"
									in:receive|global={{ key: `deck-${d}` }}
									out:send|global={{ key: `deck-${d}` }}
								>
									<MonsterCard difficulty={d} faceUp={false} />
								</span>
							</span>
							<span class="info" in:label|global={{ intro: true }} out:label|global>
								<b>{MONSTER_NUMERAL[d]} · {MONSTER_DECK_NAMES[d]}</b>
								<span class="vp">
									{#if vpIcon}<img src={vpIcon} alt="" />{/if}{vpText(deck.vpValues)} VP
								</span>
								<span>
									Barrier {rangeText(deck.barrierMin, deck.barrierMax)}{rewardsLine(deck)
										? ` · ${rewardsLine(deck)}`
										: ''}
								</span>
								<span class="left">{left === 0 ? 'Empty' : `${left} left`}</span>
								{#if left > 0 && waitsOn}
									<span class="left wait">{waitsOn} draws first</span>
								{:else if left > 0 && handFull && !drawRules.canReturn}
									<span class="left wait">Hand full</span>
								{/if}
							</span>
						</button>
					{/each}
					{#if permanent}
						<!-- The permanent monster: face up, never runs out, goes straight to the hand. -->
						<button
							type="button"
							class="obj deck permanent"
							style="--c: var(--brand-amber, #ffba3d)"
							data-testid="monster-permanent"
							disabled={busy || takingPermanent || handFull}
							aria-label={`${permanent.name}, always available: ${permanentRewards(permanent)}. Tap to add it to your hand.`}
							onclick={takePermanent}
						>
							<span class="floater" style="--i: 3">
								<span class="deck-card"><MonsterCard card={permanent} /></span>
							</span>
							<span class="info" in:label|global={{ intro: true }} out:label|global>
								<b>{permanent.name}</b>
								<span>{permanentRewards(permanent)}</span>
								<span class="left">{handFull ? 'Hand full' : 'Always here · Tap to take'}</span>
							</span>
						</button>
					{/if}
				</div>
			{:else if revealDeck}
				{@const d = revealDeck}
				<div
					class="row reveal"
					class:swaps={oneCard && hand.length > 0}
					style="--c: {MONSTER_DIFFICULTY_COLOR[d]}"
					bind:this={revealRow}
				>
					<div class="deck-slot" bind:this={deckSlot}>
						<span
							class="deck-card"
							in:receive|global={{ key: `deck-${d}` }}
							out:send|global={{ key: `deck-${d}` }}
						>
							<MonsterCard difficulty={d} faceUp={false} />
						</span>
						<span class="info small" in:label|global={{ intro: true }} out:label|global>
							<b>{MONSTER_NUMERAL[d]} · {MONSTER_DECK_NAMES[d]}</b>
							<span class="left">{cardsLeft(d)} left</span>
						</span>
					</div>
					<span
						class="trail"
						aria-hidden="true"
						in:label|global={{ intro: true }}
						out:label|global
					></span>
					<div class="picks" class:waiting={!hasReveal} class:single={drawRules.reveals === 1}>
						{#each revealCards as card, idx (idx + ':' + card.id)}
							<button
								type="button"
								class="obj pick"
								class:chosen={keeping === idx}
								class:returning={keeping !== null && keeping !== idx}
								style={keeping !== null && keeping !== idx && returnShift
									? `--rx: ${returnShift.x}px; --ry: ${returnShift.y}px`
									: undefined}
								data-reveal-index={idx}
								data-testid="monster-card-keep-{idx}"
								disabled={busy || keeping !== null || handFull}
								onclick={(event) => keep(idx, event)}
								in:flyFromDeck|global={{ index: idx }}
								out:leaveReveal|global={{ index: idx }}
							>
								<span class="floater" style="--i: {idx + 1}">
									<MonsterCard {card} faceUp={revealed && (keeping === null || keeping === idx)} />
								</span>
								<span class="cta" in:label|global={{ intro: true, delay: 620 + idx * 140 }}
									>{keeping === idx
										? 'Added to your hand'
										: keeping === -1
											? 'Back on the deck'
											: handFull
												? 'Hand full'
												: 'Tap to keep'}</span
								>
							</button>
						{/each}
					</div>
					{#if oneCard && hand.length > 0 && keeping === null}
						<!-- Keep the revealed card and put one of the held cards back on its deck. -->
						<div
							class="swap"
							role="group"
							aria-label="Swap for one of your cards"
							in:label|global={{ intro: true, delay: 760 }}
							out:label|global
						>
							<span class="swap-title">{handFull ? 'Swap it for' : 'Or swap it for'}</span>
							<div class="swap-cards">
								{#each hand as held, i (handKey(hand, i))}
									<button
										type="button"
										class="obj held"
										data-testid="monster-swap-{i}"
										disabled={busy}
										title={`Keep the new card and put ${held.name} back. ${swapNote(held)}.`}
										onclick={() => swapFor(i)}
									>
										<span class="floater" style="--i: {i + 2}"><MonsterCard card={held} /></span>
										<span class="cta">Swap out</span>
										<span class="swap-note">{swapNote(held)}</span>
									</button>
								{/each}
							</div>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	</div>

	{#snippet bar()}
		<div class="ghosts">
			{#if view === 'decks'}
				<button type="button" class="ghost" data-testid="abyss-back" onclick={back}>Back</button>
			{:else if view === 'reveal' && oneCard}
				<button
					type="button"
					class="ghost"
					data-testid="monster-card-return"
					disabled={busy || keeping !== null || !revealed}
					onclick={putBack}>Put it back</button
				>
			{:else if view === 'home'}
				{#each actions as action (action.key)}
					<button
						type="button"
						class="ghost"
						data-testid={action.testid}
						disabled={busy || action.disabled}
						onclick={() => onAction?.(action.key)}
					>
						{#if action.icon}<img src={action.icon} alt="" />{/if}{action.label}{#if action.note}<span class="ghost-note">{action.note}</span>{/if}
					</button>
				{/each}
			{/if}
		</div>
	{/snippet}
</TakeoverStage>

<style>
	/* The whole rack column is the scene; card sizes come from its box (cqw / cqh). */
	.abyss {
		--gap: clamp(0.6rem, 2.2cqw, 1.6rem);
		container-type: size;
		flex: 1 1 auto;
		align-self: stretch;
		min-height: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: clamp(0.3rem, 1.6cqh, 0.9rem);
	}
	.sub {
		flex: none;
		margin: 0;
		font-family: var(--font-display);
		font-size: 1rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		text-align: center;
		color: var(--brand-cyan, #5cdfff);
		text-shadow: 0 2px 10px rgba(0, 0, 0, 0.7);
	}
	/* Views share one grid cell, so the outgoing and incoming views overlap while
	   their cards fly between them. */
	.scene {
		flex: 1 1 auto;
		min-height: 0;
		width: 100%;
		box-sizing: border-box;
		/* Room for the floating bob and the fanned pile's corners under the subtitle. */
		padding-top: 0.75rem;
		display: grid;
		place-items: center;
		perspective: 1200px;
	}
	.scene > :global(*) {
		grid-area: 1 / 1;
	}
	.row {
		display: flex;
		align-items: flex-start;
		justify-content: center;
		gap: var(--gap);
		max-width: 100%;
	}

	/* ── Floating objects: no panel, just the card and a label on the backdrop ── */
	.obj {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.3rem;
		width: var(--w);
		padding: 0;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-align: center;
		cursor: pointer;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
	}
	.obj:disabled {
		cursor: not-allowed;
	}
	.obj:focus-visible {
		outline: 2px solid var(--brand-cyan, #5cdfff);
		outline-offset: 6px;
		border-radius: 8px;
	}
	.floater {
		display: block;
		width: 100%;
		transform-style: preserve-3d;
		filter: drop-shadow(0 14px 18px rgba(0, 0, 0, 0.5));
		animation: float3d calc(5.5s + var(--i) * 0.5s) ease-in-out calc(var(--i) * -1.3s) infinite;
		transition:
			filter 180ms ease,
			scale 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	@media (hover: hover) and (pointer: fine) {
		.obj:not(:disabled):hover .floater {
			filter: drop-shadow(0 18px 24px rgba(0, 0, 0, 0.55))
				drop-shadow(0 0 18px color-mix(in srgb, var(--c, var(--brand-magenta, #ff2bc7)) 55%, transparent));
		}
		/* A face-up card grows under the pointer, so the printed name and rewards read. */
		.obj.hand:not(:disabled):hover,
		.obj.pick:not(:disabled):hover {
			z-index: 4;
		}
		.obj.hand:not(:disabled):hover .floater,
		.obj.pick:not(:disabled):hover .floater {
			scale: 1.25;
		}
	}
	.obj:disabled .floater {
		animation-play-state: paused;
	}
	.name {
		font-family: var(--font-display);
		font-size: 0.95rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		line-height: 1.1;
		color: #fff;
		text-shadow: 0 2px 8px #000;
	}
	.cta {
		font-size: 0.68rem;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		line-height: 1.2;
		color: var(--brand-cyan, #5cdfff);
		text-shadow: 0 1px 6px #000;
	}
	.labels {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.2rem;
	}
	.cta-soft {
		display: block;
		color: rgba(235, 230, 247, 0.6);
		letter-spacing: 0.08em;
	}
	.cta.muted {
		color: rgba(235, 230, 247, 0.55);
		min-height: 1.2em;
	}
	.warn {
		text-wrap: balance;
		margin-top: -0.15rem;
		font-size: 0.62rem;
		font-weight: 800;
		letter-spacing: 0.04em;
		line-height: 1.2;
		color: #ff8a6b;
		text-shadow: 0 1px 6px #000;
	}

	/* ── Home: the deck stack + the hand ── */
	.row.home {
		/* Caps sized so the printed cards' names and numbers read on desktop. */
		--w: min(calc((100cqw - 4 * var(--gap) - 1.5rem) / 4.4), calc((100cqh - 6.2rem) * 0.6), 12.5rem);
	}
	.spacer {
		width: clamp(0.25rem, 2cqw, 1.5rem);
	}
	/* The fanned pile is wider than one card: the stack column makes room for it. */
	.obj.stack {
		width: calc(var(--w) * 1.32);
	}
	.stack .floater {
		width: var(--w);
	}
	.pile {
		position: relative;
		display: block;
		width: 100%;
		aspect-ratio: 3 / 5;
	}
	.pile-card {
		position: absolute;
		inset: 0;
		display: block;
	}
	.pile-card.p1 {
		transform: translateX(-16%) rotate(-8deg);
	}
	.pile-card.p2 {
		z-index: 1;
	}
	.pile-card.p3 {
		transform: translateX(16%) rotate(8deg);
		z-index: 2;
	}
	.pile-card.spent {
		filter: grayscale(0.8) brightness(0.55);
	}
	.stack .name {
		margin-top: 0.15rem;
	}
	.stack.blocked .pile {
		filter: grayscale(0.65) brightness(0.6);
	}
	.stack.blocked .cta {
		color: var(--brand-amber-soft, #ffd56a);
	}
	.slot {
		display: flex;
	}
	.hand.spent .floater {
		filter: grayscale(0.4) brightness(0.75) drop-shadow(0 14px 18px rgba(0, 0, 0, 0.5));
	}
	.hand.spent .cta {
		color: rgba(235, 230, 247, 0.6);
	}
	.empty {
		cursor: default;
	}
	.outline {
		display: grid;
		place-items: center;
		width: 100%;
		aspect-ratio: 3 / 5;
		box-sizing: border-box;
		border-radius: calc(var(--w) * 0.06);
		border: 1px dashed rgba(255, 255, 255, 0.2);
		background: rgba(255, 255, 255, 0.015);
	}
	.plus {
		font-family: var(--font-display);
		font-size: calc(var(--w) * 0.3);
		line-height: 1;
		color: rgba(255, 255, 255, 0.22);
	}

	/* ── Decks: three backs with what each deck holds ── */
	.row.decks {
		--w: min(calc((100cqw - 2 * var(--gap)) / 3.25), calc((100cqh - 8.4rem) * 0.6), 10rem);
		gap: calc(var(--gap) * 1.6);
	}
	/* With the permanent monster there are four columns. */
	.row.decks.four {
		--w: min(calc((100cqw - 3 * var(--gap) * 1.6) / 4.3), calc((100cqh - 8.4rem) * 0.6), 10rem);
	}
	.deck-card {
		display: block;
		width: 100%;
	}
	.info {
		display: grid;
		gap: 0.12rem;
		width: max-content;
		/* Wrap before the text reaches the next deck's column. */
		max-width: calc(var(--w) + var(--gap));
		font-size: 0.72rem;
		line-height: 1.25;
		color: var(--color-parchment, #ebe6f7);
		text-shadow: 0 1px 6px #000;
	}
	.info b {
		font-family: var(--font-display);
		font-weight: 400;
		font-size: 1rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--c);
	}
	.info .vp {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.25rem;
		font-weight: 800;
		color: var(--brand-amber, #ffba3d);
	}
	.info .vp img {
		width: 1.1em;
		height: 1.1em;
		object-fit: contain;
	}
	.info .left {
		color: rgba(235, 230, 247, 0.7);
	}
	.deck:disabled .floater {
		filter: grayscale(0.8) brightness(0.55);
	}

	/* ── Reveal: the chosen deck on the left, two cards flown out of it ── */
	.row.reveal {
		--w: min(calc((100cqw - 3 * var(--gap) - 2rem) / 2.95), calc((100cqh - 5.2rem) * 0.6), 16rem);
		align-items: center;
	}
	.deck-slot {
		position: relative;
		z-index: 2;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.3rem;
		width: calc(var(--w) * 0.72);
	}
	.deck-slot .deck-card {
		transform: rotate(-4deg);
	}
	.info.small {
		max-width: calc(var(--w) * 1.1);
		font-size: 0.66rem;
	}
	.info.small b {
		font-size: 0.85rem;
	}
	.trail {
		align-self: center;
		width: clamp(1rem, 5cqw, 3.5rem);
		margin-bottom: 1.4rem;
		border-top: 2px dashed color-mix(in srgb, var(--c) 45%, transparent);
	}
	.picks {
		display: flex;
		gap: var(--gap);
		min-width: calc(var(--w) * 2 + var(--gap));
		justify-content: center;
	}
	/* One card revealed: the pick column is one card wide. */
	.picks.single {
		min-width: var(--w);
	}
	.row.reveal.swaps {
		--w: min(calc((100cqw - 4 * var(--gap) - 2rem) / 4.1), calc((100cqh - 5.2rem) * 0.6), 15rem);
	}
	/* The held cards a kept card may take the place of. */
	.swap {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.35rem;
		margin-left: clamp(0.25rem, 2cqw, 1.25rem);
		padding-left: clamp(0.5rem, 2cqw, 1.25rem);
		border-left: 1px dashed rgba(255, 255, 255, 0.18);
	}
	.swap-title {
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-parchment, #ebe6f7);
		text-shadow: 0 1px 6px #000;
	}
	.swap-cards {
		display: flex;
		gap: calc(var(--gap) * 0.6);
	}
	.obj.held {
		width: calc(var(--w) * 0.5);
		gap: 0.15rem;
	}
	.swap-note {
		font-size: 0.56rem;
		line-height: 1.2;
		letter-spacing: 0.02em;
		color: rgba(235, 230, 247, 0.7);
		text-shadow: 0 1px 6px #000;
		text-wrap: balance;
	}
	.cta.wait,
	.info .left.wait {
		color: var(--brand-amber-soft, #ffd56a);
	}
	.ghost-note {
		font-size: 0.62rem;
		letter-spacing: 0.04em;
		text-transform: none;
		color: rgba(235, 230, 247, 0.65);
	}
	.pick {
		z-index: 1;
		transition: transform 600ms cubic-bezier(0.45, 0.05, 0.25, 1);
	}
	.pick.chosen {
		z-index: 3;
		transform: translateY(-4px) scale(1.03);
	}
	.pick.chosen .floater {
		filter: drop-shadow(0 18px 24px rgba(0, 0, 0, 0.55))
			drop-shadow(0 0 22px color-mix(in srgb, var(--c) 70%, transparent));
	}
	.pick.chosen .cta {
		color: #fff;
	}
	/* The card not kept flips back and slides under the deck. */
	.pick.returning {
		z-index: 0;
		transform: translate(var(--rx, 0px), var(--ry, 0px)) scale(0.72) rotate(-4deg);
	}
	.pick.returning .cta {
		visibility: hidden;
	}

	/* ── Ghost buttons (spirit-draw style) ── */
	.ghosts {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.6rem;
		min-height: 0;
	}
	.ghost {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		padding: 9px 18px;
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		border: 1px solid var(--color-mist, #3a2670);
		background: rgba(10, 4, 24, 0.45);
		color: var(--color-parchment, #e7e0cf);
		border-radius: 3px;
		cursor: pointer;
		touch-action: manipulation;
		transition:
			border-color 140ms ease,
			color 140ms ease;
	}
	.ghost img {
		width: 1.3em;
		height: 1.3em;
		object-fit: contain;
	}
	@media (hover: hover) and (pointer: fine) {
		.ghost:hover:not(:disabled) {
			border-color: var(--brand-magenta, #ff2bc7);
			color: var(--brand-magenta-soft, #ff7fd9);
		}
	}
	.ghost:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	@keyframes float3d {
		0% {
			transform: translate3d(0, 0, 0) rotateZ(0deg) rotateY(-7deg) rotateX(3deg);
		}
		25% {
			transform: translate3d(5px, -7px, 0) rotateZ(1.2deg) rotateY(6deg) rotateX(-2deg);
		}
		50% {
			transform: translate3d(0, -11px, 0) rotateZ(0deg) rotateY(8deg) rotateX(-3deg);
		}
		75% {
			transform: translate3d(-5px, -6px, 0) rotateZ(-1.2deg) rotateY(2deg) rotateX(2deg);
		}
		100% {
			transform: translate3d(0, 0, 0) rotateZ(0deg) rotateY(-7deg) rotateX(3deg);
		}
	}

	/* ── Phone landscape (~844×390): compact type so four cards fit across ── */
	@media (orientation: landscape) and (max-height: 520px) and (pointer: coarse) {
		.abyss {
			gap: 0.3rem;
		}
		.scene {
			padding-top: 0.55rem;
		}
		.sub {
			font-size: 0.68rem;
			line-height: 1.05;
		}
		.row.home {
			--w: min(calc((100cqw - 4 * var(--gap) - 1rem) / 4.4), calc((100cqh - 4.6rem) * 0.6), 9rem);
		}
		.row.decks {
			--w: min(calc((100cqw - 2 * var(--gap)) / 3.4), calc((100cqh - 6.1rem) * 0.6), 8rem);
		}
		.row.decks.four {
			--w: min(calc((100cqw - 3 * var(--gap) * 1.6) / 4.4), calc((100cqh - 6.1rem) * 0.6), 8rem);
		}
		.row.reveal {
			--w: min(calc((100cqw - 3 * var(--gap) - 1.5rem) / 2.95), calc((100cqh - 4.2rem) * 0.6), 9.5rem);
		}
		.row.reveal.swaps {
			--w: min(calc((100cqw - 4 * var(--gap) - 1.5rem) / 4.1), calc((100cqh - 4.2rem) * 0.6), 9.5rem);
		}
		.swap-title {
			font-size: 0.62rem;
		}
		.swap-note {
			font-size: 0.5rem;
		}
		.obj {
			gap: 0.18rem;
		}
		.name {
			font-size: 0.68rem;
		}
		.cta {
			font-size: 0.54rem;
			letter-spacing: 0.06em;
		}
		.warn {
			font-size: 0.52rem;
		}
		.info {
			gap: 0;
			font-size: 0.56rem;
			line-height: 1.2;
		}
		.info b {
			font-size: 0.72rem;
		}
		.info.small {
			font-size: 0.54rem;
		}
		.info.small b {
			font-size: 0.66rem;
		}
		.ghost {
			min-height: 34px;
			padding: 6px 14px;
			font-size: 0.68rem;
			letter-spacing: 0.09em;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.floater {
			animation: none;
		}
		.pick {
			transition: none;
		}
	}
</style>

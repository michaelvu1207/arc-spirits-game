<script lang="ts">
	import { onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { auth } from '$lib/auth/auth.svelte';
	import { apiUrl, isCrossOrigin } from '$lib/play/apiBase';
	import { postPlayJson, restoreActiveMember, setActiveMember } from '$lib/stores/playStore.svelte';
	import { runRematch } from '$lib/play/rematchAction';
	import { buildPostgameInsights } from '$lib/play/postgameInsights';
	import { getCosmeticsState, syncCosmetics } from '$lib/stores/cosmetics.svelte';
	import type { getAssetState } from '$lib/stores/assetStore.svelte';
	import { calculateMatchAward, type MatchAward, type RankDefinition } from '$lib/cosmetics/progression';
	import type { PrivatePlayerState, SeatColor, SpectatorProjection } from '$lib/play/types';
	import type { ClassTrait } from '$lib/types';
	import { expectedAttack } from '$lib/play/combat';
	import LowPolySpiritStage from '$lib/components/LowPolySpiritStage.svelte';
	import { augmentContributions } from '$lib/play/augments';
	import { seatAccent, storageUrl, spiritBackImageUrl, iconPoolUrl, RESOURCE_ICON_IDS } from './helpers';

	interface Props {
		room: SpectatorProjection;
		mySeat: SeatColor | null;
		assets: ReturnType<typeof getAssetState>;
		/** id → print-art URL for awakened spirits. */
		spiritImages: Map<string, string>;
	}

	let { room, mySeat, assets, spiritImages }: Props = $props();

	const cosmetics = getCosmeticsState();
	// Reuse the in-game leaderboard's resource icons (VP + barrier) so the standings
	// stats read identically to the live board.
	const vpIcon = $derived(iconPoolUrl(assets.iconPool, RESOURCE_ICON_IDS.vp));
	const barrierIcon = $derived(iconPoolUrl(assets.iconPool, RESOURCE_ICON_IDS.barrier));

	// ── Trait-chip palette (mirrors TraitTracker) ──────────────────────────────
	const SPECIAL_ORANGE = '#ff9636';
	const COMMON_GRAY = '#6b7280';
	const COMMON_GOLD = '#ffce45';

	const classByName = $derived.by(() => {
		const map = new Map<string, ClassTrait>();
		for (const cls of assets.classTraits.values()) map.set(cls.name, cls);
		return map;
	});
	function isSpecialClass(asset: ClassTrait | undefined): boolean {
		return asset?.is_special === true || asset?.class_type === 'special' || asset?.class_type === 'human';
	}
	function classThresholds(asset: ClassTrait | undefined): number[] {
		const raw = asset?.effect_schema ?? [];
		const nums = raw
			.map((b) => (typeof b.count === 'number' ? b.count : Number.parseInt(String(b.count), 10)))
			.filter((n) => Number.isFinite(n) && n > 0);
		return Array.from(new Set(nums)).sort((a, b) => a - b);
	}
	function traitColor(asset: ClassTrait | undefined, count: number): string {
		if (isSpecialClass(asset)) return SPECIAL_ORANGE;
		const thresholds = classThresholds(asset);
		if (thresholds.length === 0) return COMMON_GRAY;
		const met = thresholds.filter((t) => t <= count).length;
		const pct = Math.round((met / thresholds.length) * 100);
		return `color-mix(in srgb, ${COMMON_GOLD} ${pct}%, ${COMMON_GRAY})`;
	}

	const STATUS_LABEL = ['Pure', 'Tainted', 'Corrupt', 'Fallen'];
	const STATUS_COLOR = ['#4cba6a', '#ffba3d', '#a070e0', '#ff5b6e'];

	type RosterSpirit = { key: string; name: string; url: string | null; faceDown: boolean; augments: number };
	type TraitChip = { key: string; name: string; count: number; icon: string | null; color: string; special: boolean };
	type Standing = {
		seat: SeatColor;
		placement: number;
		name: string;
		accent: string;
		avatar: string | null;
		statusLabel: string;
		statusColor: string;
		vp: number;
		attack: number;
		barrier: number;
		maxBarrier: number;
		traits: TraitChip[];
		spirits: RosterSpirit[];
		isMe: boolean;
	};

	function buildStanding(seat: SeatColor): Standing {
		const player = room.players[seat];
		const guardian = player?.selectedGuardian ?? room.seats[seat]?.selectedGuardian ?? '';
		const statusLevel = Math.max(0, Math.min(3, player?.statusLevel ?? 0));

		// Awakened (face-up) class counts: spirit classes + placed augments on awakened hosts.
		const counts: Record<string, number> = {};
		for (const sp of player?.spirits ?? []) {
			if (sp.isFaceDown) continue;
			for (const [cls, n] of Object.entries(sp.classes ?? {})) {
				counts[cls] = (counts[cls] ?? 0) + (typeof n === 'number' ? n : 1);
			}
		}
		if (player) {
			for (const { className, awake } of augmentContributions(player)) {
				if (awake) counts[className] = (counts[className] ?? 0) + 1;
			}
		}
		const traits: TraitChip[] = Object.entries(counts)
			.map(([name, count]) => {
				const asset = classByName.get(name);
				return {
					key: name,
					name,
					count,
					icon: storageUrl(asset?.icon_png ?? null),
					color: traitColor(asset, count),
					special: isSpecialClass(asset)
				};
			})
			// Specials first, then by count desc, then name.
			.sort((a, b) => Number(b.special) - Number(a.special) || b.count - a.count || a.name.localeCompare(b.name));

		// Augment count per spirit slot (badges under the portrait).
		const augBySlot: Record<number, number> = {};
		for (const att of player?.spiritAugmentAttachments ?? []) {
			if (typeof att.className === 'string') augBySlot[att.spiritSlotIndex] = (augBySlot[att.spiritSlotIndex] ?? 0) + 1;
		}
		const spirits: RosterSpirit[] = [...(player?.spirits ?? [])]
			.sort((a, b) => a.slotIndex - b.slotIndex)
			.map((sp) => ({
				key: `${sp.slotIndex}:${sp.id}`,
				name: sp.name,
				url: sp.isFaceDown ? spiritBackImageUrl(sp.id) : (spiritImages.get(sp.id) ?? null),
				faceDown: sp.isFaceDown,
				augments: augBySlot[sp.slotIndex] ?? 0
			}));

		return {
			seat,
			placement: 0,
			name: room.seats[seat]?.displayName ?? seat,
			accent: seatAccent(seat),
			avatar: storageUrl(assets.guardianAssets.get(guardian)?.icon_image_path ?? null),
			statusLabel: STATUS_LABEL[statusLevel] ?? 'Pure',
			statusColor: STATUS_COLOR[statusLevel] ?? STATUS_COLOR[0],
			vp: player?.victoryPoints ?? 0,
			attack: player ? expectedAttack(player as unknown as PrivatePlayerState) : 0,
			barrier: Math.max(0, player?.barrier ?? 0),
			maxBarrier: Math.max(0, player?.maxBarrier ?? 0),
			traits,
			spirits,
			isMe: seat === mySeat
		};
	}

	// Final standings — placement mirrors the server's dense-rank rule
	// (winner = 1; the rest dense-ranked by VP desc, ties shared).
	const standings = $derived.by((): Standing[] => {
		const all = room.activeSeats.map(buildStanding);
		const winner = room.winnerSeat ? all.find((s) => s.seat === room.winnerSeat) ?? null : null;
		const rest = all
			.filter((s) => s !== winner)
			.sort((a, b) => b.vp - a.vp || a.seat.localeCompare(b.seat));
		if (winner) winner.placement = 1;
		let placement = winner ? 1 : 0;
		let lastVp: number | null = null;
		for (const s of rest) {
			if (lastVp === null || s.vp !== lastVp) {
				placement += 1;
				lastVp = s.vp;
			}
			s.placement = placement;
		}
		return [...(winner ? [winner] : []), ...rest];
	});

	const winner = $derived(standings.find((s) => s.placement === 1) ?? null);
	// Spotlight subject: the local player; for spectators, fall back to the winner.
	const me = $derived(standings.find((s) => s.isMe) ?? winner ?? standings[0] ?? null);
	const myWon = $derived((me?.placement ?? 0) === 1);
	const insights = $derived(mySeat ? buildPostgameInsights(room, mySeat) : null);
	let reviewOpen = $state(false);
	let shareBusy = $state(false);
	let shareError = $state<string | null>(null);
	let shareUrl = $state<string | null>(null);
	let payout = $state<MatchAward | null>(null);
	let promotedTo = $state<RankDefinition | null>(null);
	let payoutChecked = $state(false);
	let authoritative = $state<null | { rated: boolean; finalized: boolean; players: Array<{
		seatColor: SeatColor; placement: number; ratedPlacement: number; abandoned: boolean;
		rating: { ordinalDelta: number } | null }> }>(null);
	const myAuthoritative = $derived(authoritative?.players.find((player) => player.seatColor === mySeat) ?? null);

	$effect(() => {
		if (payoutChecked || room.status !== 'finished' || !mySeat || !me || !authoritative?.finalized) return;
		payoutChecked = true;
		if (myAuthoritative?.abandoned) return;
		// Display the deterministic formula immediately, but award nothing locally.
		// syncCosmetics reconciles the trusted match-result ledger on the server; a
		// forged/replayed client can neither mint currency nor claim twice.
		payout = calculateMatchAward({
			matchId: `${room.roomCode}:${mySeat}`,
			victoryPoints: me.vp,
			placement: me.placement,
			won: myWon,
			round: room.round
		});
		const previousRank = cosmetics.rank;
		void syncCosmetics().then(() => {
			if (cosmetics.rank.id !== previousRank.id) promotedTo = cosmetics.rank;
		}).catch(() => {});
	});

	function ordinal(n: number): string {
		const v = n % 100;
		const suf = v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
		return `${n}${suf}`;
	}

	// ── Rank score (ranked OpenSkill delta for THIS match) ──────────────────────
	type RankState =
		| { kind: 'loading' }
		| { kind: 'ranked'; delta: number }
		| { kind: 'unranked' }
		| { kind: 'none' };
	let rank = $state<RankState>({ kind: 'loading' });
	$effect(() => {
		if (!auth.user || !mySeat) {
			rank = { kind: 'unranked' };
			return;
		}
		let cancelled = false;
		rank = { kind: 'loading' };
		let tries = 0;
		const attempt = async () => {
			fetch(apiUrl(`/api/play/sessions/${encodeURIComponent(room.roomCode)}/postgame`), {
				headers: isCrossOrigin && auth.session?.access_token ? { Authorization: `Bearer ${auth.session.access_token}` } : {},
				credentials: isCrossOrigin ? 'include' : 'same-origin'
			}).then((response) => response.ok ? response.json() : Promise.reject(new Error('postgame unavailable')))
				.then((summary) => {
					if (cancelled) return;
					authoritative = summary;
					const player = summary.players?.find((entry: { seatColor: SeatColor }) => entry.seatColor === mySeat);
					if (!summary.finalized || !player) {
						if (tries++ < 4) setTimeout(attempt, 1500);
						else rank = { kind: 'none' };
						return;
					}
					if (summary.rated && player.rating) rank = { kind: 'ranked', delta: player.rating.ordinalDelta };
					else rank = { kind: 'unranked' };
				})
				.catch(() => {
					if (!cancelled) rank = { kind: 'none' };
				});
		};
		attempt();
		return () => {
			cancelled = true;
		};
	});
	function deltaLabel(d: number): string {
		const r = Math.round(d * 10) / 10;
		return `${r >= 0 ? '+' : ''}${r}`;
	}

	function placeAccent(p: number): string {
		if (p === 1) return 'var(--brand-amber, #ffba3d)';
		if (p === 2) return 'var(--brand-cyan, #5cdfff)';
		if (p === 3) return 'var(--brand-magenta-soft, #ff7fd9)';
		return 'var(--color-fog, #8d8aa1)';
	}

	// ── Component-lifetime / explicit-navigation fence ─────────────────────────
	// A held rematch response must never act on a screen the player has LEFT: the
	// closure fence (rematchContext) sees only uid/room-code/status — a plain
	// unmount, or an explicit Main Menu departure over the same props, passes it.
	// `departed` closes that gap: set on unmount and on any explicit navigation
	// away, it silences seeding, goto and error writes from every held response.
	// (The rematch lobby the server may have created stays live for the PARTY —
	// its members converge on it through their own postgame polls; only THIS
	// client's late jump is cancelled.)
	let departed = false;
	onDestroy(() => {
		departed = true;
	});

	function mainMenu() {
		// EXPLICIT navigation away: cancel any in-flight rematch's local effects
		// FIRST, so a rematch response racing this click cannot seed room B or drag
		// the player back off the route they just chose.
		departed = true;
		void goto('/play');
	}

	async function shareReplay() {
		if (shareBusy || !room.gameId) return;
		shareBusy = true;
		shareError = null;
		try {
			const result = await postPlayJson<{ code: string; url: string }>('/api/play/replays', {
				gameId: room.gameId,
				title: `${me?.name ?? 'Arc Spirits'} · round ${room.round}`
			});
			const apiRoot = apiUrl('/');
			shareUrl = new URL(result.url, /^https?:\/\//.test(apiRoot) ? apiRoot : window.location.origin).toString();
			if (navigator.share) await navigator.share({ title: 'Arc Spirits replay', url: shareUrl });
			else await navigator.clipboard.writeText(shareUrl);
		} catch (cause) {
			shareError = cause instanceof Error ? cause.message : 'Could not share this replay.';
		} finally {
			shareBusy = false;
		}
	}

	// ── Same-party rematch ───────────────────────────────────────────────────
	// The first player to tap creates + hosts the rematch lobby; everyone else's
	// tap joins it. While this screen is up we poll the postgame summary so a
	// lobby opened by ANY party member (web or Godot) is offered live.
	type RematchInfo = { roomCode: string; status: string; joinedCount: number; joinedNames: string[] };
	let rematchOpen = $state<RematchInfo | null>(null);
	let rematchBusy = $state(false);
	let rematchError = $state<string | null>(null);
	const REMATCH_POLL_MS = 3000;

	// Fences a rematch-scoped async result to the EXACT context it started under:
	// the same signed-in account (a token refresh keeps the uid; a durable account
	// change moves it) and the same finished room on screen. A poll or rematch
	// response captured under a previous account/room must act on nothing.
	function rematchContext() {
		const uid = auth.user?.id ?? null;
		const code = room.roomCode;
		return () => auth.user?.id === uid && room.roomCode === code && room.status === 'finished';
	}

	$effect(() => {
		if (room.status !== 'finished') return;
		const code = room.roomCode;
		const fresh = rematchContext();
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const poll = async () => {
			try {
				// Identity rides the account session (cookie same-origin; Bearer for the
				// cross-origin native shell) — the rematch status is member-only data.
				const headers: Record<string, string> = { Accept: 'application/json' };
				if (isCrossOrigin && auth.session?.access_token) {
					headers['Authorization'] = `Bearer ${auth.session.access_token}`;
				}
				const res = await fetch(apiUrl(`/api/play/sessions/${encodeURIComponent(code)}/postgame`), {
					headers,
					credentials: isCrossOrigin ? 'include' : 'same-origin'
				});
				// Fence both await boundaries (headers AND delayed body): a response for
				// a previous account or a departed room must not populate this screen.
				if (cancelled || !fresh()) return;
				if (res.ok) {
					const summary = (await res.json()) as { rematch?: RematchInfo | null };
					if (!cancelled && fresh()) rematchOpen = summary.rematch ?? null;
				}
			} catch {
				// Poll is best-effort; the button still works without it.
			}
			if (!cancelled && fresh()) timer = setTimeout(poll, REMATCH_POLL_MS);
		};
		void poll();
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	});

	// The rematch lifecycle contract (lifetime fence over unmount / Main Menu,
	// identity/room fence, seed rollback on a failed goto) lives framework-free in
	// runRematch (rematchAction.ts) — this component only adapts its closures.
	async function rematch() {
		if (rematchBusy) return;
		rematchBusy = true;
		rematchError = null;
		const fresh = rematchContext();
		try {
			await runRematch<ReturnType<typeof setActiveMember>>({
				post: () =>
					postPlayJson<{ roomCode: string; memberId: string }>(
						`/api/play/sessions/${encodeURIComponent(room.roomCode)}/rematch`,
						{}
					),
				fresh,
				departed: () => departed,
				seed: (memberId) => setActiveMember(memberId),
				restore: (prior, seededMemberId) => restoreActiveMember(prior, seededMemberId),
				navigate: (roomCode) => goto(`/play/${encodeURIComponent(roomCode)}`),
				onError: (message) => {
					rematchError = message;
				}
			});
		} finally {
			// Safe unconditionally: the busy guard means no NEWER rematch owns the flag.
			rematchBusy = false;
		}
	}
</script>

<section class="postgame" data-testid="postgame">
	<div class="pg-grid" data-testid="postgame-grid">
		<!-- ── Left: the scoreboard ──────────────────────────────────────────── -->
		<div class="board" data-testid="postgame-board">
			<div class="board-head">
				<span class="board-eyebrow">Final Standings</span>
				<h1 class="board-title">Scoreboard</h1>
			</div>

			<div class="sb">
				{#each standings as s (s.seat)}
					<div class="sb-row" class:me={s.isMe} class:first={s.placement === 1} style="--accent: {s.accent}; --place: {placeAccent(s.placement)}">
						<div class="row-id">
							<span class="rank">{s.placement}</span>
							<span class="av">
								{#if s.avatar}<img src={s.avatar} alt={s.name} loading="lazy" />{:else}<span class="av-fb">{s.name.slice(0, 1)}</span>{/if}
							</span>
							<div class="who">
								<span class="who-name" title={s.name}>{s.name}</span>
								<span class="who-status" style="color: {s.statusColor}">{s.statusLabel}</span>
								<div class="row-stats">
									<span class="num pts">{#if vpIcon}<img class="num-ic" src={vpIcon} alt="" />{/if}{s.vp}</span>
									<span class="num atk"><span class="num-glyph">⚔</span>{s.attack.toFixed(1)}</span>
									<span class="num bar">{#if barrierIcon}<img class="num-ic" src={barrierIcon} alt="" />{/if}{s.barrier}/{s.maxBarrier}</span>
								</div>
							</div>
						</div>

						<div class="loadout">
							<div class="traits">
								{#each s.traits as t (t.key)}
									<span class="chip" class:special={t.special} style="--chip: {t.color}" title="{t.name} {t.count}">
										{#if t.icon}<img class="chip-ic" src={t.icon} alt="" loading="lazy" />{/if}
										<span class="chip-n">{t.count}</span>
									</span>
								{:else}
									<span class="muted">No awakened traits</span>
								{/each}
							</div>
							<div class="spirits">
								{#each s.spirits as sp (sp.key)}
									<span class="sphere" class:down={sp.faceDown} title={sp.name}>
										{#if sp.url}<img src={sp.url} alt={sp.name} loading="lazy" />{:else}<span class="sphere-fb">{sp.name.slice(0, 1)}</span>{/if}
										{#if sp.augments > 0}
											<span class="aug-badges" aria-label="{sp.augments} augment{sp.augments === 1 ? '' : 's'}">
												{#each Array.from({ length: sp.augments }, (_, i) => i) as i (i)}<span class="aug-dot"></span>{/each}
											</span>
										{/if}
									</span>
								{:else}
									<span class="muted">No spirits</span>
								{/each}
							</div>
						</div>
					</div>
				{/each}
			</div>
		</div>

		<!-- ── Right: the victory emblem ─────────────────────────────────────── -->
		{#if me}
			<aside class="spotlight" style="--accent: {me.accent}; --place: {placeAccent(me.placement)}" aria-label="Your result" data-testid="postgame-spotlight">
				<span class="spot-eyebrow">{myWon ? 'Champion' : 'Your Result'}</span>
				<div class="victory-spirit"><LowPolySpiritStage moment={myWon ? 'victory' : 'reward'} guardianName={me.name} accent={me.accent} compact /></div>

				<!-- The player's icon, hex-cut, set inside the placement hexagon. -->
				<div class="medallion">
					<span class="med-glow" aria-hidden="true"></span>
					<span class="hex">
						<span class="hex-av">
							{#if me.avatar}<img src={me.avatar} alt={me.name} />{:else}<span class="hex-av-fb">{me.name.slice(0, 1)}</span>{/if}
						</span>
					</span>
					<span class="place-badge">{ordinal(me.placement)}</span>
				</div>

				<h2 class="hero-name" title={me.name}>{me.name}</h2>
				<span class="hero-verdict">{myAuthoritative?.abandoned
					? `Conceded · rated ${ordinal(myAuthoritative.ratedPlacement)}`
					: myWon ? 'Victory' : `Finished ${ordinal(me.placement)}`}</span>
				<span class="hero-status" style="--sc: {me.statusColor}">{me.statusLabel}</span>

				<div class="ladder" style="--rank-accent: {cosmetics.rank.accent}">
					<span class="ladder-name">{promotedTo ? `Promoted to ${promotedTo.name}` : cosmetics.rank.name}</span>
					<span class="ladder-xp">{cosmetics.progression.rankXp} account XP</span>
				</div>

				<div class="payout" aria-live="polite">
					<img src="/cosmetics/abyss-credit.png" alt="" />
					<span>{myAuthoritative?.abandoned ? 'No payout' : payout ? `+${payout.credits}` : cosmetics.progression.credits}</span>
					<small>{myAuthoritative?.abandoned ? 'Conceded match' : payout ? `+${payout.rankXp} XP` : 'Wallet'}</small>
				</div>

				{#if rank.kind === 'ranked'}
					<span class="hero-rank" class:up={rank.delta >= 0} class:down={rank.delta < 0}>
						Rank {deltaLabel(rank.delta)}
					</span>
				{:else if rank.kind === 'unranked'}
					<span class="hero-rank muted">Casual match</span>
				{:else if rank.kind === 'loading'}
					<span class="hero-rank muted">Rank…</span>
				{/if}
			</aside>
		{/if}
	</div>

	{#if reviewOpen && insights}
		<div class="review-scrim" role="presentation" onclick={() => (reviewOpen = false)}>
			<dialog
				open
				class="match-review"
				aria-labelledby="match-review-title"
				onclick={(event) => event.stopPropagation()}
				data-testid="postgame-review"
			>
				<div class="review-head">
					<div><span>Recorded evidence</span><h2 id="match-review-title">Match Review</h2></div>
					<button type="button" onclick={() => (reviewOpen = false)} aria-label="Close match review">×</button>
				</div>
				<div class="review-grid">
					{#each insights.observations as observation}
						<p>{observation}</p>
					{/each}
				</div>
				<div class="experiment"><strong>Possible next experiment</strong><p>{insights.nextExperiment}</p></div>
				<small>Observations use only the recorded board state. The experiment is not a claim that a different move would certainly change the result.</small>
			</dialog>
		</div>
	{/if}

	<footer class="pg-foot">
		{#if rematchError}<span class="rematch-err" role="alert">{rematchError}</span>{/if}
		{#if shareError}<span class="rematch-err" role="alert">{shareError}</span>{/if}
		{#if mySeat}
			<button type="button" class="pg-btn" onclick={() => (reviewOpen = true)} data-testid="postgame-review-open">Match Review</button>
			<button type="button" class="pg-btn" onclick={shareReplay} disabled={shareBusy || !room.gameId} data-testid="postgame-share-replay">
				{shareBusy ? 'Preparing…' : shareUrl ? 'Replay link ready' : 'Share Replay'}
			</button>
			<button
				type="button"
				class="pg-btn"
				class:primary={!!rematchOpen}
				onclick={rematch}
				disabled={rematchBusy}
				data-testid="postgame-rematch"
			>
				{#if rematchBusy}
					Rematch…
				{:else if rematchOpen}
					Join Rematch · {rematchOpen.joinedCount} in lobby
				{:else}
					Rematch
				{/if}
			</button>
		{/if}
		<button type="button" class="pg-btn" class:primary={!rematchOpen || !mySeat} onclick={mainMenu} data-testid="postgame-menu">Main Menu</button>
	</footer>
</section>

<style>
	.victory-spirit { width:100%; height:138px; margin:-12px 0 -34px; overflow:hidden; }
	.postgame {
		position: absolute;
		inset: 0;
		z-index: 50;
		display: flex;
		flex-direction: column;
		gap: clamp(0.7rem, 1.5vh, 1.1rem);
		padding: clamp(1rem, 2.6vw, 2rem) clamp(0.9rem, 2.6vw, 2.2rem) 1.1rem;
		box-sizing: border-box;
		overflow: hidden;
		background:
			radial-gradient(120% 80% at 18% -10%, rgba(60, 20, 80, 0.5), transparent 55%),
			radial-gradient(90% 70% at 100% 0%, rgba(20, 40, 90, 0.4), transparent 55%),
			linear-gradient(180deg, rgba(9, 5, 20, 0.98), rgba(5, 3, 13, 0.99));
		animation: pg-in 320ms cubic-bezier(0.2, 0.85, 0.3, 1) both;
	}
	.review-scrim {
		position: absolute; inset: 0; z-index: 70; display: grid; place-items: center;
		padding: 1rem; background: rgba(3, 2, 10, 0.82); backdrop-filter: blur(8px);
	}
	.match-review {
		width: min(720px, 94vw); max-height: min(620px, 88vh); overflow: auto;
		box-sizing: border-box; margin: 0; padding: clamp(1rem, 3vw, 1.8rem); border-radius: 18px;
		background: linear-gradient(155deg, rgba(25, 12, 54, 0.99), rgba(8, 5, 20, 0.99));
		border: 1px solid rgba(123, 29, 255, 0.7); box-shadow: 0 24px 80px rgba(0,0,0,.55);
	}
	.review-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
	.review-head span, .experiment strong { font: 700 .68rem/1 var(--font-display); letter-spacing: .18em; text-transform: uppercase; color: #65f3e1; }
	.review-head h2 { margin: .25rem 0 0; font: 400 clamp(1.5rem, 4vw, 2.4rem)/1 var(--font-display); text-transform: uppercase; }
	.review-head button { min-width: 44px; min-height: 44px; border: 0; border-radius: 50%; color: white; background: rgba(255,255,255,.08); font-size: 1.5rem; }
	.review-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .7rem; margin: 1.2rem 0; }
	.review-grid p, .experiment { margin: 0; padding: .9rem; border-radius: 12px; border: 1px solid rgba(255,255,255,.09); background: rgba(255,255,255,.045); color: #ece6f8; line-height: 1.45; }
	.experiment { border-color: rgba(101,243,225,.32); }
	.experiment p { margin: .45rem 0 0; }
	.match-review small { display: block; margin-top: .9rem; color: #aaa1bb; line-height: 1.4; }
	@media (max-width: 700px) { .review-grid { grid-template-columns: 1fr; } }
	@keyframes pg-in {
		from { opacity: 0; transform: scale(0.99); }
	}

	.pg-grid {
		flex: 1 1 auto;
		min-height: 0;
		display: grid;
		grid-template-columns: minmax(0, 1.7fr) minmax(260px, 0.8fr);
		gap: clamp(0.8rem, 2vw, 2rem);
	}

	/* ══ Left: scoreboard ════════════════════════════════════════════════════ */
	.board {
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}
	.board-head { display: flex; flex-direction: column; gap: 0.1rem; flex: 0 0 auto; }
	.board-eyebrow {
		font-family: var(--font-display);
		font-size: 0.66rem;
		letter-spacing: 0.34em;
		text-transform: uppercase;
		color: var(--brand-magenta-soft, #ff7fd9);
	}
	.board-title {
		margin: 0;
		font-family: var(--font-display);
		font-size: clamp(1.5rem, 3vw, 2.3rem);
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: #fff;
		text-shadow: 0 0 26px rgba(255, 120, 220, 0.28);
	}

	.sb {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 9px;
		padding-right: 4px;
	}

	/* A tall player row: identity (~38%) + loadout (~62%). */
	.sb-row {
		display: grid;
		grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.55fr);
		align-items: center;
		gap: clamp(10px, 1.6vw, 22px);
		padding: clamp(10px, 1.4vh, 16px) clamp(12px, 1.4vw, 18px);
		border-radius: 13px;
		background: linear-gradient(90deg, color-mix(in srgb, var(--place) 11%, rgba(255, 255, 255, 0.03)), rgba(255, 255, 255, 0.022));
		border: 1px solid rgba(255, 255, 255, 0.06);
		border-left: 4px solid var(--place);
	}
	.sb-row.first {
		background: linear-gradient(90deg, color-mix(in srgb, var(--place) 20%, rgba(255, 255, 255, 0.035)), rgba(255, 255, 255, 0.022));
		box-shadow: 0 0 22px color-mix(in srgb, var(--place) 20%, transparent);
	}
	.sb-row.me {
		border-color: color-mix(in srgb, var(--accent) 60%, transparent);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent);
	}

	.row-id { display: flex; align-items: center; gap: clamp(8px, 1vw, 14px); min-width: 0; }
	.rank {
		flex: 0 0 auto;
		width: 1.5em;
		text-align: center;
		font-family: var(--font-display);
		font-size: clamp(1.5rem, 2.4vw, 2.1rem);
		font-weight: 800;
		line-height: 1;
		color: var(--place);
	}
	.av {
		width: clamp(48px, 4.4vw, 60px);
		height: clamp(48px, 4.4vw, 60px);
		border-radius: 50%;
		overflow: hidden;
		flex: 0 0 auto;
		background: var(--color-crypt, #1a1029);
		display: grid;
		place-items: center;
		box-shadow: 0 0 0 2px var(--accent);
	}
	.av img { width: 100%; height: 100%; object-fit: cover; }
	.av-fb { font-family: var(--font-display); color: #fff; font-size: 1.2rem; }
	.who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	.who-name {
		font-family: var(--font-display);
		font-size: clamp(0.9rem, 1.3vw, 1.1rem);
		color: #fff;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.who-status {
		font-size: 0.62rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}
	.row-stats { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 3px; }
	.num {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-family: var(--font-display);
		font-size: 0.92rem;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.num-glyph { font-size: 0.78em; opacity: 0.85; }
	.num-ic { width: 16px; height: 16px; object-fit: contain; }
	.num.pts { color: var(--brand-amber, #ffba3d); }
	.num.atk { color: var(--brand-coral, #ff7a59); }
	.num.bar { color: var(--brand-cyan, #5cdfff); }

	/* Loadout: traits above a big row of spirit spheres. */
	.loadout { display: flex; flex-direction: column; gap: 9px; min-width: 0; }
	.traits { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		padding: 2px 6px 2px 3px;
		border-radius: 6px;
		background: color-mix(in srgb, var(--chip) 16%, rgba(0, 0, 0, 0.35));
		border: 1px solid color-mix(in srgb, var(--chip) 55%, transparent);
		color: color-mix(in srgb, var(--chip) 35%, #fff 65%);
	}
	/* Class icons render as a flat white silhouette. */
	.chip-ic { width: 16px; height: 16px; object-fit: contain; filter: brightness(0) invert(1); }
	.chip-n { font-family: var(--font-display); font-size: 0.74rem; font-variant-numeric: tabular-nums; }

	/* Spirits are hexagonal art — show them RAW (no circle, no crop). */
	.spirits { display: flex; flex-wrap: wrap; align-items: center; gap: 3px; }
	.sphere {
		position: relative;
		width: clamp(63px, 6vw, 88px);
		height: clamp(63px, 6vw, 88px);
		flex: 0 0 auto;
		display: grid;
		place-items: center;
	}
	.sphere img { width: 100%; height: 100%; object-fit: contain; }
	.sphere.down { filter: grayscale(0.55) brightness(0.7); }
	.sphere-fb { font-family: var(--font-display); color: #fff; font-size: 1.3rem; }
	.aug-badges { position: absolute; left: 50%; bottom: 4px; transform: translateX(-50%); display: inline-flex; gap: 2px; }
	.aug-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--brand-amber, #ffba3d);
		box-shadow: 0 0 3px rgba(0, 0, 0, 0.85);
	}
	.muted { color: var(--color-whisper, #6a6680); font-size: 0.78rem; }

	/* ══ Right: victory emblem (no card chrome) ══════════════════════════════ */
	.spotlight {
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		gap: 0.5rem;
		padding: 0.5rem;
	}
	.spot-eyebrow {
		font-family: var(--font-display);
		font-size: 0.7rem;
		letter-spacing: 0.34em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--place) 60%, #fff 40%);
	}

	/* ── Signature: the player's icon hex-cut inside the placement hexagon ───── */
	.medallion {
		position: relative;
		width: clamp(150px, 18vw, 224px);
		aspect-ratio: 1;
		display: grid;
		place-items: center;
		margin: 0.3rem 0 0.6rem;
		flex: 0 0 auto;
	}
	.med-glow {
		position: absolute;
		inset: -22%;
		border-radius: 50%;
		background: conic-gradient(from 0deg, transparent, color-mix(in srgb, var(--place) 65%, transparent), transparent 55%, color-mix(in srgb, var(--place) 38%, transparent), transparent);
		filter: blur(12px);
		opacity: 0.75;
		animation: spin 9s linear infinite;
	}
	@keyframes spin {
		to { transform: rotate(360deg); }
	}
	.hex {
		position: relative;
		width: 100%;
		height: 100%;
		display: grid;
		place-items: center;
		clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
		background: linear-gradient(155deg, color-mix(in srgb, var(--place) 95%, #fff 5%), color-mix(in srgb, var(--place) 45%, #1c0f24));
		filter: drop-shadow(0 0 24px color-mix(in srgb, var(--place) 45%, transparent));
	}
	.hex-av {
		width: 90%;
		height: 90%;
		display: grid;
		place-items: center;
		overflow: hidden;
		clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
		background: var(--color-crypt, #160d24);
	}
	.hex-av img { width: 100%; height: 100%; object-fit: cover; }
	.hex-av-fb { font-family: var(--font-display); font-size: 3.4rem; color: #fff; }
	.place-badge {
		position: absolute;
		bottom: -2%;
		left: 50%;
		transform: translateX(-50%);
		padding: 3px 14px;
		border-radius: 999px;
		font-family: var(--font-display);
		font-size: 0.82rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-void, #0c0518);
		background: var(--place);
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5), 0 0 16px color-mix(in srgb, var(--place) 55%, transparent);
	}

	.hero-name {
		margin: 0.3rem 0 0;
		font-family: var(--font-display);
		font-size: clamp(1.4rem, 2.6vw, 2.1rem);
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: #fff;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.hero-verdict {
		font-family: var(--font-display);
		font-size: 0.84rem;
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: var(--place);
	}
	.hero-status {
		font-size: 0.64rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--sc);
		padding: 2px 11px;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--sc) 45%, transparent);
		background: color-mix(in srgb, var(--sc) 12%, transparent);
	}
	.ladder {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3px;
		margin-top: 0.35rem;
	}
	.ladder :global(.rank-emblem.large) {
		width: clamp(92px, 12vw, 150px);
		height: clamp(92px, 12vw, 150px);
	}
	.ladder-name {
		font-family: var(--font-display);
		font-size: 0.95rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--rank-accent) 54%, #fff);
	}
	.ladder-xp {
		font-family: var(--font-mono);
		font-size: 0.7rem;
		color: var(--color-fog);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.payout {
		display: inline-grid;
		grid-template-columns: auto auto;
		grid-template-rows: auto auto;
		align-items: center;
		column-gap: 7px;
		margin-top: 0.2rem;
		padding: 7px 13px;
		border-radius: 999px;
		border: 1px solid rgba(255, 186, 61, 0.48);
		background: rgba(255, 186, 61, 0.1);
	}
	.payout img {
		grid-row: 1 / 3;
		width: 30px;
		height: 30px;
		object-fit: contain;
	}
	.payout span {
		font-family: var(--font-display);
		font-size: 1.15rem;
		line-height: 1;
		color: var(--brand-amber);
	}
	.payout small {
		font-family: var(--font-mono);
		font-size: 0.64rem;
		color: var(--color-fog);
		text-transform: uppercase;
	}
	.hero-rank {
		margin-top: 0.35rem;
		font-family: var(--font-display);
		font-size: 0.78rem;
		letter-spacing: 0.08em;
		font-variant-numeric: tabular-nums;
		color: #fff;
	}
	.hero-rank.up { color: #4cba6a; }
	.hero-rank.down { color: var(--brand-coral, #ff7a59); }
	.hero-rank.muted { color: var(--color-whisper, #8d8aa1); letter-spacing: 0.14em; text-transform: uppercase; font-size: 0.66rem; }

	/* ══ Footer ══════════════════════════════════════════════════════════════ */
	.pg-foot {
		flex: 0 0 auto;
		display: flex;
		justify-content: center;
		gap: 12px;
		padding-top: 2px;
	}
	.pg-btn {
		font-family: var(--font-display);
		font-size: 0.85rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		padding: 11px 30px;
		border-radius: 999px;
		cursor: pointer;
		transition: transform 120ms ease, box-shadow 140ms ease, filter 140ms ease;
		/* Secondary (non-primary) footer action — same silhouette, quiet chrome. */
		color: var(--color-mist, #d9d6ea);
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid rgba(255, 255, 255, 0.22);
	}
	.pg-btn:hover { transform: translateY(-1px); }
	.pg-btn:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
	.pg-btn:disabled { opacity: 0.6; cursor: wait; transform: none; }
	.rematch-err {
		align-self: center;
		color: var(--brand-coral, #ff7a59);
		font-size: 0.72rem;
		letter-spacing: 0.06em;
	}
	.pg-btn.primary {
		color: var(--color-void, #0c0518);
		background: var(--brand-amber, #ffba3d);
		border: 1px solid var(--brand-amber, #ffba3d);
		box-shadow: 0 0 20px rgba(255, 186, 61, 0.4);
	}
	.pg-btn.primary:hover { box-shadow: 0 0 28px rgba(255, 186, 61, 0.6); }

	/* ══ Responsive ══════════════════════════════════════════════════════════ */
	@media (max-width: 880px) {
		.pg-grid {
			grid-template-columns: minmax(0, 1fr);
			grid-auto-rows: min-content;
			overflow-y: auto;
		}
		.spotlight { order: -1; }
		.sb { overflow: visible; }
	}
	@media (max-width: 560px) {
		.sb-row { grid-template-columns: minmax(0, 1fr); row-gap: 10px; }
	}

	@media (prefers-reduced-motion: reduce) {
		.postgame { animation: none; }
		.med-glow { animation: none; }
	}
</style>

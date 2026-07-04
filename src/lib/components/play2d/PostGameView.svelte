<script lang="ts">
	import { goto } from '$app/navigation';
	import { auth } from '$lib/auth/auth.svelte';
	import { fetchMyMatchHistory } from '$lib/supabase';
	import { claimMatchAward, getCosmeticsState } from '$lib/stores/cosmetics.svelte';
	import type { getAssetState } from '$lib/stores/assetStore.svelte';
	import type { MatchAward, RankDefinition } from '$lib/cosmetics/progression';
	import type { PrivatePlayerState, SeatColor, SpectatorProjection } from '$lib/play/types';
	import type { ClassTrait } from '$lib/types';
	import { expectedAttack } from '$lib/play/combat';
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
	let payout = $state<MatchAward | null>(null);
	let promotedTo = $state<RankDefinition | null>(null);
	let payoutChecked = $state(false);

	$effect(() => {
		if (payoutChecked || room.status !== 'finished' || !mySeat || !me) return;
		payoutChecked = true;
		const result = claimMatchAward({
			matchId: `${room.roomCode}:${mySeat}`,
			victoryPoints: me.vp,
			placement: me.placement,
			won: myWon,
			round: room.round
		});
		if (result.claimed) {
			payout = result.award;
			if (result.currentRank.id !== result.previousRank.id) promotedTo = result.currentRank;
		}
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
		const uid = auth.user?.id ?? null;
		if (!uid) {
			rank = { kind: 'unranked' };
			return;
		}
		let cancelled = false;
		rank = { kind: 'loading' };
		// Identify THIS match among recent history (the result is written server-side at
		// finish, so it may not be there for a moment — and the newest row could briefly
		// be a PRIOR game). Match on my seat + winner + my final VP, retrying until it lands.
		const myVp = standings.find((s) => s.isMe)?.vp ?? null;
		const isThisMatch = (m: { mySeat: string; winnerSeat: string | null; myVictoryPoints: number }) =>
			m.mySeat === mySeat &&
			(m.winnerSeat ?? null) === (room.winnerSeat ?? null) &&
			(myVp == null || m.myVictoryPoints === myVp);
		let tries = 0;
		const attempt = () => {
			fetchMyMatchHistory(uid, 6)
				.then((rows) => {
					if (cancelled) return;
					const match = rows.find(isThisMatch);
					if (!match) {
						if (tries++ < 4) setTimeout(attempt, 1500);
						else rank = { kind: 'none' };
						return;
					}
					if (match.ratingDelta != null) rank = { kind: 'ranked', delta: match.ratingDelta };
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

	function mainMenu() {
		void goto('/play');
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
				<span class="hero-verdict">{myWon ? 'Victory' : `Finished ${ordinal(me.placement)}`}</span>
				<span class="hero-status" style="--sc: {me.statusColor}">{me.statusLabel}</span>

				<div class="ladder" style="--rank-accent: {cosmetics.rank.accent}">
					<span class="ladder-name">{promotedTo ? `Promoted to ${promotedTo.name}` : cosmetics.rank.name}</span>
					<span class="ladder-xp">{cosmetics.progression.rankXp} ladder XP</span>
				</div>

				<div class="payout" aria-live="polite">
					<img src="/cosmetics/abyss-credit.png" alt="" />
					<span>{payout ? `+${payout.credits}` : cosmetics.progression.credits}</span>
					<small>{payout ? `+${payout.rankXp} XP` : 'Wallet'}</small>
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

	<footer class="pg-foot">
		<button type="button" class="pg-btn primary" onclick={mainMenu} data-testid="postgame-menu">Main Menu</button>
	</footer>
</section>

<style>
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
	}
	.pg-btn:hover { transform: translateY(-1px); }
	.pg-btn:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
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

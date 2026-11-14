<script lang="ts">
	// Trends: how each spirit, class, origin, guardian, rune or relic, Navigation Power, monster
	// and strategy did in the finished games, and Stats (VP by Max Barrier, average damage or
	// initiative at a round's end), one row per (game, seat) from the importer
	// (scripts/local-game/import-agent-games.ts). Table style of the original stats pages.
	import { onMount } from 'svelte';
	import HexGrid from '$lib/components/HexGrid.svelte';
	import ClassInfo from '$lib/components/ClassInfo.svelte';
	import InfoText from '$lib/components/InfoText.svelte';
	import SpiritInfo from '$lib/components/SpiritInfo.svelte';
	import { SPIRIT_GROUPS, spiritGroup, type SpiritGroup, explorerLinks, fetchModelStandings, fetchStrategyDefinitions, fetchTrendSeats, runLabel, runsOf, type ModelStanding, type StrategyDefinition, type TrendSeat } from '$lib/explorer';
	import { usableImage } from '$lib/explorerImages.svelte';
	import { gameImageUrl } from '$lib/storageImages';
	import { getAssetState, getSpiritAsset, loadAssets } from '$lib/stores/assetStore.svelte';

	type Kind = 'models' | 'boards' | 'spirits' | 'classes' | 'origins' | 'guardians' | 'items' | 'powers' | 'monsters' | 'strategies' | 'stats';
	const KINDS: { id: Kind; label: string; of: (s: TrendSeat) => string[] }[] = [
		{
			id: 'spirits',
			label: 'Spirits',
			of: (s) => (s.final_spirits ?? []).filter((x) => !x.isFaceDown && spiritGroup(x.cost, Object.keys(x.origins ?? {}).length) === group).map((x) => x.name)
		},
		{ id: 'classes', label: 'Classes', of: (s) => (s.final_classes ?? []).filter((c) => classGroupOf(c) === classGroup) },
		{ id: 'origins', label: 'Origins', of: (s) => originRows(s) },
		{ id: 'guardians', label: 'Guardians', of: (s) => [s.selected_character] },
		{ id: 'items', label: 'Runes & Relics', of: (s) => s.items ?? [] },
		{ id: 'powers', label: 'Powers', of: (s) => s.powers ?? [] },
		{ id: 'monsters', label: 'Monsters', of: (s) => (s.monster_fights ?? []).filter((f) => f.killed && inTier(f.difficulty)).map((f) => f.name) },
		{
			id: 'strategies',
			label: 'Strategies',
			of: (s) => {
				const x = stratView === 'played' ? s.played_strategy : s.strategy;
				return x ? [x] : [];
			}
		},
		{ id: 'models', label: 'Models', of: () => [] },
		{ id: 'boards', label: 'Winning boards', of: () => [] },
		{ id: 'stats', label: 'Stats', of: () => [] }
	];

	type SortKey =
		| 'cls' | 'name' | 'games' | 'win' | 'vp' | 'place' | 'held' | 'awake' | 'uses'
		| 'origin' | 'final' | 'diff' | 'barrier' | 'kept' | 'fights' | 'fightWin' | 'dmg' | 'lost' | 'toKill';
	interface Stat {
		/** The row's key; `label` is shown when the key is not a name. */
		name: string;
		label?: string;
		games: number;
		win: number;
		/** Lower bound of the win rate (Wilson, 95%): a few games cannot outrank many. */
		sure: number;
		/** Spirits: average rounds on the board and awake, over every seat that ever had it. */
		held?: number;
		awake?: number;
		id?: string;
		/** Classes: average logged ability uses per seat that ended with the class. */
		uses?: number;
		/** Origins: the origin, its peak count (5 = 5 or more), relic gained, average final count. */
		origin?: string;
		peak?: number;
		relic?: string;
		final?: number;
		/** Monsters: Abyss deck and Barrier, cards kept, fights (won, sure as for Win %), averages. */
		difficulty?: number | null;
		barrier?: number;
		kept?: number;
		fights?: number;
		fightWin?: number;
		fightSure?: number;
		dmg?: number;
		lost?: number;
		toKill?: number;
		vp: number;
		place: number;
	}

	let seats = $state<TrendSeat[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let kind = $state<Kind>('spirits');
	let group = $state<SpiritGroup>('world');
	// Classes: the data editor's groups by class_type: 'normal' = Generic, 'human' = Hero (the
	// classes of the six Hero spirits, and only theirs), the rest = Special.
	type ClassGroup = 'generic' | 'special' | 'hero';
	const CLASS_GROUPS: { id: ClassGroup; label: string }[] = [
		{ id: 'generic', label: 'Generic' },
		{ id: 'special', label: 'Special' },
		{ id: 'hero', label: 'Hero' }
	];
	let classGroup = $state<ClassGroup>('generic');
	// Origins: by default each seat counts once, under its highest origin (ties: each).
	let highestOnly = $state(true);
	// Monsters: every Abyss deck, or one.
	let tier = $state(0);
	const inTier = (d: number | null) => tier === 0 || d === tier;
	// Strategies: as played (judged from the game, when that file exists) or as assigned.
	let strategyDefs = $state<StrategyDefinition[]>([]);
	let strategyChoice = $state<'played' | 'assigned'>('played');
	const stratView = $derived(strategyDefs.length ? strategyChoice : 'assigned');
	const strategyDef = (id: string) => strategyDefs.find((d) => d.id === id);
	let run = $state('all');
	let version = $state('all');
	let compare = $state('');
	let sortKey = $state<SortKey>('win');
	let sortAsc = $state(false);

	const runs = $derived(runsOf(seats));
	// Data versions, newest first, named by the day of their first game.
	const versions = $derived.by(() => {
		const first = new Map<string, string>();
		for (const s of seats) {
			if (!s.version) continue;
			const at = s.ended_at ?? '';
			if (!first.has(s.version) || at < first.get(s.version)!) first.set(s.version, at);
		}
		return [...first]
			.sort((a, b) => b[1].localeCompare(a[1]))
			.map(([id, at]) => {
				const d = new Date(at);
				const day = Number.isNaN(d.getTime()) ? '' : ` · ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
				return { id, label: `${id.slice(0, 7)}${day}` };
			});
	});

	// Assigned strategies are the league agents: that view shows the league whatever the run filter says.
	const assignedOnly = $derived(kind === 'strategies' && stratView === 'assigned');
	const inFilter = (s: TrendSeat, v: string) =>
		s.verified && (assignedOnly ? !!s.strategy : run === 'all' || s.run === run) && (v === 'all' || s.version === v);

	/** Origins: a seat's rows, "<origin>|<peak, 3-5>|<relic: yes, no or ''>", for peaks of 3 or more. */
	function originRows(s: TrendSeat): string[] {
		const reached = Object.entries(s.origin_counts ?? {}).filter(([, o]) => o.peak >= 3);
		const top = Math.max(0, ...reached.map(([, o]) => o.peak));
		return reached
			.filter(([, o]) => !highestOnly || o.peak === top)
			.map(([name, o]) => `${name}|${Math.min(o.peak, 5)}|${o.relic === null ? '' : o.relic ? 'yes' : 'no'}`);
	}

	function wilson(wins: number, n: number): number {
		const z = 1.96;
		const p = wins / n;
		return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
	}

	function stats(v: string): Map<string, Stat> {
		const of = KINDS.find((k) => k.id === kind)!.of;
		const out = new Map<string, Stat>();
		for (const s of seats) {
			if (!inFilter(s, v)) continue;
			for (const name of new Set(of(s))) {
				const e = out.get(name) ?? { name, games: 0, win: 0, sure: 0, vp: 0, place: 0 };
				e.games++;
				if (Number(s.placement) === 1) e.win++;
				e.vp += Number(s.victory_points);
				e.place += Number(s.placement);
				out.set(name, e);
			}
		}
		for (const e of out.values()) {
			e.sure = wilson(e.win, e.games);
			e.win = (100 * e.win) / e.games;
			e.vp /= e.games;
			e.place /= e.games;
		}
		if (kind === 'spirits') {
			const sum = new Map<string, { id: string; seats: number; rounds: number; awake: number }>();
			for (const s of seats) {
				if (!inFilter(s, v)) continue;
				for (const h of s.spirit_rounds ?? []) {
					if (spiritGroup(h.cost, h.origins) !== group) continue;
					const e = sum.get(h.name) ?? { id: h.id, seats: 0, rounds: 0, awake: 0 };
					e.seats++;
					e.rounds += h.rounds;
					e.awake += h.awake;
					sum.set(h.name, e);
				}
			}
			for (const [name, h] of sum) {
				const e = out.get(name) ?? { name, games: 0, win: 0, sure: -1, vp: 0, place: 0 };
				Object.assign(e, { id: h.id, held: h.rounds / h.seats, awake: h.awake / h.seats });
				out.set(name, e);
			}
		}
		if (kind === 'classes') {
			const total = new Map<string, number>();
			const logged = new Set<string>();
			for (const s of seats) {
				if (!inFilter(s, v)) continue;
				for (const [cls, n] of Object.entries(s.class_uses ?? {})) {
					logged.add(cls);
					if ((s.final_classes ?? []).includes(cls)) total.set(cls, (total.get(cls) ?? 0) + n);
				}
			}
			for (const e of out.values()) if (logged.has(e.name)) e.uses = (total.get(e.name) ?? 0) / e.games;
		}
		if (kind === 'origins') {
			const finals = new Map<string, number>();
			for (const s of seats) {
				if (!inFilter(s, v)) continue;
				for (const key of originRows(s)) finals.set(key, (finals.get(key) ?? 0) + (s.origin_counts?.[key.split('|')[0]]?.final ?? 0));
			}
			for (const e of out.values()) {
				const [origin, peak, relic] = e.name.split('|');
				Object.assign(e, { origin, peak: Number(peak), relic, final: (finals.get(e.name) ?? 0) / e.games });
				e.label = `${origin} ${peak === '5' ? '5+' : peak}`;
			}
		}
		if (kind === 'monsters') {
			const sum = new Map<string, { difficulty: number | null; barrier: number; kept: number; fights: number; won: number; dealt: number; lost: number; kills: number; nth: number }>();
			const of = (name: string, difficulty: number | null) => {
				const e = sum.get(name) ?? { difficulty, barrier: 0, kept: 0, fights: 0, won: 0, dealt: 0, lost: 0, kills: 0, nth: 0 };
				sum.set(name, e);
				return e;
			};
			for (const s of seats) {
				if (!inFilter(s, v)) continue;
				for (const k of s.monsters_kept ?? []) if (inTier(k.difficulty)) of(k.name, k.difficulty).kept++;
				for (const f of s.monster_fights ?? []) {
					if (!inTier(f.difficulty) || !f.fought) continue;
					const e = of(f.name, f.difficulty);
					e.barrier = f.barrier;
					e.fights++;
					e.dealt += f.dealt;
					e.lost += f.lost;
					if (f.killed) {
						e.won++;
						e.nth += f.nth;
					}
				}
			}
			for (const [name, m] of sum) {
				const e = out.get(name) ?? { name, games: 0, win: 0, sure: -1, vp: 0, place: 0 };
				Object.assign(e, {
					difficulty: m.difficulty,
					barrier: m.barrier || undefined,
					kept: m.kept,
					fights: m.fights,
					fightWin: m.fights ? (100 * m.won) / m.fights : undefined,
					fightSure: m.fights ? wilson(m.won, m.fights) : -1,
					dmg: m.fights ? m.dealt / m.fights : undefined,
					lost: m.fights ? m.lost / m.fights : undefined,
					toKill: m.won ? m.nth / m.won : undefined
				});
				out.set(name, e);
			}
		}
		if (kind === 'strategies' && stratView === 'played') for (const e of out.values()) e.label = strategyDef(e.name)?.name ?? e.name;
		return out;
	}

	const MIN_GAMES = 5; // fewer games: the row is dimmed and shows no difference
	const base = $derived(compare && compare !== version && versions.length > 1 ? stats(compare) : null);
	const rows = $derived.by(() => {
		const dir = sortAsc ? 1 : -1;
		const label = (r: Stat) => r.label ?? r.name;
		return [...stats(version).values()].sort((a, b) => {
			if (sortKey === 'name') return dir * label(a).localeCompare(label(b));
			if (sortKey === 'origin')
				return dir * (a.origin ?? '').localeCompare(b.origin ?? '') || (b.peak ?? 0) - (a.peak ?? 0) || (b.relic ?? '').localeCompare(a.relic ?? '');
			if (sortKey === 'diff') return dir * ((a.difficulty ?? 0) - (b.difficulty ?? 0) || (a.barrier ?? 0) - (b.barrier ?? 0)) || a.name.localeCompare(b.name);
			if (sortKey === 'fightWin') return dir * ((a.fightSure ?? -1) - (b.fightSure ?? -1)) || (b.fights ?? 0) - (a.fights ?? 0);
			if (sortKey === 'cls') return dir * classOfSpirit(a.id).localeCompare(classOfSpirit(b.id)) || a.name.localeCompare(b.name);
			const by = sortKey === 'win' ? a.sure - b.sure : (a[sortKey] ?? -1) - (b[sortKey] ?? -1);
			return dir * by || b.games - a.games || a.name.localeCompare(b.name);
		});
	});
	// Stats: VP by a combat number (stat_rounds, written by the importer) at a round's end.
	type StatKey = 'max_barrier' | 'attack' | 'initiative';
	const STAT_KEYS: { id: StatKey; label: string }[] = [
		{ id: 'max_barrier', label: 'Max Barrier' },
		{ id: 'attack', label: 'Average damage' },
		{ id: 'initiative', label: 'Initiative' }
	];
	const STAT_AT = [5, 10, 15, 0]; // 0 = end of game
	const STAT_MIN = 5; // seats per bucket
	let statKey = $state<StatKey>('max_barrier');
	let statAt = $state(10);
	let statGuardian = $state('all');
	const statLabel = $derived(STAT_KEYS.find((k) => k.id === statKey)!.label);
	const guardianNames = $derived([...new Set(seats.filter((s) => s.verified).map((s) => s.selected_character).filter(Boolean))].sort());
	interface StatBucket { label: string; seats: number; vp: number; win: number }
	const statView = $derived.by(() => {
		if (kind !== 'stats') return null;
		const pts: { x: number; vp: number; win: boolean }[] = [];
		let early = 0; // the game ended before the round
		let noData = 0;
		for (const s of seats) {
			if (!inFilter(s, version) || (statGuardian !== 'all' && s.selected_character !== statGuardian)) continue;
			const list = s.stat_rounds ?? [];
			if (!list.length) {
				noData++;
				continue;
			}
			const at = statAt ? list.find((r) => r.round === statAt) : list[list.length - 1];
			if (!at) {
				if (list[list.length - 1].round < statAt) early++;
				else noData++;
				continue;
			}
			const x = at[statKey];
			if (x === null || x === undefined) noData++;
			else pts.push({ x, vp: Number(s.victory_points), win: Number(s.placement) === 1 });
		}
		// Least squares: VP = a + slope · stat.
		const n = pts.length;
		const mx = pts.reduce((a, p) => a + p.x, 0) / (n || 1);
		const my = pts.reduce((a, p) => a + p.vp, 0) / (n || 1);
		const sxx = pts.reduce((a, p) => a + (p.x - mx) ** 2, 0);
		const slope = n > 1 && sxx > 0 ? pts.reduce((a, p) => a + (p.x - mx) * (p.vp - my), 0) / sxx : null;
		// Whole-number buckets; sparse tails (and gaps) merge until each has STAT_MIN seats.
		const byValue = new Map<number, typeof pts>();
		for (const p of pts) {
			const v = Math.round(p.x);
			byValue.set(v, [...(byValue.get(v) ?? []), p]);
		}
		const xs = [...byValue.keys()].sort((a, b) => a - b);
		const size = (g: number[]) => g.reduce((a, v) => a + byValue.get(v)!.length, 0);
		const groups: number[][] = [];
		let i = 0;
		let j = xs.length - 1;
		const low: number[] = [];
		while (i <= j && size(low) < STAT_MIN) low.push(xs[i++]);
		const high: number[] = [];
		while (j >= i && size(high) < STAT_MIN) high.unshift(xs[j--]);
		if (low.length) groups.push(low);
		let cur: number[] = [];
		for (let k = i; k <= j; k++) {
			cur.push(xs[k]);
			if (size(cur) >= STAT_MIN) {
				groups.push(cur);
				cur = [];
			}
		}
		high.unshift(...cur);
		if (high.length) {
			if (size(high) >= STAT_MIN || !groups.length) groups.push(high);
			else groups[groups.length - 1].push(...high);
		}
		const buckets: StatBucket[] = groups.map((g, gi) => {
			const ps = g.flatMap((v) => byValue.get(v)!);
			const lo = g[0];
			const hi = g[g.length - 1];
			const label = lo === hi ? `${lo}` : groups.length > 1 && gi === 0 ? `≤${hi}` : groups.length > 1 && gi === groups.length - 1 ? `${lo}+` : `${lo}–${hi}`;
			return { label, seats: ps.length, vp: ps.reduce((a, p) => a + p.vp, 0) / ps.length, win: (100 * ps.filter((p) => p.win).length) / ps.length };
		});
		return { n, slope, early, noData, buckets, maxVp: Math.max(0, ...buckets.map((b) => b.vp)) };
	});

	const gameCount = $derived(new Set(seats.filter((s) => inFilter(s, version)).map((s) => s.game_id)).size);

	// Winning boards: the winner's final board of every game in the filter, newest first.
	const assets = getAssetState();
	const spiritImages = $derived.by(() => {
		const map = new Map<string, string>();
		for (const [id, asset] of assets.spiritAssets) {
			const url = usableImage(gameImageUrl(asset.game_print_image_path || asset.art_raw_image_path));
			if (url) map.set(id, url);
		}
		return map;
	});
	const boards = $derived(
		kind !== 'boards'
			? []
			: seats
					.filter((s) => inFilter(s, version) && Number(s.placement) === 1)
					.sort((a, b) => (b.ended_at ?? '').localeCompare(a.ended_at ?? ''))
					.map((s) => ({ seat: s, faceDown: (s.final_spirits ?? []).filter((sp) => sp.isFaceDown).map((sp) => sp.slotIndex) }))
	);

	// Models: the harness's standings per run (benchmark first), by entrant or by model.
	type ModelKey = 'name' | 'games' | 'win' | 'avg_vp' | 'avg_place' | 'rating' | 'seconds_per_call';
	let standings = $state<ModelStanding[]>([]);
	// '' = the newest run (by its latest finished game); a click picks another.
	let modelRun = $state('');
	const runLatest = $derived.by(() => {
		const latest = new Map<string, string>();
		for (const s of seats) if (s.run && s.ended_at && s.ended_at > (latest.get(s.run) ?? '')) latest.set(s.run, s.ended_at);
		return latest;
	});
	let modelMode = $state<'entrant' | 'model'>('entrant');
	let modelSort = $state<ModelKey>('rating');
	let modelAsc = $state(false);
	// Newest run first (by its latest finished game).
	const modelRuns = $derived(runsOf(standings).sort((a, b) => (runLatest.get(b) ?? '').localeCompare(runLatest.get(a) ?? '')));
	const modelRows = $derived.by(() => {
		const dir = modelAsc ? 1 : -1;
		const val = (r: ModelStanding) => (modelSort === 'win' ? wilson(r.wins, r.games) : modelSort === 'name' ? 0 : r[modelSort]);
		return standings
			.filter((r) => r.run === (modelRuns.includes(modelRun) ? modelRun : modelRuns[0]) && r.mode === modelMode)
			.sort((a, b) => (modelSort === 'name' ? dir * a.name.localeCompare(b.name) : dir * (val(a) - val(b)) || b.rating - a.rating));
	});
	function sortModels(key: ModelKey) {
		if (modelSort === key) modelAsc = !modelAsc;
		else {
			modelSort = key;
			modelAsc = key === 'name' || key === 'avg_place' || key === 'seconds_per_call';
		}
	}

	function sortBy(key: SortKey) {
		if (sortKey === key) sortAsc = !sortAsc;
		else {
			sortKey = key;
			sortAsc = ['name', 'cls', 'place', 'origin', 'diff', 'toKill'].includes(key);
		}
	}
	// A tab opens on its own order: origins by origin and peak, monsters by difficulty.
	function openKind(k: Kind) {
		kind = k;
		sortKey = k === 'origins' ? 'origin' : k === 'monsters' ? 'diff' : 'win';
		sortAsc = k === 'origins' || k === 'monsters';
	}
	// Rows with fewer than MIN_GAMES seats (monsters: fights) are dimmed.
	const sampleOf = (r: Stat) => (kind === 'monsters' ? (r.fights ?? 0) : r.games);
	const num = (v: number | undefined, digits: number) => (v === undefined ? '–' : v.toFixed(digits));
	const classTypes = $derived(new Map([...assets.classTraits.values()].map((c) => [c.name, c.class_type])));
	const classGroupOf = (name: string): ClassGroup => {
		const t = classTypes.get(name);
		return t === 'normal' ? 'generic' : t === 'human' ? 'hero' : 'special';
	};
	const classesOfSpirit = (id: string | undefined) => {
		void assets.spiritAssets.size;
		return id ? (getSpiritAsset(id)?.traits.classes.map((c) => c.name) ?? []) : [];
	};
	// A spirit's class(es), from the card data.
	const classOfSpirit = (id: string | undefined) => {
		void assets.spiritAssets.size;
		return id ? (getSpiritAsset(id)?.traits.classes.map((c) => c.name).join(', ') ?? '') : '';
	};
	const signed = (d: number, digits: number) => `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(digits)}`;

	async function load() {
		loading = true;
		error = null;
		try {
			[seats, standings, strategyDefs] = await Promise.all([fetchTrendSeats(), fetchModelStandings(), fetchStrategyDefinitions()]);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to fetch trends';
		} finally {
			loading = false;
		}
	}
	onMount(() => {
		void loadAssets();
		load();
	});
</script>

<svelte:head>
	<title>Trends | Arc Spirits</title>
</svelte:head>

{#snippet delta(r: Stat, b: Stat | undefined, key: 'win' | 'vp' | 'place', digits: number)}
	{#if base}
		{@const d = b && r.games >= MIN_GAMES && b.games >= MIN_GAMES ? r[key] - b[key] : null}
		<span class="delta" class:better={d !== null && (key === 'place' ? d < 0 : d > 0)} class:worse={d !== null && (key === 'place' ? d > 0 : d < 0)}>
			{d === null ? '' : signed(d, digits)}
		</span>
	{/if}
{/snippet}

{#snippet th(key: SortKey, label: string, num = true)}
	<th class="th" class:num>
		<button type="button" class="th-btn" class:on={sortKey === key} onclick={() => sortBy(key)}>{label}</button>
	</th>
{/snippet}

<div class="page">
	<div class="controls">
		<div class="tabs-underline">
			{#each KINDS as k (k.id)}
				<button class="tab-btn" class:active={kind === k.id} onclick={() => openKind(k.id)}>{k.label}</button>
			{/each}
		</div>
		{#if kind === 'spirits'}
			<div class="tabs-underline">
				{#each SPIRIT_GROUPS as g (g.id)}
					<button class="tab-btn" class:active={group === g.id} onclick={() => (group = g.id)}>{g.label}</button>
				{/each}
			</div>
		{/if}
		{#if kind === 'classes'}
			<div class="tabs-underline">
				{#each CLASS_GROUPS as g (g.id)}
					<button class="tab-btn" class:active={classGroup === g.id} onclick={() => (classGroup = g.id)}>{g.label}</button>
				{/each}
			</div>
		{/if}
		{#if kind === 'origins'}
			<div class="tabs-underline">
				<button class="tab-btn" class:active={highestOnly} onclick={() => (highestOnly = true)}>Highest origin only</button>
				<button class="tab-btn" class:active={!highestOnly} onclick={() => (highestOnly = false)}>Every origin at 3+</button>
			</div>
		{/if}
		{#if kind === 'monsters'}
			<div class="tabs-underline">
				{#each [0, 1, 2, 3] as t (t)}
					<button class="tab-btn" class:active={tier === t} onclick={() => (tier = t)}>{t ? `Difficulty ${t}` : 'All'}</button>
				{/each}
			</div>
		{/if}
		{#if kind === 'strategies' && strategyDefs.length}
			<div class="tabs-underline">
				<button class="tab-btn" class:active={stratView === 'played'} onclick={() => (strategyChoice = 'played')}>Played</button>
				<button class="tab-btn" class:active={stratView === 'assigned'} onclick={() => (strategyChoice = 'assigned')}>Assigned</button>
			</div>
		{/if}
		{#if kind === 'stats'}
			<div class="filters">
				<div class="tabs-underline">
					{#each STAT_KEYS as k (k.id)}
						<button class="tab-btn" class:active={statKey === k.id} onclick={() => (statKey = k.id)}>{k.label}</button>
					{/each}
				</div>
				<div class="tabs-underline">
					{#each STAT_AT as at (at)}
						<button class="tab-btn" class:active={statAt === at} onclick={() => (statAt = at)}>{at ? `Round ${at}` : 'End of game'}</button>
					{/each}
				</div>
				<select class="ctrl-select" bind:value={statGuardian} aria-label="Guardian">
					<option value="all">All guardians</option>
					{#each guardianNames as g (g)}<option value={g}>{g}</option>{/each}
				</select>
			</div>
		{/if}
		{#if kind === 'models'}
			<div class="filters">
				<div class="tabs-underline">
					{#each modelRuns as r (r)}
						<button class="tab-btn" class:active={(modelRuns.includes(modelRun) ? modelRun : modelRuns[0]) === r} onclick={() => (modelRun = r)}>{runLabel(r)}</button>
					{/each}
				</div>
				<div class="tabs-underline">
					<button class="tab-btn" class:active={modelMode === 'entrant'} onclick={() => (modelMode = 'entrant')}>By entrant</button>
					<button class="tab-btn" class:active={modelMode === 'model'} onclick={() => (modelMode = 'model')}>By model</button>
				</div>
			</div>
		{:else}
		<div class="filters">
			{#if runs.length > 1 && !assignedOnly}
				<div class="tabs-underline">
					<button class="tab-btn" class:active={run === 'all'} onclick={() => (run = 'all')}>All runs</button>
					{#each runs as r (r)}
						<button class="tab-btn" class:active={run === r} onclick={() => (run = r)}>{runLabel(r)}</button>
					{/each}
				</div>
			{/if}
			{#if versions.length > 1}
				<select class="ctrl-select" bind:value={version} aria-label="Data version">
					<option value="all">All data versions</option>
					{#each versions as v (v.id)}<option value={v.id}>{v.label}</option>{/each}
				</select>
				{#if kind !== 'boards' && kind !== 'stats'}
					<select class="ctrl-select" bind:value={compare} aria-label="Compare with a data version">
						<option value="">Compare with…</option>
						{#each versions.filter((v) => v.id !== version) as v (v.id)}<option value={v.id}>{v.label}</option>{/each}
					</select>
				{/if}
			{/if}
			<span class="count">{gameCount} games</span>
		</div>
		{/if}
	</div>

	{#if loading && seats.length === 0}
		<div class="msg"><div class="spin-ring"></div></div>
	{:else if error}
		<div class="msg">{error}</div>
	{:else if kind === 'models'}
		<div class="table-wrap">
			<table class="data-table">
				<thead>
					<tr class="thead-row">
						{#each [['name', modelMode === 'model' ? 'Model' : 'Entrant'], ['games', 'Games'], ['win', 'Win %'], ['avg_vp', 'Avg VP'], ['avg_place', 'Avg Place'], ['rating', 'Rating (95% range)'], ['seconds_per_call', 'Seconds per call']] as [key, label] (key)}
							<th class="th" class:num={key !== 'name'}>
								<button type="button" class="th-btn" class:on={modelSort === key} onclick={() => sortModels(key as ModelKey)}>{label}</button>
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each modelRows as r (r.id)}
						<tr class="td-row" class:few={r.games < MIN_GAMES}>
							<td class="td name">{r.name}</td>
							<td class="td num">{r.games}</td>
							<td class="td num"><span class="big">{r.games ? ((100 * r.wins) / r.games).toFixed(0) : 0}%</span> <span class="n">({r.games})</span></td>
							<td class="td num"><span class="big">{r.avg_vp.toFixed(1)}</span></td>
							<td class="td num">{r.avg_place.toFixed(2)}</td>
							<td class="td num"><span class="big">{r.rating.toFixed(0)}</span> <span class="n">({r.rating_lo.toFixed(0)}–{r.rating_hi.toFixed(0)})</span></td>
							<td class="td num">{r.seconds_per_call.toFixed(1)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else if kind === 'boards'}
		<div class="boards">
			{#each boards as b (`${b.seat.game_id}:${b.seat.player_color}`)}
				<a
					class="board"
					href={explorerLinks.game(b.seat.game_id, `?player=${encodeURIComponent(b.seat.player_color)}`)}
					title={`${b.seat.username} · ${b.seat.victory_points} VP`}
				>
					<HexGrid spirits={b.seat.final_spirits ?? []} spiritAssets={spiritImages} faceDownSlots={b.faceDown} />
				</a>
			{/each}
		</div>
	{:else if kind === 'stats' && statView}
		{#if statView.n === 0}
			<div class="msg">No finished games here yet.</div>
		{:else}
			<div class="count-rule stat-line">
				{#if statView.slope !== null}Each +1 {statLabel} ≈ {signed(statView.slope, 1)} VP (least-squares over {statView.n} seats){:else}{statView.n} seats{/if}{#if statView.early && statAt}<br />{statView.early} seats left out: the game ended before round {statAt}.{/if}{#if statView.noData}<br />{statView.noData} seats without data.{/if}
			</div>
			<div class="table-wrap">
				<table class="data-table">
					<thead>
						<tr class="thead-row">
							<th class="th"><span class="th-plain">{statLabel}</span></th>
							<th class="th num"><span class="th-plain">Seats</span></th>
							<th class="th num"><span class="th-plain">Avg VP</span></th>
							<th class="th"></th>
							<th class="th num"><span class="th-plain">Win %</span></th>
						</tr>
					</thead>
					<tbody>
						{#each statView.buckets as b (b.label)}
							<tr class="td-row">
								<td class="td name">{b.label}</td>
								<td class="td num">{b.seats}</td>
								<td class="td num"><span class="big">{b.vp.toFixed(1)}</span></td>
								<td class="td"><div class="winrate-bar"><div class="winrate-fill" style:width={`${statView.maxVp > 0 ? (100 * b.vp) / statView.maxVp : 0}%`}></div></div></td>
								<td class="td num">{b.win.toFixed(0)}%</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	{:else if rows.length === 0}
		<div class="msg">No finished games here yet.</div>
	{:else}
		<div class="table-wrap">
			<table class="data-table">
				<thead>
					<tr class="thead-row">
						{#if kind === 'origins'}
							{@render th('origin', 'Origin', false)}
							<th class="th"><span class="th-plain">Relic</span></th>
						{:else}
							{@render th('name', kind === 'monsters' ? 'Monster' : KINDS.find((k) => k.id === kind)!.label, false)}
						{/if}
						{#if kind === 'spirits'}{@render th('cls', 'Class', false)}{/if}
						{#if kind === 'monsters'}
							{@render th('diff', 'Difficulty')}
							{@render th('barrier', 'Barrier')}
							{@render th('kept', 'Kept')}
							{@render th('fights', 'Fights')}
							{@render th('fightWin', 'Fight win %')}
							{@render th('dmg', 'Avg damage')}
							{@render th('lost', 'Barrier lost')}
							{@render th('toKill', 'Fights to defeat')}
						{/if}
						{@render th('games', kind === 'monsters' ? 'Defeated by' : 'Games')}
						{@render th('win', 'Win %')}
						{@render th('vp', 'Avg VP')}
						{#if kind !== 'monsters'}{@render th('place', 'Avg Place')}{/if}
						{#if kind === 'origins'}{@render th('final', 'Final count')}{/if}
						{#if kind === 'spirits'}
							{@render th('held', 'Rounds held')}
							{@render th('awake', 'Rounds awake')}
						{:else if kind === 'classes'}
							{@render th('uses', 'Ability uses')}
						{/if}
					</tr>
				</thead>
				<tbody>
					{#each rows as r, i (r.name)}
						{@const b = base?.get(r.name)}
						{@const def = kind === 'strategies' && stratView === 'played' ? strategyDef(r.name) : undefined}
						<tr class="td-row" class:alt={i % 2 === 1} class:few={sampleOf(r) < MIN_GAMES}>
							<td class="td name">{r.label ?? r.name}{#if kind === 'spirits' && r.id}<SpiritInfo id={r.id} name={r.name} />{:else if kind === 'classes'}<ClassInfo name={r.name} />{:else if def}<InfoText name={def.name}>{#if def.description}<span class="line">{def.description}</span>{/if}{#if def.rule}<span class="line dim">{def.rule}</span>{/if}</InfoText>{/if}</td>
							{#if kind === 'origins'}<td class="td">{r.relic || '–'}</td>{/if}
							{#if kind === 'monsters'}
								<td class="td num">{r.difficulty ?? '–'}</td>
								<td class="td num">{r.barrier ?? '–'}</td>
								<td class="td num">{r.kept}</td>
								<td class="td num">{r.fights}</td>
								<td class="td num">{#if r.fightWin === undefined}–{:else}<span class="big">{r.fightWin.toFixed(0)}%</span> <span class="n">({r.fights})</span>{/if}</td>
								<td class="td num">{num(r.dmg, 1)}</td>
								<td class="td num">{num(r.lost, 1)}</td>
								<td class="td num">{num(r.toKill, 1)}</td>
							{/if}
							{#if kind === 'spirits'}<td class="td cls">{#each [...new Set(classesOfSpirit(r.id))] as c, ci (c)}{ci ? ' ' : ''}<span class="nowrap">{c}<ClassInfo name={c} /></span>{/each}</td>{/if}
							<td class="td num">{r.games}</td>
							{#if r.games === 0}
								<td class="td num">–</td><td class="td num">–</td>{#if kind !== 'monsters'}<td class="td num">–</td>{/if}
							{:else}
							<td class="td num"><span class="big">{r.win.toFixed(0)}%</span> <span class="n">({r.games})</span>{@render delta(r, b, 'win', 0)}</td>
							<td class="td num"><span class="big">{r.vp.toFixed(1)}</span>{@render delta(r, b, 'vp', 1)}</td>
							{#if kind !== 'monsters'}<td class="td num">{r.place.toFixed(2)}{@render delta(r, b, 'place', 2)}</td>{/if}
							{/if}
							{#if kind === 'origins'}<td class="td num">{num(r.final, 1)}</td>{/if}
							{#if kind === 'spirits'}
								<td class="td num">{r.held?.toFixed(1) ?? '–'}</td>
								<td class="td num">{r.awake?.toFixed(1) ?? '–'}</td>
							{:else if kind === 'classes'}
								<td class="td num">{r.uses?.toFixed(1) ?? '–'}</td>
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if kind === 'spirits'}
			<div class="count-rule">Win %, Avg VP and Avg Place: seats that ended the game with the spirit awake. Rounds held and awake: average over every seat that had the spirit at the end of any round.</div>
		{:else if kind === 'origins'}
			<div class="count-rule">Counted as the game counts for the origin rune (3) and relic (5): every spirit on the board with that origin, awake or face-down. Row = highest count in the game, {highestOnly ? 'each seat once, under its highest origin (a tie: under each)' : 'every origin a seat reached 3 in'}. Final count: average on the final board.</div>
		{:else if kind === 'monsters'}
			<div class="count-rule">AI games. Difficulty: the Abyss deck. Avg damage: Barrier the card lost per fight (it carries over to the next fight). Barrier lost: the player's, per fight. Defeated by, Win %, Avg VP: seats that defeated it.</div>
		{:else if kind === 'strategies'}
			<div class="count-rule">{stratView === 'played' ? 'Played: the strategy each seat played, judged from the game; all runs.' : 'Assigned: the strategy each league agent was told to play.'}</div>
		{:else if kind === 'classes'}
			<div class="count-rule">Ability uses: times the game logged the class's ability, per seat that ended with the class. – means the game never logs that class (a passive bonus, or not seen yet).</div>
		{/if}
	{/if}
</div>

<style>
	/* One screen: the table scrolls inside its panel, the page does not. */
	.page {
		height: 100%;
		width: 100%;
		padding: 10px 16px;
		display: flex;
		flex-direction: column;
		position: relative;
		z-index: 1;
	}
	.controls { display: flex; flex-direction: column; gap: 10px; margin-bottom: 12px; flex: none; }
	.filters { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
	.count { margin-left: auto; font-family: var(--font-mono); font-size: 0.75rem; color: var(--color-fog); }
	.ctrl-select {
		background: var(--color-shadow);
		border: 1px solid var(--color-mist);
		color: var(--color-bone);
		font-family: var(--font-body);
		font-size: 0.82rem;
		padding: 6px 10px;
		border-radius: 0;
	}
	.ctrl-select:focus { outline: none; border-color: var(--brand-magenta); }
	.msg { padding: 60px 20px; text-align: center; color: var(--color-fog); }
	.spin-ring {
		width: 36px; height: 36px; margin: 0 auto;
		border: 3px solid var(--color-mist); border-top-color: var(--brand-magenta);
		border-radius: 50%; animation: spin 1s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }

	/* The data editor's table. */
	.table-wrap { flex: 1; min-height: 0; overflow-y: auto; }
	.data-table { width: 100%; border-collapse: collapse; }
	.thead-row { position: sticky; top: 0; z-index: 1; background: var(--bg); }
	.th { padding: 0; text-align: left; border-bottom: 1px solid var(--line); }
	.th.num { text-align: right; }
	.th-btn { width: 100%; padding: 10px 8px 6px; background: none; border: 0; cursor: pointer; text-align: inherit; color: var(--dim); font-size: 12px; font-weight: 500; }
	.th-btn.on { color: var(--text); }
	.td { padding: 5px 8px; border-bottom: 1px solid var(--line); }
	.td.num { text-align: right; white-space: nowrap; }
	.td-row.few { opacity: 0.5; }
	.td.cls { color: var(--dim); }
	.nowrap { white-space: nowrap; margin-right: 6px; }
	.th-plain { display: block; padding: 10px 8px 6px; }
	.count-rule { flex: none; padding-top: 6px; font-size: 12px; color: var(--faint); }
	.n { color: var(--color-fog); font-size: 0.8rem; }
	.delta { display: inline-block; min-width: 3.4em; margin-left: 8px; font-family: var(--font-mono); font-size: 0.75rem; color: var(--color-fog); }
	.delta.better { color: var(--ok); }
	.delta.worse { color: var(--bad); }

	.boards {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
		gap: 10px;
		align-content: start;
	}
	.board { display: block; aspect-ratio: 1; padding: 6px; border: 1px solid var(--line); border-radius: 8px; }
	.board:hover { border-color: var(--brand-magenta); }

	/* Stats: the leaderboard's win-rate bar. */
	.stat-line { padding: 0 0 6px; }
	.winrate-bar { width: 120px; height: 2px; background: var(--color-mist); }
	.winrate-fill { height: 100%; background: var(--brand-magenta); }
</style>

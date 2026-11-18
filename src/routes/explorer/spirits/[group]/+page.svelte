<script lang="ts">
	// One list of spirits (Spirit World, Arcane Abyss or Heroes): the tier from desirability and
	// power together, the cost to awaken, and the two levels. A row is marked when the spirit is
	// too powerful (both levels High or better) or in the danger zone (wins far more than
	// average but is not picked much). The "i" after a name shows the spirit; after a class, its text.
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import ClassInfo from '$lib/components/ClassInfo.svelte';
	import SpiritInfo from '$lib/components/SpiritInfo.svelte';
	import { fetchBalance, type BalanceData, type BalanceSpirit } from '$lib/explorerBalance';
	import { getAssetState, loadAssets } from '$lib/stores/assetStore.svelte';

	const POOLS: Record<string, BalanceSpirit['pool']> = { world: 'Spirit World', arcane: 'Arcane Abyss', heroes: 'Heroes' };
	const REFRESH_MS = 60_000;
	const LEVELS = [0, 1, 2, 3, 4];

	let data = $state<BalanceData | null>(null);
	let error = $state<string | null>(null);

	const assets = getAssetState();
	const pool = $derived(POOLS[$page.params.group ?? ''] ?? 'Spirit World');
	const rows = $derived((data?.spirits ?? []).filter((s) => s.pool === pool));
	/** Spirit name → id, for the picture behind the "i". */
	const idByName = $derived(new Map([...assets.spiritAssets.entries()].map(([id, a]) => [a.name, id])));
	/** "Fighter×2" and "Cultivator, Cursed Spirit" → the class names. */
	const classesOf = (cls: string) => cls.split(', ').map((c) => ({ text: c, name: c.replace(/×\d+$/, '') }));

	async function load() {
		try {
			data = await fetchBalance();
			error = null;
		} catch (e) {
			if (!data) error = e instanceof Error ? e.message : 'Failed to load the balance data.';
		}
	}
	onMount(() => {
		void loadAssets();
		void load();
		const timer = setInterval(load, REFRESH_MS);
		return () => clearInterval(timer);
	});
</script>

<svelte:head><title>{pool} · Arc Spirits</title></svelte:head>

{#snippet level(word: string, value: number | null)}
	{#if value == null}
		<span class="dim">{word}</span>
	{:else}
		<span class="meter" aria-hidden="true">{#each LEVELS as k (k)}<i class:on={k <= value}></i>{/each}</span>{word}
	{/if}
{/snippet}

<div class="page">
	{#if error}
		<div class="msg">{error}</div>
	{:else if !data}
		<div class="msg">Loading…</div>
	{:else if rows.length === 0}
		<div class="msg">No spirits in this list yet.</div>
	{:else}
		<div class="table-wrap">
			<table class="data-table">
				<thead>
					<tr class="thead-row">
						<th class="th">Tier</th><th class="th">Spirit</th><th class="th">Class</th><th class="th">Cost to awaken</th><th class="th">Desirability</th><th class="th">Powerful</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as r (r.spirit)}
						{@const id = idByName.get(r.spirit)}
						<tr class:hot={r.flag === 'Too powerful'} class:watch={r.flag === 'Danger zone'}>
							<td class="td"><span class={`tier tier-${/^[SABCD]$/.test(r.tier) ? r.tier : 'none'}`}>{r.tier}</span></td>
							<td class="td name">{r.spirit}{#if id}<SpiritInfo {id} name={r.spirit} />{/if}</td>
							<td class="td cls">{#each classesOf(r.cls) as c (c.text)}<span class="nowrap">{c.text}<ClassInfo name={c.name} /></span>{/each}</td>
							<td class="td">{r.awaken_cost}</td>
							<td class="td">{@render level(r.desirability, r.desirability_level)}</td>
							<td class="td">{@render level(r.power, r.power_level)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<div class="count-rule">
			<span><i class="key hot"></i>Too powerful: desirability and power both High or better</span>
			<span><i class="key watch"></i>Danger zone: wins far more than average but is not picked much</span>
			<span>Tier combines desirability (picked when offered) and power (holders win more than an average seat)</span>
		</div>
	{/if}
</div>

<style>
	/* One screen: the table scrolls inside its panel, the page does not. */
	.page { height: 100%; width: 100%; padding: 10px 16px; display: flex; flex-direction: column; }
	.msg { padding: 60px 20px; text-align: center; color: var(--dim); }
	.table-wrap { flex: 1; min-height: 0; overflow-y: auto; }
	.data-table { width: 100%; max-width: 1100px; border-collapse: collapse; }
	.thead-row { position: sticky; top: 0; z-index: 1; background: var(--bg); }
	.th { padding: 10px 8px 6px; text-align: left; border-bottom: 1px solid var(--line); }
	.td { padding: 5px 8px; border-bottom: 1px solid var(--line); }
	.td.cls, .dim { color: var(--dim); }
	.nowrap { white-space: nowrap; margin-right: 6px; }

	tr.hot .td { background: color-mix(in srgb, var(--bad) 20%, transparent); }
	tr.watch .td { background: color-mix(in srgb, #e2b23c 20%, transparent); }
	.tier { display: inline-block; min-width: 1.7em; text-align: center; font-weight: 600; border-radius: 4px; padding: 0 5px; }
	.tier-S, .tier-A { background: color-mix(in srgb, var(--ok) 30%, transparent); }
	.tier-B, .tier-C { background: color-mix(in srgb, #e2b23c 30%, transparent); }
	.tier-D { background: color-mix(in srgb, var(--bad) 30%, transparent); }

	.meter { display: inline-flex; gap: 2px; margin-right: 7px; vertical-align: middle; }
	.page .meter i { display: block; width: 7px; height: 10px; border-radius: 1px; border: 1px solid var(--faint) !important; }
	.page .meter i.on { background: var(--text); border-color: var(--text) !important; }

	.count-rule { flex: none; padding-top: 6px; display: flex; flex-wrap: wrap; gap: 2px 16px; color: var(--faint); }
	.page .count-rule span { font-size: 12px !important; }
	.key { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; }
	.key.hot { background: color-mix(in srgb, var(--bad) 55%, transparent); }
	.key.watch { background: color-mix(in srgb, #e2b23c 55%, transparent); }
</style>

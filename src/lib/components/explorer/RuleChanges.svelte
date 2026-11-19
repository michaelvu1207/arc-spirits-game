<script lang="ts">
	// Game explorer: what a tested rule set changes from the live game, as printed text: class
	// abilities, awakening conditions, monster numbers by Difficulty and the other rules. The
	// cards and pictures elsewhere on the site are the live game's, so this is where the rules a
	// test game was played under can be read.
	import type { BalanceRuleChanges } from '$lib/explorerBalance';

	let { changes }: { changes: BalanceRuleChanges } = $props();

	const lines = (l: { count: string; text: string }[]) => (l.length > 1 ? l.map((b) => `${b.count}: ${b.text}`).join(' ') : (l[0]?.text ?? ''));
	const differs = (m: BalanceRuleChanges['monsters'][number]) => m.barrier !== m.barrier_live || m.hit !== m.hit_live || m.points !== m.points_live || m.first !== m.first_live;
</script>

{#snippet cell(now: string, live: string | undefined)}
	<td class="td num">{now}{#if live != null && live !== now}<div class="was">live: {live}</div>{/if}</td>
{/snippet}

<div class="rules">
	<div class="col">
		<div class="label">Abilities ({changes.classes.length} differ from the live game)</div>
		{#each changes.classes as c (c.name)}
			<div class="item">
				<b>{c.name}</b>
				<span>{lines(c.test)}</span>
				<span class="was">Live: {lines(c.live)}</span>
			</div>
		{:else}
			<div class="was">As in the live game.</div>
		{/each}
	</div>
	<div class="col">
		<div class="label">To awaken ({changes.spirits.length} differ)</div>
		{#each changes.spirits as s (s.name)}
			<div class="item">
				<b>{s.name}</b>
				<span>{s.test}</span>
				<span class="was">Live: {s.live}</span>
			</div>
		{:else}
			<div class="was">As in the live game.</div>
		{/each}
		<div class="label gap">Other rules</div>
		{#each changes.other as o (o)}
			<div class="item"><span>{o}</span></div>
		{:else}
			<div class="was">As in the live game.</div>
		{/each}
	</div>
	<div class="col">
		<div class="label">Monsters, lowest to highest card</div>
		<table class="mon">
			<thead>
				<tr><th class="th">Deck</th><th class="th num">Barrier</th><th class="th num">Hit</th><th class="th num">Points</th></tr>
			</thead>
			<tbody>
				{#each changes.monsters as m (m.group)}
					<tr class:same={!differs(m)}>
						<td class="td">{m.group}{#if m.first !== m.first_live}<div class="was">strikes first: {m.first.toLowerCase()} (live: {m.first_live?.toLowerCase()})</div>{/if}</td>
						{@render cell(m.barrier, m.barrier_live)}
						{@render cell(m.hit, m.hit_live)}
						{@render cell(m.points, m.points_live)}
					</tr>
				{/each}
			</tbody>
		</table>
		<div class="was">A grey "live" value under a number is what the card shows. No grey value: unchanged.</div>
	</div>
</div>

<style>
	.rules { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr) minmax(0, 0.9fr); gap: 6px 22px; }
	.col { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
	.rules .label { font-size: 12px !important; font-weight: 500; color: var(--dim); }
	.rules .label.gap { margin-top: 6px; }
	.item { display: grid; gap: 1px; }
	.rules .was { font-size: 12px !important; color: var(--faint); font-weight: 400; }
	.mon { width: 100%; border-collapse: collapse; }
	.th { padding: 3px 6px; text-align: left; border-bottom: 1px solid var(--line); }
	.td { padding: 4px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
	.th.num, .td.num { text-align: right; white-space: nowrap; }
	tr.same .td { color: var(--dim); }

	@media (max-width: 900px) {
		.rules { grid-template-columns: minmax(0, 1fr); }
	}
</style>

<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const escapeHtml = (text: string) =>
		text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	const inline = (text: string) => escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

	/** The change lists use a small, fixed Markdown subset (release.mjs): headings and two bullet levels. */
	function renderChanges(markdown: string): string {
		const out: string[] = [];
		let depth = 0;
		const close = (to: number) => {
			while (depth > to) {
				out.push('</ul>');
				depth--;
			}
		};
		for (const line of markdown.split('\n').slice(1)) {
			const bullet = /^(\s*)- (.*)$/.exec(line);
			if (bullet) {
				const level = bullet[1].length >= 2 ? 2 : 1;
				close(level);
				while (depth < level) {
					out.push('<ul>');
					depth++;
				}
				out.push(`<li>${inline(bullet[2])}</li>`);
				continue;
			}
			close(0);
			if (line.startsWith('## ')) out.push(`<h3>${inline(line.slice(3))}</h3>`);
			else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
		}
		close(0);
		return out.join('');
	}

	const date = (iso: string) =>
		new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
	const COUNT_LABELS: [string, string][] = [
		['hex_spirits', 'spirits'],
		['classes', 'classes'],
		['monsters_v2', 'monsters'],
		['guardians', 'guardians']
	];
</script>

<svelte:head>
	<title>Game versions · Arc Spirits</title>
</svelte:head>

<main class="versions">
	<a class="back" href="/play">← Play</a>
	<header>
		<div class="eyebrow">Arc Spirits</div>
		<h1>Game versions</h1>
		<p class="lede">
			The game on this site runs on one published data package at a time. Live now:
			<strong data-testid="live-version">{data.live}</strong>.
		</p>
	</header>

	{#each data.versions as v (v.version)}
		<section class="card" class:live={v.version === data.live} data-testid="package-{v.version}">
			<div class="head">
				<h2>{v.version}</h2>
				{#if v.version === data.live}<span class="badge">Live</span>{/if}
				<span class="when">{date(v.createdAt)}</span>
			</div>
			<p class="meta">
				{#each COUNT_LABELS as [key, label], i}
					{#if v.counts[key] != null}{i ? ' · ' : ''}{v.counts[key]} {label}{/if}
				{/each}
				{#if v.parent}<span> · replaces {v.parent}</span>{/if}
			</p>
			<!-- eslint-disable-next-line svelte/no-at-html-tags -- escaped above; fixed Markdown subset -->
			<div class="changes">{@html renderChanges(v.changes)}</div>
		</section>
	{/each}
</main>

<style>
	.versions {
		max-width: 760px;
		margin: 0 auto;
		padding: 2rem 1.25rem 4rem;
		color: #e8e3d8;
	}
	.back {
		color: #b9b2a3;
		text-decoration: none;
		font-size: 0.9rem;
	}
	.eyebrow {
		margin-top: 1.5rem;
		font-size: 0.75rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: #b9b2a3;
	}
	h1 {
		margin: 0.2rem 0 0.4rem;
		font-size: 2rem;
	}
	.lede {
		color: #cfc8b8;
		margin-bottom: 1.5rem;
	}
	.card {
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 12px;
		padding: 1rem 1.25rem;
		margin-bottom: 1rem;
		background: rgba(20, 18, 26, 0.72);
	}
	.card.live {
		border-color: rgba(240, 190, 90, 0.7);
	}
	.head {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
	}
	h2 {
		margin: 0;
		font-size: 1.3rem;
	}
	.badge {
		font-size: 0.7rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		padding: 0.1rem 0.5rem;
		border-radius: 999px;
		background: rgba(240, 190, 90, 0.2);
		color: #f0be5a;
	}
	.when {
		margin-left: auto;
		color: #b9b2a3;
		font-size: 0.85rem;
	}
	.meta {
		margin: 0.25rem 0 0.5rem;
		color: #b9b2a3;
		font-size: 0.85rem;
	}
	.changes :global(h3) {
		margin: 0.9rem 0 0.3rem;
		font-size: 1rem;
		color: #f0be5a;
	}
	.changes :global(ul) {
		margin: 0.1rem 0;
		padding-left: 1.2rem;
	}
	.changes :global(li) {
		margin: 0.1rem 0;
		font-size: 0.92rem;
		overflow-wrap: anywhere;
	}
	.changes :global(p) {
		margin: 0.3rem 0;
	}
</style>

<script lang="ts" module>
	export type GameIconName =
		| 'solo'
		| 'quick'
		| 'lobby'
		| 'guardians'
		| 'builder'
		| 'ranked'
		| 'back'
		| 'forward'
		| 'search'
		| 'refresh'
		| 'clear'
		| 'filter'
		| 'origin'
		| 'portal'
		| 'team'
		| 'synergy'
		| 'board'
		| 'account'
		| 'achievement'
		| 'history'
		| 'archive'
		| 'settings'
		| 'volume'
		| 'mute'
		| 'play'
		| 'close'
		| 'info'
		| 'warning'
		| 'lock'
		| 'spirit';

	const ICON_PATHS: Record<GameIconName, string[]> = {
		solo: [
			'M12 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
			'M6.5 20c.5-4 2.3-6.5 5.5-6.5s5 2.5 5.5 6.5',
			'm17 4 3 3-7.5 7.5-3.5.5.5-3.5L17 4Z'
		],
		quick: ['m13.5 2-8 11h6l-1 9 8-12h-6l1-8Z'],
		lobby: [
			'M8.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
			'M15.5 12a2.5 2.5 0 1 0 0-5',
			'M3 20c.3-4 2.2-6 5.5-6s5.2 2 5.5 6',
			'M15 14.5c3.5 0 5.5 1.8 6 5.5'
		],
		guardians: ['m4 9 3 2 5-7 5 7 3-2-1.5 9h-13L4 9Z', 'M7 16h10', 'M9 20h6'],
		builder: ['m14.5 5.5 4-2 2 2-2 4-2-2-6.5 6.5-2-2L16.5 8l-2-2.5Z', 'm3.5 18.5 2 2 8-8-2-2-8 8Z'],
		ranked: [
			'M7 4h10v3c0 4-2 6-5 6s-5-2-5-6V4Z',
			'M7 6H4c0 3 1 5 4 5M17 6h3c0 3-1 5-4 5',
			'M12 13v4M8 20h8M9 17h6'
		],
		back: ['m14.5 5-7 7 7 7'],
		forward: ['m9.5 5 7 7-7 7'],
		search: ['M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z', 'm15.5 15.5 4.5 4.5'],
		refresh: ['M20 7v5h-5', 'M18.5 16a8 8 0 1 1 .5-8.5L20 12'],
		clear: ['M4 7h16M9 3h6l1 4H8l1-4ZM7 7l1 14h8l1-14M10 11v6M14 11v6'],
		filter: ['M3 5h18l-7 8v6l-4 2v-8L3 5Z'],
		origin: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'm15.5 8.5-2 5-5 2 2-5 5-2Z'],
		portal: ['M12 3a9 9 0 1 0 9 9', 'M12 7a5 5 0 1 0 5 5', 'M12 11a1 1 0 1 0 1 1'],
		team: ['m12 3 8 4v5c0 5-3.3 8-8 10-4.7-2-8-5-8-10V7l8-4Z', 'm8.5 12 2.2 2.2 4.8-5'],
		synergy: [
			'm12 3 1.4 4.1L17 5l-1 4.2L20 10l-3.2 2.8L20 16l-4.2-.2L17 20l-3.6-2.1L12 22l-1.4-4.1L7 20l1-4.2L4 16l3.2-3.2L4 10l4.2-.8L7 5l3.6 2.1L12 3Z',
			'M12 9v6M9 12h6'
		],
		board: [
			'm8 3 4 2.3v4.5L8 12 4 9.8V5.3L8 3ZM16 12l4 2.3v4.5L16 21l-4-2.2v-4.5l4-2.3Z',
			'm16 3 4 2.3v4.5L16 12l-4-2.2V5.3L16 3Z'
		],
		account: ['M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z', 'M4.5 21c.5-4.8 3-7 7.5-7s7 2.2 7.5 7'],
		achievement: ['m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z'],
		history: ['M4 6v5h5', 'M5.5 17.5A9 9 0 1 0 4 11', 'M12 7v5l3 2'],
		archive: ['M4 7h16v14H4V7ZM3 3h18v4H3V3ZM9 11h6'],
		settings: ['M4 7h8M16 7h4M4 12h4M12 12h8M4 17h11M19 17h1', 'M14 5v4M10 10v4M17 15v4'],
		volume: ['M4 9v6h4l5 4V5L8 9H4Z', 'M16 9a5 5 0 0 1 0 6M18.5 6.5a8.5 8.5 0 0 1 0 11'],
		mute: ['M4 9v6h4l5 4V5L8 9H4ZM17 9l4 6M21 9l-4 6'],
		play: ['m8 4 12 8-12 8V4Z'],
		close: ['M5 5l14 14M19 5 5 19'],
		info: ['M12 10v8M12 6h.01', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z'],
		warning: ['m12 3 10 18H2L12 3ZM12 9v5M12 18h.01'],
		lock: ['M6 10h12v11H6V10ZM8.5 10V7.5a3.5 3.5 0 0 1 7 0V10M12 14v3'],
		spirit: [
			'M12 3c5 0 8 3.5 8 8.5V21l-3-2-2.5 2-2.5-2-2.5 2L8 19l-4 2v-9.5C4 6.5 7 3 12 3Z',
			'M8.5 11h.01M15.5 11h.01M9 15c2 1.3 4 1.3 6 0'
		]
	};
</script>

<script lang="ts">
	interface Props {
		name: GameIconName;
		size?: number | string;
		label?: string;
		strokeWidth?: number;
	}

	let { name, size = 20, label, strokeWidth = 1.8 }: Props = $props();
</script>

<svg
	class="game-icon"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width={strokeWidth}
	stroke-linecap="round"
	stroke-linejoin="round"
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
>
	{#each ICON_PATHS[name] as path}
		<path d={path} />
	{/each}
</svg>

<style>
	.game-icon {
		display: inline-block;
		flex: 0 0 auto;
		overflow: visible;
	}
</style>

<script lang="ts">
	import { page } from '$app/stores';
	import Game from '../../../admin/game/[id]/+page.svelte';

	// The viewer as a visitor sees it: no admin tag editor.
	const data = $derived({
		gameId: $page.params.id ?? '',
		isAdmin: false,
		taggingConfigError: null,
		compositionTagsByColor: {},
		tagOptions: []
	});
</script>

{#key data.gameId}
	<Game {data} explorer />
{/key}

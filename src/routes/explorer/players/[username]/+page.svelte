<script lang="ts">
	import { page } from '$app/stores';
	import Profile from '../../../admin/players/[username]/+page.svelte';
</script>

{#key $page.params.username}
	<Profile data={{ username: $page.params.username ?? '' }} explorer />
{/key}

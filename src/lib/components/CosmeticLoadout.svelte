<script lang="ts">
	import { onMount } from 'svelte';
	import { SHOP_ITEMS, type CosmeticItem } from '$lib/cosmetics/progression';
	import { buyItem, equipItem, getCosmeticsState, syncCosmetics } from '$lib/stores/cosmetics.svelte';
	import LowPolySpiritStage from '$lib/components/LowPolySpiritStage.svelte';

	const cosmetics = getCosmeticsState();
	let busy = $state<string | null>(null);
	let error = $state<string | null>(null);
	let ready = $state(false);

	onMount(() => {
		void syncCosmetics().then(() => (ready = true)).catch((reason) => {
			error = reason instanceof Error ? reason.message : 'Progression is unavailable.';
			ready = true;
		});
	});

	function equipped(item: CosmeticItem): boolean {
		const state = cosmetics.progression;
		switch (item.kind) {
			case 'border': return state.equippedBorderId === item.id;
			case 'banner': return state.equippedBannerId === item.id;
			case 'guardianSkin': return Object.values(state.equippedGuardianSkinIds).includes(item.id);
			case 'boardEnvironment': return state.equippedBoardEnvironmentId === item.id;
			case 'summonTrail': return state.equippedSummonTrailId === item.id;
			case 'cardFinish': return state.equippedCardFinishId === item.id;
			case 'nameplate': return state.equippedNameplateId === item.id;
			case 'emote': return state.equippedEmoteId === item.id;
			case 'victoryPose': return state.equippedVictoryPoseId === item.id;
			case 'profileScene': return state.equippedProfileSceneId === item.id;
		}
	}

	async function act(item: CosmeticItem) {
		if (busy || equipped(item)) return;
		busy = item.id; error = null;
		const owned = cosmetics.progression.ownedItemIds.includes(item.id);
		const result = owned ? await equipItem(item.id, item.targetGuardian) : await buyItem(item.id);
		if (!result.ok) error = result.message;
		busy = null;
	}
</script>

<section class="loadout" data-testid="cosmetic-loadout">
	<header>
		<div><span>Canonical progression</span><h2>Guardian Expression</h2></div>
		<div class="visual-preview"><LowPolySpiritStage moment="profile" guardianName="Your Guardian" accent="#ff2bc7" compact /></div>
		<div class="wallet"><strong>{cosmetics.progression.credits}</strong> Abyss Credits<br /><small>{cosmetics.progression.rankXp} account XP</small></div>
	</header>
	{#if error}<p class="loadout-error" role="alert">{error}</p>{/if}
	{#if cosmetics.progression.guardianMastery?.length}
		<div class="mastery" aria-label="Guardian mastery">
			{#each cosmetics.progression.guardianMastery as guardian (guardian.guardianName)}
				<span><strong>{guardian.guardianName}</strong> Lv {guardian.masteryLevel} · {guardian.masteryXp} XP · {guardian.wins}/{guardian.gamesPlayed} wins</span>
			{/each}
		</div>
	{/if}
	<div class="catalog" class:loading={!ready}>
		{#each SHOP_ITEMS as item (item.id)}
			{@const owned = cosmetics.progression.ownedItemIds.includes(item.id)}
			<article style="--accent:{item.accent}" data-testid="cosmetic-{item.id}">
				<div class="kind">{item.kind}</div><h3>{item.name}</h3><p>{item.description}</p>
				<button type="button" onclick={() => act(item)} disabled={!ready || !!busy || equipped(item)}>
					{busy === item.id ? 'Working…' : equipped(item) ? 'Equipped' : owned ? 'Equip' : `Buy · ${item.price}`}
				</button>
			</article>
		{/each}
	</div>
	<p class="trust">Currency, ownership, mastery, and equipment are reconciled from the authenticated account and trusted finished matches—not browser storage.</p>
</section>

<style>
	.loadout { padding: 1rem; border: 1px solid rgba(101,243,225,.22); border-radius: 16px; background: rgba(12,7,28,.78); }
	header { display:flex; justify-content:space-between; gap:1rem; align-items:flex-start; }
	.visual-preview{width:150px;height:96px;margin:-14px auto -8px;overflow:hidden}
	header span,.kind { color:#65f3e1; font:700 .65rem/1 var(--font-display); letter-spacing:.16em; text-transform:uppercase; }
	h2 { margin:.3rem 0 0; font:400 1.25rem/1 var(--font-display); text-transform:uppercase; }
	.wallet { text-align:right; color:#d8cfee; font-size:.75rem; }.wallet strong{color:#ffba3d;font-size:1.1rem}.wallet small{color:#9a8fb8}
	.mastery { display:flex; flex-wrap:wrap; gap:.45rem; margin:.9rem 0; }.mastery span{padding:.5rem .65rem;border-radius:999px;background:rgba(123,29,255,.13);border:1px solid rgba(123,29,255,.3);font-size:.72rem}
	.catalog { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.65rem; margin-top:1rem; }.catalog.loading{opacity:.55}
	article { display:flex; flex-direction:column; min-height:150px; padding:.8rem; border-radius:12px; border:1px solid color-mix(in srgb,var(--accent) 42%,transparent); background:color-mix(in srgb,var(--accent) 7%,rgba(255,255,255,.025)); }
	h3{margin:.35rem 0;font:400 .95rem/1.1 var(--font-display)} article p{flex:1;margin:.2rem 0 .7rem;color:#bdb4cb;font-size:.72rem;line-height:1.35}
	article button{min-height:44px;border-radius:9px;border:1px solid color-mix(in srgb,var(--accent) 50%,transparent);background:rgba(255,255,255,.06);color:#fff;font-family:var(--font-display);text-transform:uppercase} article button:disabled{opacity:.65}
	.loadout-error{color:#ff8fab}.trust{margin:.9rem 0 0;color:#8f86a3;font-size:.68rem;line-height:1.4}
	@media(max-width:620px){.catalog{grid-template-columns:1fr}header{flex-direction:column}.wallet{text-align:left}.visual-preview{align-self:center}}
</style>

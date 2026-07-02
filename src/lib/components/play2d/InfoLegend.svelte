<script lang="ts" module>
	export type InfoContextKey =
		| 'overview'
		| 'traits'
		| 'players'
		| 'composition'
		| 'spectator'
		| 'navigation'
		| 'destinationLocked'
		| 'destinationReveal'
		| 'realmEntry'
		| 'locationActions'
		| 'abyssActions'
		| 'draw'
		| 'combat'
		| 'reward'
		| 'actionResult'
		| 'encounter'
		| 'benefits'
		| 'awakening'
		| 'cleanup'
		| 'runeCleanup'
		| 'corruptionDiscard'
		| 'augmentPlacement'
		| 'abilityDecision'
		| 'waiting'
		| 'bags'
		| 'settings'
		| 'postgame';
</script>

<script lang="ts">
	import type { getAssetState } from '$lib/stores/assetStore.svelte';
	import type { DiceTier } from '$lib/play/types';
	import { DICE_TIER_ORDER, STATUS_LADDER, SPIRIT_LIMIT_BY_STATUS } from '$lib/play/types';
	import { DICE_TIER_FACES } from '$lib/play/combat';
	import { iconPoolUrl, storageUrl, statusAccent } from './helpers';

	interface Props {
		assets: ReturnType<typeof getAssetState>;
		context?: InfoContextKey;
		onClose: () => void;
	}
	let { assets, context = 'overview', onClose }: Props = $props();

	interface ScreenInfo {
		title: string;
		eyebrow: string;
		summary: string;
		tips: string[];
	}

	const SCREEN_INFO: Record<InfoContextKey, ScreenInfo> = {
		overview: {
			title: 'Game Guide',
			eyebrow: 'At a glance',
			summary:
				'Shared reference for the board icons, player status ladder, realm actions and attack dice.',
			tips: [
				'Victory Points decide the winner: the first player to 30 points wins.',
				'Potential absorbs combat damage before corruption lowers your status.',
				'Runes and relics awaken face-down spirits and are capped during Cleanup.'
			]
		},
		traits: {
			title: 'Traits Guide',
			eyebrow: 'Left screen',
			summary:
				"The trait panel summarizes the selected player's active class effects and class counts.",
			tips: [
				'Only awakened spirits contribute their class traits.',
				'Multiple copies stack when the trait text or engine allows it.',
				'Scouting another player also changes this panel to their traits.'
			]
		},
		players: {
			title: 'Players Guide',
			eyebrow: 'Right screen',
			summary:
				'The player list compares seats, score, status, potential and destination readiness.',
			tips: [
				'Clicking a player opens their spirit composition in the stage.',
				'Status color follows the Pure, Tainted, Corrupt and Fallen ladder.',
				'Destination and ready states help show who is still holding the phase.'
			]
		},
		composition: {
			title: 'Composition Guide',
			eyebrow: 'Player board',
			summary:
				'A composition shows the spirits a player has summoned, including awaken state, origin, classes and attached augments.',
			tips: [
				'Face-up spirits are awakened and active.',
				'Face-down spirits are summoned but inactive until their rune cost is paid.',
				'Spirit limits shrink as corruption deepens.'
			]
		},
		spectator: {
			title: 'Spectator Guide',
			eyebrow: 'Watching table',
			summary: 'Spectators see the live board without owning a seat or submitting commands.',
			tips: [
				'The realm backdrop follows the busiest committed destination.',
				'The player list is the fastest way to inspect each seat.',
				'Public board state is visible; hidden draws and choices remain private until resolved.'
			]
		},
		navigation: {
			title: 'Navigation Guide',
			eyebrow: 'Pick a realm',
			summary:
				'Navigation is where each seated player chooses the realm they will visit this round.',
			tips: [
				'Spirit World realms offer action cards such as Summon, Cultivate and Rest.',
				'Arcane Abyss is the monster route, with combat and monster rewards.',
				'Locked destinations reveal together when everyone is ready or the timer expires.'
			]
		},
		destinationLocked: {
			title: 'Locked Destination',
			eyebrow: 'Navigation',
			summary: 'Your current realm choice is locked and waiting for the table reveal.',
			tips: [
				'Unlocking returns you to the destination board while navigation is still open.',
				'Once destinations reveal, the round moves into the chosen realm.',
				'The destination determines the location music, actions and possible encounters.'
			]
		},
		destinationReveal: {
			title: 'Reveal Guide',
			eyebrow: 'Round reveal',
			summary: 'The reveal shows where each player committed before the round enters those realms.',
			tips: [
				'Players sharing a Spirit World realm may become encounter targets.',
				'Players at Arcane Abyss face the monster route instead.',
				'The reveal is informational; the next screen hosts the active choices.'
			]
		},
		realmEntry: {
			title: 'Realm Entry',
			eyebrow: 'Transition',
			summary: 'The board is moving from the reveal into your committed realm.',
			tips: [
				'Location actions become available once the transition settles.',
				'The active realm controls the backdrop, ambience and action set.',
				'Shared destinations can matter during the Encounter phase.'
			]
		},
		locationActions: {
			title: 'Location Actions',
			eyebrow: 'Spirit World',
			summary: 'Location is the main action phase for Spirit World realms.',
			tips: [
				'Summon actions add spirits to your board and may open a draw tray.',
				'Cultivate converts matching origins into runes.',
				'Rest grows your combat dice or potential through class effects.'
			]
		},
		abyssActions: {
			title: 'Abyss Actions',
			eyebrow: 'Monster route',
			summary: 'Arcane Abyss focuses on monster combat, abyss summons and kill rewards.',
			tips: [
				'Fight the Monster rolls your attack dice against the current monster.',
				'Damage can cost potential and trigger corruption.',
				'Monster kills award Victory Points plus reward-track picks.'
			]
		},
		draw: {
			title: 'Summon Guide',
			eyebrow: 'Draw tray',
			summary: 'A summon draw lets you choose spirits from a temporary hand.',
			tips: [
				'Spirit World summons usually arrive awakened.',
				'Arcane Abyss summons usually arrive face-down and need awakening later.',
				'Discarding the remaining draw closes the tray.'
			]
		},
		combat: {
			title: 'Combat Guide',
			eyebrow: 'Encounter',
			summary:
				'Combat rolls your attack dice and compares damage against the monster or player fight.',
			tips: [
				'Attack dice tiers get stronger from Basic to Arcane.',
				'Potential absorbs incoming damage before corruption applies.',
				'Combat can produce pending rewards or forced spirit discards.'
			]
		},
		reward: {
			title: 'Reward Guide',
			eyebrow: 'Claim rewards',
			summary:
				'Reward screens let you choose the gains earned from monster kills or action effects.',
			tips: [
				'Some rewards grant direct VP, runes, relics, potential or dice.',
				'Some rewards branch into another summon draw.',
				'Pick limits are enforced by the reward track shown on the screen.'
			]
		},
		actionResult: {
			title: 'Result Guide',
			eyebrow: 'Action result',
			summary:
				'The result view summarizes what the last action changed before returning to the action grid.',
			tips: [
				'Resource changes can include runes, relics, potential, dice and VP.',
				'Class effects may add extra grants after the base action resolves.',
				'Continue returns to the current phase once the result is reviewed.'
			]
		},
		encounter: {
			title: 'Encounter Guide',
			eyebrow: 'Shared realm',
			summary: 'Encounter handles player conflicts after destinations are revealed.',
			tips: [
				'Fallen players are Evil-aligned and may attack co-located Good players.',
				'Group attacks require eligible Evil players at that location to agree.',
				'Holding or passing skips the attack choice for your seat.'
			]
		},
		benefits: {
			title: 'Benefits Guide',
			eyebrow: 'Round rewards',
			summary: 'Benefits resolves passive gains and phase rewards before awakening choices.',
			tips: [
				'Review the main scene for any automatic grants or pending decisions.',
				'Class and status effects can influence what appears here.',
				'Committing means your seat is ready for the next step.'
			]
		},
		awakening: {
			title: 'Awakening Guide',
			eyebrow: 'Flip spirits',
			summary: 'Awakening spends runes and relics to turn face-down spirits face-up.',
			tips: [
				'Awakened spirits activate their class traits.',
				'Each face-down spirit lists the rune cost it needs.',
				'Relics satisfy special rune requirements when a cost calls for them.'
			]
		},
		cleanup: {
			title: 'Cleanup Guide',
			eyebrow: 'Round end',
			summary: 'Cleanup prepares your board and carried resources for the next navigation phase.',
			tips: [
				'Rune and relic carry is limited between rounds.',
				'Pending corruption or augment placement can block cleanup until resolved.',
				'Committing cleanup readies your seat for the next round.'
			]
		},
		runeCleanup: {
			title: 'Rune Cleanup',
			eyebrow: 'Carry limit',
			summary: 'You are holding more runes or relics than the carry limit allows.',
			tips: [
				'Keep up to four rune-bearing materials between rounds.',
				'Discard extras before committing Cleanup.',
				'Prioritize runes that match face-down awaken costs on your board.'
			]
		},
		corruptionDiscard: {
			title: 'Corruption Discard',
			eyebrow: 'Forced discard',
			summary:
				'Corruption can shrink your spirit limit and force you to discard spirits down to the new cap.',
			tips: [
				'The status ladder below shows each corruption level and board size.',
				'Discarding removes the spirit from your composition.',
				'Fallen cannot corrupt further; excess corruption forces discards instead.'
			]
		},
		augmentPlacement: {
			title: 'Augment Placement',
			eyebrow: 'Class token',
			summary: 'Spirit Augments attach a class token to one of your spirits.',
			tips: [
				'The augment is active while its host spirit is awakened.',
				'Face-down hosts keep the augment dormant until they awaken.',
				'Unplaced augments can be forfeited to clear the step.'
			]
		},
		abilityDecision: {
			title: 'Ability Decision',
			eyebrow: 'Class prompt',
			summary: 'Some class effects ask you to choose an option before the phase can continue.',
			tips: [
				'Decision cards are generated by your active traits and current board state.',
				'Only legal options for the current timing are shown.',
				'Resolving the choice returns you to the interrupted phase.'
			]
		},
		waiting: {
			title: 'Waiting Guide',
			eyebrow: 'Ready',
			summary:
				'Your seat is ready and the table is waiting for the remaining players or server step.',
			tips: [
				'The player list shows which seats are still active in the phase.',
				'You can inspect traits, compositions and public resources while waiting.',
				'The next phase starts when all required seats are ready.'
			]
		},
		bags: {
			title: 'Spirit Bags',
			eyebrow: 'Reference',
			summary: 'The bag view shows the remaining Spirit World and Arcane Abyss spirit pools.',
			tips: [
				'Bag counts help estimate what a future summon can still draw.',
				'Spirit World and Arcane Abyss have separate pools.',
				'Draws remove spirits from their source bag when summoned.'
			]
		},
		settings: {
			title: 'Settings Guide',
			eyebrow: 'Menu',
			summary: 'Settings collect table utilities such as spirit bags, audio and graphics controls.',
			tips: [
				'Spirit bags open the remaining draw-pool reference.',
				'Audio can be muted without changing game state.',
				'Graphics quality changes only the local visual presentation.'
			]
		},
		postgame: {
			title: 'Postgame Guide',
			eyebrow: 'Final table',
			summary:
				'Postgame summarizes final standings, score and match outcome after the win condition is reached.',
			tips: [
				'The winner is the first player who reached the VP target.',
				'Final boards and stats remain useful for comparing strategies.',
				'Records and leaderboards use completed game data after it is saved.'
			]
		}
	};

	const screenInfo = $derived(SCREEN_INFO[context] ?? SCREEN_INFO.overview);

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose();
	}

	function onBackdropKey(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') onClose();
	}

	// ── Resources & rewards (real art, sourced by icon_pool id) ──────────────────
	// Entries may carry one icon, two (a shared category like Runes & Relics), or a
	// glyph fallback where no art exists (Spirit Augment is a counter, not an icon).
	const resources = $derived(
		[
			{
				ids: ['70792514-aa43-4526-a7a4-0f1e4ca55d71'],
				label: 'Victory Point',
				desc: 'Your score. The first player to reach 30 points wins the game.'
			},
			{
				ids: ['6746f875-a1bc-453c-94b5-718d6ebeb025'],
				label: 'Potential (Health)',
				desc: 'Health tokens that absorb combat damage. When a hit exceeds your potential you corrupt (your status drops a rung).'
			},
			{
				ids: ['80f1d5a8-812e-4bb2-b341-68e69d9a3e38'],
				label: 'Arcane Blood',
				desc: 'Corrupted potential — health flipped to its dark side when you take damage.'
			},
			{
				ids: ['36aab6c9-b98c-4e84-b097-e743f45dde82', '6a85e06a-52cc-483c-aa59-38395a377307'],
				label: 'Runes & Relics',
				desc: 'Tokens you spend to awaken your face-down spirits — each spirit lists a rune cost you pay from the runes you hold. You gain them off your location’s action cards, by Cultivating (1 rune for every 2 spirits sharing an origin), and from monster-kill rewards; you keep up to 4 between rounds (extras are discarded in Cleanup). Relics are the rarer “special” runes, used wherever an awaken cost calls for one.'
			},
			{
				ids: [] as string[],
				glyph: '✦',
				label: 'Spirit Augment',
				desc: 'A class token you place onto one of your spirits to give it an extra class trait. It follows its host — active while that spirit is awakened (face-up), dormant when face-down.'
			}
		].map((e) => ({
			...e,
			urls: e.ids.map((id) => iconPoolUrl(assets.iconPool, id)).filter((u): u is string => !!u)
		}))
	);

	// ── Player status / corruption ladder (grounded in the engine) ───────────────
	// STATUS_LADDER + SPIRIT_LIMIT_BY_STATUS: Pure 7 → Tainted 6 → Corrupt 5 → Fallen 4;
	// only Fallen is Evil (isEvilAlignment); corrupting past the bottom discards a spirit.
	const STATUS_NOTE: Record<string, string> = {
		Pure: 'Uncorrupted and fully Good — your strongest standing.',
		Tainted: 'Lightly corrupted. Still Good-aligned.',
		Corrupt: 'Deeply corrupted. Still Good-aligned.',
		Fallen:
			'Evil-aligned. In the Encounter phase you may attack co-located Good players for +2 VP each. You can’t fall any further — corrupting damage now forces you to discard a spirit instead.'
	};
	const statusLevels = STATUS_LADDER.map((name, i) => ({
		name,
		color: statusAccent(name),
		slots: SPIRIT_LIMIT_BY_STATUS[i],
		note: STATUS_NOTE[name] ?? ''
	}));

	// ── Spirit World actions (the Location-phase actions, grounded in the engine) ─
	const spiritActions = $derived(
		[
			{
				id: '76e58219-e805-4b94-acf4-6d62dfe4c515',
				label: 'Spirit World Summon',
				desc: 'Draw 4 spirits from the Spirit World, then summon up to 2 onto your board. They arrive awakened — face-up, with their class traits active immediately.'
			},
			{
				id: '12ff8ffe-20cb-4a86-a493-5e4ff8b9dc3e',
				label: 'Arcane Abyss Summon',
				desc: 'Draw 3 spirits from the Arcane Abyss, then summon up to 1. It arrives unawakened — face-down; awaken it later to switch its traits on.'
			},
			{
				id: '60e40dd5-c3cc-4f26-9aa3-2043b4106ade',
				label: 'Cultivate',
				desc: 'Harvest runes from your spirits’ origins — gain 1 origin rune for every 2 spirits sharing a core origin. Also triggers Cultivate class effects (e.g. Cultivator: a same-origin trio → 2 runes + 1 potential).'
			},
			{
				id: 'bdded3f5-e405-4b68-b63a-9f5c2139beea',
				label: 'Rest',
				desc: 'Recover and grow — triggers your Rest class effects: gaining attack dice or potential, or upgrading your dice, depending on your classes.'
			}
		]
			.map((e) => ({ ...e, url: iconPoolUrl(assets.iconPool, e.id) }))
			.filter((e) => e.url)
	);

	// ── Attack dice (the four tiers, with their average damage) ──────────────────
	const TIER_DIE_NAME: Record<DiceTier, string> = {
		basic: 'Basic Attack',
		enchanted: 'Enchanted Attack',
		exalted: 'Exalted Attack',
		arcane: 'Arcane Attack'
	};
	function tierDieImage(tier: DiceTier): string | null {
		const want = TIER_DIE_NAME[tier].toLowerCase();
		for (const die of assets.customDiceAssets.values()) {
			if (die.name.toLowerCase() !== want) continue;
			const firstFace = die.sides?.slice().sort((a, b) => a.side_number - b.side_number)[0];
			return storageUrl(
				firstFace?.image_path ?? die.background_image_path ?? die.exported_template_path
			);
		}
		return null;
	}
	const diceTiers = $derived(
		DICE_TIER_ORDER.map((tier) => {
			const faces = DICE_TIER_FACES[tier];
			const avg = faces.reduce((a, b) => a + b, 0) / faces.length;
			return {
				tier,
				label: TIER_DIE_NAME[tier],
				avg: avg.toFixed(2).replace(/\.?0+$/, ''),
				url: tierDieImage(tier)
			};
		})
	);
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
<div
	class="legend-backdrop"
	data-testid="info-legend"
	role="dialog"
	aria-modal="true"
	tabindex="-1"
	aria-label={screenInfo.title}
	onclick={onClose}
	onkeydown={onBackdropKey}
>
	<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
	<div class="legend-panel" onclick={(e) => e.stopPropagation()} onkeydown={() => undefined}>
		<header class="legend-head">
			<span class="legend-title">{screenInfo.title}</span>
			<button
				type="button"
				class="legend-close"
				data-testid="info-legend-close"
				aria-label="Close guide"
				onclick={onClose}>✕</button
			>
		</header>

		<div class="legend-body">
			<section class="legend-section screen-section" data-testid="info-screen-context">
				<div class="section-head">
					<span class="section-eyebrow">{screenInfo.eyebrow}</span><span class="section-rule"
					></span>
				</div>
				<p class="section-note screen-summary">{screenInfo.summary}</p>
				<div class="screen-tips">
					{#each screenInfo.tips as tip (tip)}
						<p>{tip}</p>
					{/each}
				</div>
			</section>

			<!-- Resources & rewards -->
			{#if resources.length > 0}
				<section class="legend-section">
					<div class="section-head">
						<span class="section-eyebrow">Resources &amp; Rewards</span><span class="section-rule"
						></span>
					</div>
					<div class="icon-list">
						{#each resources as ic (ic.label)}
							<div class="icon-row">
								<span class="icon-cell">
									{#if ic.urls.length > 0}
										{#each ic.urls as u (u)}<img src={u} alt={ic.label} loading="lazy" />{/each}
									{:else if ic.glyph}
										<span class="icon-glyph" aria-hidden="true">{ic.glyph}</span>
									{/if}
								</span>
								<div class="icon-text">
									<span class="entry-label">{ic.label}</span>
									<p class="entry-desc">{ic.desc}</p>
								</div>
							</div>
						{/each}
					</div>
				</section>
			{/if}

			<!-- Player status / corruption -->
			<section class="legend-section">
				<div class="section-head">
					<span class="section-eyebrow">Player Status</span><span class="section-rule"></span>
				</div>
				<p class="section-note">
					Every player sits on a corruption ladder. Taking more combat damage than your remaining
					Potential corrupts you — your status drops one level and your spirit board shrinks to the
					new cap (you discard spirits down to the new limit).
				</p>
				<div class="status-list">
					{#each statusLevels as s (s.name)}
						<div class="status-row" style="--c: {s.color}">
							<span class="status-dot" aria-hidden="true"></span>
							<div class="icon-text">
								<span class="entry-label"
									>{s.name} <span class="status-slots">· {s.slots} spirit slots</span></span
								>
								<p class="entry-desc">{s.note}</p>
							</div>
						</div>
					{/each}
				</div>
			</section>

			<!-- Spirit World actions -->
			{#if spiritActions.length > 0}
				<section class="legend-section">
					<div class="section-head">
						<span class="section-eyebrow">Spirit World Actions</span><span class="section-rule"
						></span>
					</div>
					<div class="icon-list">
						{#each spiritActions as ic (ic.id)}
							<div class="icon-row">
								<span class="icon-cell"><img src={ic.url} alt={ic.label} loading="lazy" /></span>
								<div class="icon-text">
									<span class="entry-label">{ic.label}</span>
									<p class="entry-desc">{ic.desc}</p>
								</div>
							</div>
						{/each}
					</div>
				</section>
			{/if}

			<!-- Attack dice -->
			<section class="legend-section">
				<div class="section-head">
					<span class="section-eyebrow">Attack Dice</span><span class="section-rule"></span>
				</div>
				<p class="section-note">
					Weakest → strongest. The number is each die’s average damage per roll.
				</p>
				<div class="dice-row">
					{#each diceTiers as d (d.tier)}
						<div class="dice-cell">
							{#if d.url}<img src={d.url} alt={d.label} loading="lazy" />{:else}<span
									class="dice-fb">{d.label.slice(0, 1)}</span
								>{/if}
							<span class="dice-label">{d.label.replace(' Attack', '')}</span>
							<span class="dice-avg">avg {d.avg}</span>
						</div>
					{/each}
				</div>
			</section>
		</div>
	</div>
</div>

<style>
	.legend-backdrop {
		position: fixed;
		inset: 0;
		z-index: 200;
		display: grid;
		place-items: center;
		padding: 2rem 1rem;
		background: rgba(5, 3, 12, 0.78);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
		animation: fade 140ms ease both;
	}
	.legend-panel {
		width: min(960px, 96vw);
		max-height: 88vh;
		display: flex;
		flex-direction: column;
		border-radius: 16px;
		border: 1px solid rgba(255, 255, 255, 0.16);
		background: linear-gradient(180deg, rgba(14, 9, 28, 0.98), rgba(8, 5, 16, 0.99));
		box-shadow: 0 30px 80px -24px rgba(0, 0, 0, 0.8);
		animation: rise 200ms cubic-bezier(0.22, 1, 0.36, 1) both;
		overflow: hidden;
	}
	.legend-head {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 1.1rem 1.4rem;
		border-bottom: 1px solid rgba(255, 255, 255, 0.14);
	}
	.legend-title {
		font-family: var(--font-display);
		font-size: 1.6rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: #fff;
		line-height: 1;
	}
	.legend-close {
		flex: 0 0 auto;
		width: 34px;
		height: 34px;
		display: grid;
		place-items: center;
		border-radius: 8px;
		border: 1px solid rgba(255, 255, 255, 0.16);
		background: rgba(10, 7, 20, 0.6);
		color: rgba(255, 255, 255, 0.7);
		font-size: 1rem;
		line-height: 1;
		cursor: pointer;
		transition:
			border-color 140ms ease,
			color 140ms ease;
	}
	.legend-close:hover {
		border-color: var(--brand-coral, #ff7a59);
		color: #fff;
	}
	.legend-body {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
		touch-action: pan-y;
		padding: 1.2rem 1.4rem 1.6rem;
		display: flex;
		flex-direction: column;
		gap: 1.6rem;
	}

	.section-head {
		display: flex;
		align-items: center;
		gap: 0.8rem;
		margin-bottom: 0.85rem;
	}
	.section-eyebrow {
		flex: 0 0 auto;
		font-family: var(--font-display);
		font-size: 0.95rem;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--brand-cyan, #5cdfff);
	}
	.section-rule {
		flex: 1 1 auto;
		height: 1px;
		background: rgba(255, 255, 255, 0.16);
	}
	.section-note {
		margin: -0.4rem 0 0.85rem;
		font-size: 0.9rem;
		line-height: 1.45;
		color: var(--color-fog, #9a93b0);
	}
	.screen-section {
		padding: 1rem;
		border-radius: 12px;
		background: linear-gradient(135deg, rgba(92, 223, 255, 0.12), rgba(255, 122, 89, 0.08));
		box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1);
	}
	.screen-summary {
		margin-bottom: 0.8rem;
		color: var(--color-parchment, #e7e0cf);
	}
	.screen-tips {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
		gap: 0.65rem;
	}
	.screen-tips p {
		margin: 0;
		padding-left: 0.75rem;
		border-left: 2px solid color-mix(in srgb, var(--brand-cyan, #5cdfff) 55%, transparent);
		font-size: 0.9rem;
		line-height: 1.4;
		color: var(--color-bone, #fff8ec);
	}

	.entry-label {
		font-family: var(--font-display);
		font-size: 1.1rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: #fff;
	}
	.entry-desc {
		margin: 0.15rem 0 0;
		font-size: 0.95rem;
		line-height: 1.45;
		color: var(--color-parchment, #e7e0cf);
	}

	/* Icon rows (resources + spirit-world actions) */
	.icon-list {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
		gap: 0.9rem 1.4rem;
	}
	.icon-row {
		display: flex;
		align-items: flex-start;
		gap: 0.9rem;
	}
	.icon-cell {
		flex: 0 0 auto;
		min-width: 2.8rem;
		height: 2.8rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.3rem;
		padding: 0 0.4rem;
		border-radius: 10px;
		background: rgba(0, 0, 0, 0.32);
		box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1);
	}
	.icon-cell img {
		width: 2rem;
		height: 2rem;
		object-fit: contain;
	}
	.icon-glyph {
		font-family: var(--font-display);
		font-size: 1.6rem;
		line-height: 1;
		color: var(--brand-cyan, #5cdfff);
	}
	.icon-text {
		min-width: 0;
	}

	/* Player status */
	.status-list {
		display: flex;
		flex-direction: column;
		gap: 0.8rem;
	}
	.status-row {
		display: flex;
		align-items: flex-start;
		gap: 0.9rem;
	}
	.status-dot {
		flex: 0 0 auto;
		width: 1rem;
		height: 1rem;
		margin-top: 0.35rem;
		border-radius: 50%;
		background: var(--c);
		box-shadow: 0 0 10px color-mix(in srgb, var(--c) 60%, transparent);
	}
	.status-slots {
		font-size: 0.78em;
		letter-spacing: 0.04em;
		color: var(--color-fog, #9a93b0);
	}

	/* Attack dice */
	.dice-row {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
	}
	.dice-cell {
		flex: 0 1 auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
		padding: 0.6rem 0.9rem;
		border-radius: 10px;
		background: rgba(0, 0, 0, 0.28);
		box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1);
	}
	.dice-cell img {
		width: 2.6rem;
		height: 2.6rem;
		object-fit: contain;
	}
	.dice-fb {
		width: 2.6rem;
		height: 2.6rem;
		display: grid;
		place-items: center;
		font-family: var(--font-display);
		font-size: 1.2rem;
		color: #fff;
	}
	.dice-label {
		font-family: var(--font-display);
		font-size: 0.9rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: #fff;
	}
	.dice-avg {
		font-size: 0.8rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--brand-coral, #ff7a59);
		font-variant-numeric: tabular-nums;
	}

	@keyframes fade {
		from {
			opacity: 0;
		}
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(12px) scale(0.985);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.legend-backdrop,
		.legend-panel {
			animation: none;
		}
	}
</style>

<script lang="ts">
	import {
		getGraphicsSettings,
		setSplatQuality,
		setVisualQuality,
		SPLAT_QUALITY_OPTIONS,
		VISUAL_QUALITY_OPTIONS
	} from '$lib/stores/graphicsSettings.svelte';
	import {
		getAccessibilitySettings,
		setHaptics,
		setHighContrast,
		setLocale,
		setTextScale,
		pulseHaptic,
		TEXT_SCALE_OPTIONS,
		LOCALE_OPTIONS
	} from '$lib/stores/accessibilitySettings.svelte';

	interface Props {
		/** Optional label shown above the control. */
		label?: string;
	}
	let { label = 'Background' }: Props = $props();

	const graphics = getGraphicsSettings();
	const accessibility = getAccessibilitySettings();
</script>

<div class="field">
	<span class="lbl">{label}</span>
	<div class="seg" role="radiogroup" aria-label="{label} quality">
		{#each SPLAT_QUALITY_OPTIONS as opt (opt.value)}
			<button
				type="button"
				role="radio"
				class="opt"
				class:active={graphics.splatQuality === opt.value}
				aria-checked={graphics.splatQuality === opt.value}
				data-testid={`splat-quality-${opt.value}`}
				onclick={() => { setSplatQuality(opt.value); pulseHaptic(); }}
			>
				{opt.label}
			</button>
		{/each}
	</div>
</div>

<div class="field">
	<span class="lbl">Spirit effects</span>
	<div class="seg visual" role="radiogroup" aria-label="Spirit effects quality">
		{#each VISUAL_QUALITY_OPTIONS as opt (opt.value)}
			<button
				type="button"
				role="radio"
				class="opt"
				class:active={graphics.visualQuality === opt.value}
				aria-checked={graphics.visualQuality === opt.value}
				data-testid={`visual-quality-${opt.value}`}
				onclick={() => { setVisualQuality(opt.value); pulseHaptic(); }}
			>
				{opt.label}
			</button>
		{/each}
	</div>
	<small>Showcases only; rules and controls stay crisp. Reduced Motion is taken from your device.</small>
</div>

<div class="field accessibility" data-testid="accessibility-settings">
	<span class="lbl">Accessibility</span>
	<label class="toggle">
		<input type="checkbox" checked={accessibility.haptics} onchange={(event) => setHaptics(event.currentTarget.checked)} />
		<span>Haptic feedback</span>
	</label>
	<label class="toggle">
		<input type="checkbox" checked={accessibility.highContrast} onchange={(event) => { setHighContrast(event.currentTarget.checked); pulseHaptic(); }} />
		<span>High contrast</span>
	</label>
	<div class="seg visual" role="radiogroup" aria-label="Text size">
		{#each TEXT_SCALE_OPTIONS as opt (opt.value)}
			<button type="button" role="radio" class="opt" class:active={accessibility.textScale === opt.value}
				aria-checked={accessibility.textScale === opt.value} data-testid={`text-scale-${opt.value}`}
				onclick={() => { setTextScale(opt.value); pulseHaptic(); }}>{opt.label}</button>
		{/each}
	</div>
	<div class="seg visual" role="radiogroup" aria-label="Language test mode">
		{#each LOCALE_OPTIONS as opt (opt.value)}
			<button type="button" role="radio" class="opt" class:active={accessibility.locale === opt.value}
				aria-checked={accessibility.locale === opt.value} data-testid={`locale-${opt.value}`}
				onclick={() => { setLocale(opt.value); pulseHaptic(); }}>{opt.label}</button>
		{/each}
	</div>
	<small>Pseudo expands labels for localization testing. Essential state always uses text and shape, never color alone.</small>
</div>

<style>
	.field {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.lbl {
		font-family: var(--font-display);
		font-size: 0.62rem;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--color-fog, #9a8fb8);
	}
	.seg {
		display: inline-flex;
		padding: 3px;
		gap: 3px;
		border-radius: 10px;
		border: 1px solid var(--color-mist, #2e1d52);
		background: rgba(5, 3, 16, 0.5);
	}
	.seg.visual { flex-wrap: wrap; }
	.field small { color:var(--color-fog,#9a8fb8); font-size:.62rem; line-height:1.35; }
	.accessibility { border-top:1px solid var(--color-mist,#2e1d52); padding-top:10px; }
	.toggle { min-height:44px; display:flex; align-items:center; gap:10px; color:var(--color-parchment,#d8cfee); font-size:.75rem; cursor:pointer; }
	.toggle input { width:20px; height:20px; accent-color:var(--brand-magenta,#ff2bc7); }
	.opt {
		flex: 1;
		min-width: 52px;
		min-height: 44px;
		padding: 7px 10px;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--color-parchment, #d8cfee);
		font-family: var(--font-display);
		font-size: 0.66rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		cursor: pointer;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		transition:
			background 150ms ease,
			color 150ms ease;
	}
	.opt.active {
		background: var(--brand-magenta, #ff2bc7);
		color: #fff;
	}
	@media (hover: hover) and (pointer: fine) {
		.opt:not(.active):hover {
			color: var(--color-bone, #f5f0ff);
			background: rgba(255, 43, 199, 0.12);
		}
	}
	.opt:focus-visible {
		outline: 2px solid var(--brand-magenta, #ff2bc7);
		outline-offset: 2px;
	}
</style>

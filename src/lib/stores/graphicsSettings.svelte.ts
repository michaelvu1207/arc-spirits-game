/**
 * Player-controlled graphics settings, persisted to localStorage.
 *
 * The Gaussian-splat background (Spark + three.js) is by far the heaviest thing
 * the client renders — a full WebGL scene drawn every frame. On phones that means
 * heat, battery drain and thermal throttling that drags the whole UI down. This
 * store lets the player cap or disable it: Off / 30 FPS / 60 FPS.
 *
 * SplatBackground reads `splatFps` to throttle its render loop; the menu + in-game
 * shells read `splatEnabled` to skip mounting the renderer entirely when Off.
 */
import { persistedState } from '$lib/persistedState.svelte';
import { prefersReducedData } from '$lib/play/dataSaver';

export type SplatQuality = 'off' | '30' | '60';
export type VisualQuality = 'off' | 'battery' | 'balanced' | 'high';

export const SPLAT_QUALITY_OPTIONS: { value: SplatQuality; label: string }[] = [
	{ value: 'off', label: 'Off' },
	{ value: '30', label: '30 FPS' },
	{ value: '60', label: '60 FPS' }
];

export const VISUAL_QUALITY_OPTIONS: { value: VisualQuality; label: string }[] = [
	{ value: 'off', label: 'Off' },
	{ value: 'battery', label: 'Battery Saver' },
	{ value: 'balanced', label: 'Balanced' },
	{ value: 'high', label: 'High' }
];

/** Device-aware first-run default: off on metered/Data-Saver connections, a gentle
 *  30 FPS cap on phones (coarse pointer / small screen), full 60 on desktop. The
 *  player's explicit choice (stored) always wins on subsequent visits. */
function defaultSplatQuality(): SplatQuality {
	if (typeof window === 'undefined') return '60';
	if (prefersReducedData()) return 'off';
	const isPhone =
		window.matchMedia('(pointer: coarse)').matches ||
		window.matchMedia('(max-width: 600px)').matches;
	return isPhone ? '30' : '60';
}

const splatQuality = persistedState<SplatQuality>('asp:splat-quality', defaultSplatQuality());

function defaultVisualQuality(): VisualQuality {
	if (typeof window === 'undefined') return 'balanced';
	if (prefersReducedData()) return 'battery';
	const isPhone =
		window.matchMedia('(pointer: coarse)').matches ||
		window.matchMedia('(max-width: 600px)').matches;
	return isPhone ? 'battery' : 'balanced';
}

const visualQuality = persistedState<VisualQuality>('asp:visual-quality', defaultVisualQuality());

/** Reactive view of the graphics settings (read inside components/effects). */
export function getGraphicsSettings() {
	return {
		get splatQuality() {
			return splatQuality.value;
		},
		/** Target frames-per-second for the splat render loop; 0 when disabled. */
		get splatFps() {
			return splatQuality.value === 'off' ? 0 : splatQuality.value === '30' ? 30 : 60;
		},
		/** Whether the full-screen splat background should mount at all. */
		get splatEnabled() {
			return splatQuality.value !== 'off';
		},
		/** Shared Three.js/Godot-style showcase quality. Essential state never depends on it. */
		get visualQuality() {
			return visualQuality.value;
		},
		/** OS reduced-motion is authoritative for decorative motion on the web. */
		get reducedMotion() {
			return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		}
	};
}

export function setSplatQuality(value: SplatQuality) {
	splatQuality.value = value;
}

export function setVisualQuality(value: VisualQuality) {
	visualQuality.value = value;
}

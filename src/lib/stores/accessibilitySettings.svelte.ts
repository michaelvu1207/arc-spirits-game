import { persistedState } from '$lib/persistedState.svelte';

export type TextScale = '100' | '115' | '130';
export type ArcLocale = 'en' | 'en-XA';
export type HapticKind = 'selection' | 'commit' | 'impact' | 'success' | 'error';

const haptics = persistedState<boolean>('asp:haptics', true);
const highContrast = persistedState<boolean>('asp:high-contrast', false);
const textScale = persistedState<TextScale>('asp:text-scale', '100');
const locale = persistedState<ArcLocale>('asp:locale', 'en');

export const TEXT_SCALE_OPTIONS: { value: TextScale; label: string }[] = [
	{ value: '100', label: '100%' },
	{ value: '115', label: '115%' },
	{ value: '130', label: '130%' }
];

export const LOCALE_OPTIONS: { value: ArcLocale; label: string }[] = [
	{ value: 'en', label: 'English' },
	{ value: 'en-XA', label: 'Pseudo' }
];

export function getAccessibilitySettings() {
	return {
		get haptics() {
			return haptics.value;
		},
		get highContrast() {
			return highContrast.value;
		},
		get textScale() {
			return textScale.value;
		},
		get locale() {
			return locale.value;
		}
	};
}

export function setHaptics(value: boolean) {
	haptics.value = value;
}

export function setHighContrast(value: boolean) {
	highContrast.value = value;
}

export function setTextScale(value: TextScale) {
	textScale.value = value;
}

export function setLocale(value: ArcLocale) {
	locale.value = value;
}

/**
 * Best-effort web haptics. The Godot clients use their native vibration API;
 * browsers without Vibration (notably iOS Safari) intentionally degrade to silence.
 */
export function pulseHaptic(kind: HapticKind = 'selection'): boolean {
	if (!haptics.value || typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') {
		return false;
	}
	const pattern: number | number[] =
		kind === 'impact'
			? 45
			: kind === 'success'
				? [25, 35, 45]
				: kind === 'error'
					? [60, 35, 60]
					: kind === 'commit'
						? 28
						: 12;
	try {
		return navigator.vibrate(pattern);
	} catch {
		return false;
	}
}

/** Pseudo-localization expands text and exposes clipping without shipping fake copy. */
export function localize(message: string): string {
	if (locale.value !== 'en-XA') return message;
	const expanded = message.replace(/[A-Za-z]/g, (letter) => {
		const map: Record<string, string> = {
			a: 'á', e: 'ë', i: 'ï', o: 'ö', u: 'ü',
			A: 'Á', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü'
		};
		return map[letter] ?? letter;
	});
	return `［${expanded} ···］`;
}

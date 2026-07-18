import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	getAccessibilitySettings,
	localize,
	pulseHaptic,
	setHaptics,
	setLocale,
	setTextScale
} from './accessibilitySettings.svelte';

describe('cross-platform accessibility settings', () => {
	afterEach(() => {
		setHaptics(true);
		setLocale('en');
		setTextScale('100');
		vi.unstubAllGlobals();
	});

	it('exposes scalable type and a deterministic pseudo-locale', () => {
		setTextScale('130');
		setLocale('en-XA');
		expect(getAccessibilitySettings().textScale).toBe('130');
		expect(localize('Summon Spirit')).toMatch(/^［Sümmön Spïrït ···］$/);
		setLocale('en');
		expect(localize('Summon Spirit')).toBe('Summon Spirit');
	});

	it('honors the haptics preference and safely degrades without platform support', () => {
		const vibrate = vi.fn(() => true);
		vi.stubGlobal('navigator', { vibrate });
		expect(pulseHaptic('impact')).toBe(true);
		expect(vibrate).toHaveBeenCalledWith(45);
		setHaptics(false);
		expect(pulseHaptic('error')).toBe(false);
		expect(vibrate).toHaveBeenCalledTimes(1);
	});
});

import { describe, expect, it } from 'vitest';
import { buildReplayHighlightSvg } from './highlight';

describe('portable replay highlight', () => {
	it('produces one self-contained animated, reduced-motion-safe SVG', () => {
		const svg = buildReplayHighlightSvg({
			title: 'Final <script>alert(1)</script>', guardian: 'Kitsune & Ash',
			playerColor: 'Red', round: 12, gain: 9, accent: '#66f2df'
		});
		expect(svg).toContain('<svg');
		expect(svg).toContain('@keyframes orbit');
		expect(svg).toContain('prefers-reduced-motion:reduce');
		expect(svg).toContain('+9 VP');
		expect(svg).toContain('ROUND 12');
		expect(svg).toContain('Kitsune &amp; Ash');
		expect(svg).not.toContain('<script>');
		expect(svg).not.toContain('<image');
		expect(svg).not.toContain('<script');
		expect(svg).not.toContain('href=');
	});

	it('clamps untrusted numeric and color inputs deterministically', () => {
		const svg = buildReplayHighlightSvg({
			title: '', guardian: '', playerColor: '', round: -5, gain: Number.NaN,
			accent: 'url(javascript:bad)'
		});
		expect(svg).toContain('#66f2df');
		expect(svg).toContain('+0 VP');
		expect(svg).toContain('ROUND 0');
		expect(svg).not.toContain('javascript');
	});
});

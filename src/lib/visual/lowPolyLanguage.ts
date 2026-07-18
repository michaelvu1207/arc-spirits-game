import manifest from './lowPolyLanguage.json';

export type SpiritMoment = keyof typeof manifest.moments;
export type VisualQuality = keyof typeof manifest.quality;

export const LOW_POLY_LANGUAGE = manifest;

export function momentConfig(moment: SpiritMoment) {
	return manifest.moments[moment];
}

export function qualityConfig(quality: VisualQuality) {
	return manifest.quality[quality];
}

export function guardianSeed(name: string): number {
	let value = 2166136261;
	for (const character of name.trim().toLowerCase()) {
		value ^= character.codePointAt(0) ?? 0;
		value = Math.imul(value, 16777619);
	}
	return value >>> 0;
}

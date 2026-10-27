export type FrameBlendMode = 'normal' | 'screen' | 'add' | 'multiply' | 'overlay' | 'hard-light';

export interface FrameConfig {
	id: string;
	name: string;
	shortName: string;
	aliases: string[];
	colors: { outer: string; inner: string; accent: string; glow: string };
	blendMode: FrameBlendMode;
	pattern: 'ember' | 'thorn' | 'rune' | 'tidal' | 'aether' | 'steel';
	description: string;
}

/**
 * The current origin families represented by the live spirit catalog. Aliases keep
 * this editor stable while the game moves from legacy origin names to region names.
 */
export const FRAME_CONFIGS: FrameConfig[] = [
	{
		id: 'fire',
		name: 'Fire Region',
		shortName: 'Fire',
		aliases: ['Fire Region', 'Fire', 'Lantern Lights'],
		colors: { outer: '#ff5a32', inner: '#ffb11f', accent: '#ffe08a', glow: '#ff4b2b' },
		blendMode: 'screen',
		pattern: 'ember',
		description: 'Hot angular edges with a warm ember pulse.'
	},
	{
		id: 'forest',
		name: 'Forest Region',
		shortName: 'Forest',
		aliases: ['Forest Region', 'Forest', 'Floral Patch'],
		colors: { outer: '#21c989', inner: '#8be35f', accent: '#d5ff9b', glow: '#2affb0' },
		blendMode: 'screen',
		pattern: 'thorn',
		description: 'Living thorn geometry with a soft bioluminescent edge.'
	},
	{
		id: 'mountain',
		name: 'Mountain Region',
		shortName: 'Mountain',
		aliases: ['Mountain Region', 'Mountain', 'Cyber City'],
		colors: { outer: '#6f7bff', inner: '#b5c7ff', accent: '#f2f6ff', glow: '#5cdfff' },
		blendMode: 'hard-light',
		pattern: 'rune',
		description: 'Carved runes and a crystalline, high-contrast silhouette.'
	},
	{
		id: 'water',
		name: 'Water Region',
		shortName: 'Water',
		aliases: ['Water Region', 'Water', 'Moon Tide'],
		colors: { outer: '#28b8ff', inner: '#8de9ff', accent: '#e2fdff', glow: '#23d4ff' },
		blendMode: 'screen',
		pattern: 'tidal',
		description: 'Tidal bands with a cool cyan bloom around the portrait.'
	},
	{
		id: 'arcane',
		name: 'Arcane Spirits',
		shortName: 'Arcane',
		aliases: ['Arcane Spirits'],
		colors: { outer: '#9d4dff', inner: '#ff4bdb', accent: '#f7c8ff', glow: '#b46cff' },
		blendMode: 'add',
		pattern: 'aether',
		description: 'Prismatic aether frame for the high-cost Arcane spirits.'
	},
	{
		id: 'human',
		name: 'Human Enclave',
		shortName: 'Human',
		aliases: ['Human Enclave'],
		colors: { outer: '#8993a8', inner: '#d6dee9', accent: '#ffffff', glow: '#a6b4c7' },
		blendMode: 'normal',
		pattern: 'steel',
		description: 'Neutral steel treatment for the Human Enclave starter spirits.'
	}
];

export const FRAME_BLEND_MODES: FrameBlendMode[] = [
	'normal',
	'screen',
	'add',
	'multiply',
	'overlay',
	'hard-light'
];

export function frameForOrigin(originName: string | undefined): FrameConfig {
	const normalized = originName?.toLowerCase() ?? '';
	return (
		FRAME_CONFIGS.find((frame) => frame.aliases.some((alias) => alias.toLowerCase() === normalized)) ??
		FRAME_CONFIGS[4]
	);
}

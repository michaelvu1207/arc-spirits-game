/** Optional outbound platform mirror. Canonical unlocks and ratings are always
 * read from Arc Spirits first; providers can never submit or grant state. */
export interface PlatformBridge {
	readonly provider: 'none' | 'game-center' | 'play-games';
	readonly available: boolean;
	mirrorAchievement(id: string, percent: number): Promise<'mirrored' | 'unavailable'>;
	mirrorLeaderboard(id: string, score: number): Promise<'mirrored' | 'unavailable'>;
}

export class NullPlatformBridge implements PlatformBridge {
	readonly provider = 'none' as const;
	readonly available = false;
	async mirrorAchievement(_id: string, _percent: number) { return 'unavailable' as const; }
	async mirrorLeaderboard(_id: string, _score: number) { return 'unavailable' as const; }
}

export function platformBridge(): PlatformBridge {
	// Unsigned web/simulator builds deliberately use the null bridge. Signed native
	// adapters may replace this factory later but remain outbound-only.
	return new NullPlatformBridge();
}

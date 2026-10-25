/** Live bot play is paused until the remote policy service is restored. */
export const BOTS_ENABLED = false;

export function requireBotsEnabled(): void {
	if (!BOTS_ENABLED) throw new Error('Bots are temporarily unavailable.');
}

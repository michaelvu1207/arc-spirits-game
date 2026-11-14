/** Live bot play is paused until the remote policy service is restored. The local game
 *  (scripts/local-game/start.mjs) turns bots on with VITE_ARC_LOCAL_BOTS=1; there they play
 *  with the bundled policy (src/lib/play/ml/policy-weights.json). Unset (production, tsx
 *  scripts, tests): off. */
export const BOTS_ENABLED = import.meta.env?.VITE_ARC_LOCAL_BOTS === '1';

export function requireBotsEnabled(): void {
	if (!BOTS_ENABLED) throw new Error('Bots are temporarily unavailable.');
}

/**
 * Scripted Fighter + Elementalist player: the runner of the scripted players with the table
 * `fe4` as its default. Same options and the same result as before; see run-scripted.ts.
 *
 *   npx tsx scripts/agent-harness/scripted/run-fe.ts --data ../balance/z22a/game \
 *       --table fe4 --seeds 1-100 --out ../balance/scripted/fe4.json
 */

import { main } from './run-scripted';

main('fe4').catch((err) => {
	console.error(err);
	process.exit(1);
});

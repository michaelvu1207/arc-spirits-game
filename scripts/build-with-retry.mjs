#!/usr/bin/env node
/**
 * `npm run build`: vite build, retried on failure. Bundling the 3-D library (@sparkjsdev/spark)
 * sometimes dies with "Maximum call stack size exceeded" inside a rollup regular expression; the
 * same build passes on the next run. Without a retry, a pushed game package can fail to deploy for
 * no reason of its own. A real build error fails all attempts and is reported as before.
 */
import { spawnSync } from 'node:child_process';

const ATTEMPTS = 3;
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
	const result = spawnSync(process.execPath, ['--stack-size=4096', 'node_modules/vite/bin/vite.js', 'build'], {
		stdio: 'inherit'
	});
	if (result.status === 0) process.exit(0);
	console.error(`\nvite build failed (attempt ${attempt} of ${ATTEMPTS}, exit ${result.status ?? result.signal})`);
}
process.exit(1);

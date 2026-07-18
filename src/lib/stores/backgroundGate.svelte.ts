/**
 * Heavy-background scheduling gate.
 *
 * The Gaussian-splat background's INITIALIZATION is a genuine multi-second
 * native main-thread stall (WASM compile + first GPU upload/sort of ~1M
 * gaussians — measured ~3.6s headed, worse under software GL; the JS-side pose
 * scan is already precomputed away in splatPoses.ts). That cost cannot be
 * chunked from JS, but it CAN be scheduled: latency-sensitive flows (Quick Play
 * matchmaking polls, a held matched-room navigation) take a HOLD, and the first
 * splat mount waits for idle + zero holds. Once mounted, the splat is NEVER
 * unmounted by a hold (tearing down/re-initializing WebGL would repeat the
 * stall — the opposite of the point); a hold only delays the FIRST init.
 */

let holds = $state(0);
/** Plain (non-reactive) waiters for the async pipeline gates. */
const waiters: (() => void)[] = [];

/** Take a hold; returns an idempotent release. */
export function holdHeavyBackground(): () => void {
	holds += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		holds -= 1;
		if (holds === 0) {
			const pending = waiters.splice(0, waiters.length);
			for (const wake of pending) wake();
		}
	};
}

/** Reactive: true while any latency-sensitive flow holds the gate. */
export function heavyBackgroundHeld(): boolean {
	return holds > 0;
}

/** Awaitable gate for the splat INIT pipeline's heavy stages (fetch/decode,
 *  first GPU upload/render): resolves immediately when free, else when the
 *  last hold releases. A hold taken between two stages parks the pipeline
 *  BEFORE its next stall — a search started mid-init is still protected. */
export function whenHeavyBackgroundReleased(): Promise<void> {
	if (holds === 0) return Promise.resolve();
	return new Promise((resolve) => {
		waiters.push(resolve);
	});
}

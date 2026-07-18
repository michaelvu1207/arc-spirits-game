/**
 * Baked camera poses for every shipped Gaussian-splat world.
 *
 * WHY THIS FILE EXISTS: without a baked pose, SplatBackground derives its aim
 * point by WALKING EVERY SPLAT of the loaded world synchronously on the main
 * thread (`mesh.forEachSplat` over ~1M gaussians of a ~7.5 MiB .spz). On /play
 * that scan ran during Quick Play matchmaking and starved the queue-poll timers
 * and route transitions. Every world we ship therefore gets its viewpoint
 * PRECOMPUTED here (same algorithm, run offline), and the runtime scan survives
 * only as a DEFERRED-to-idle fallback for worlds this table doesn't know.
 *
 * Regenerate after adding/replacing a world:
 *   node scripts/compute-splat-poses.mjs   (boots a dev server + headless
 *   Chromium, computes each world's sharpness-weighted centroid with the exact
 *   runtime code path, and prints this table).
 *
 * `base` is the camera resting position (the capture point unless hand-tuned),
 * `look` the weighted centroid of the well-observed content. cyber-city keeps
 * its HAND-TUNED pose (authored with fly mode, predating this table).
 */
export interface SplatPose {
	base: [number, number, number];
	look: [number, number, number];
}

export const POSE_BY_URL: Record<string, SplatPose> = {
	'/splats/cyber-city.spz': {
		base: [-0.415, -0.734, -4.06],
		look: [-0.609, -4.075, -5.999]
	},
	// Baked 2026-07-12 by scripts/compute-splat-poses.mjs (auto centroid, base at
	// the capture point — identical output to the runtime fallback scan).
	'/splats/abyssal-portal.spz': {
		base: [0, 0, 0],
		look: [-0.083, -0.823, -0.603]
	},
	'/splats/forest-clearing.spz': {
		base: [0, 0, 0],
		look: [-0.278, -0.553, -1.224]
	},
	'/splats/lantern-market.spz': {
		base: [0, 0, 0],
		look: [-2.165, -0.53, -1.542]
	},
	'/splats/misty-valley.spz': {
		base: [0, 0, 0],
		look: [-1.114, -31.904, -5.018]
	},
	'/splats/underwater-cave.spz': {
		base: [0, 0, 0],
		look: [-0.302, -1.702, -1.357]
	}
};

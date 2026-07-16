<script lang="ts">
	import { onMount } from 'svelte';
	import { dev } from '$app/environment';
	import { getGraphicsSettings } from '$lib/stores/graphicsSettings.svelte';
	import { whenHeavyBackgroundReleased } from '$lib/stores/backgroundGate.svelte';
	import { POSE_BY_URL } from '$lib/play/splatPoses';
	// Type-only import — erased at compile time; does NOT pull the runtime library
	// into the initial bundle. The runtime is dynamically imported inside onMount
	// so three + @sparkjsdev/spark land in their own lazy chunk (see vite.config.ts).
	import type { SplatMesh as SplatMeshType } from '@sparkjsdev/spark';

	interface Props {
		/** URL of the .spz/.ply splat to show, or null to show nothing (gradient shows through). */
		src: string | null;
		/** CSS blur radius in px. */
		blur?: number;
		/** Camera dolly, 0 = resting at the capture point, 1 = pushed into the world. */
		push?: number;
		/** Authoring aid: when true, take over with a WASD + mouse fly camera. */
		controls?: boolean;
		/** Fired exactly ONCE each time the dolly reaches full push (push≈1) — the moment
		 *  the realm-enter zoom has arrived. Used to hand off the 'enter' beat instead of a
		 *  fixed timer. Re-arms whenever push drops back toward the resting point. */
		onZoomSettled?: () => void;
		/** Embedded in a small, sized (e.g. circular) parent rather than full-viewport:
		 *  drops the heavy full-screen vignette so the little preview reads cleanly. The
		 *  circular MASK itself is the parent's job (border-radius + overflow:hidden). */
		contained?: boolean;
	}

	let {
		src,
		blur = 0,
		push = 0,
		controls = false,
		onZoomSettled,
		contained = false
	}: Props = $props();

	let canvas = $state<HTMLCanvasElement>();
	let poseEl = $state<HTMLDivElement>(); // live pose readout in fly mode
	let warpEl = $state<HTMLDivElement>(); // void veil, opacity driven by the warp loop
	let hasSplat = $state(false); // gates the canvas fade-in

	// Imperative handle wired up once the renderer exists; the $effect below pushes
	// new URLs through it whenever `src` changes.
	let applySrc: ((url: string | null) => void) | null = null;

	// Plain ref bridged from the prop so the render loop / event handlers always
	// read the current value (closures don't track prop changes).
	const ui = { active: false };
	$effect(() => {
		ui.active = controls;
	});
	// Camera dolly target, bridged the same way; the render loop eases toward it.
	const cam = { push: 0 };
	$effect(() => {
		cam.push = push;
	});
	// Zoom-settled callback bridged to a plain ref so the rAF loop always invokes the
	// latest handler (closures captured at mount don't track prop changes).
	const cb = { settled: null as null | (() => void) };
	$effect(() => {
		cb.settled = onZoomSettled ?? null;
	});
	// Player-chosen frame cap, bridged the same way so the render loop throttles live
	// when the setting changes (30/60). 0 means Off — the loop idles without drawing
	// (the parent normally unmounts us entirely when Off; this is the safe fallback).
	const q = { fps: 60 };
	$effect(() => {
		q.fps = getGraphicsSettings().splatFps;
	});

	onMount(() => {
		let disposed = false;
		let raf = 0;
		let teardown: (() => void) | null = null;

		(async () => {
			// Spark touches WebGL/DOM, so import it lazily inside the browser only.
			const THREE = await import('three');
			const { SparkRenderer, SplatMesh } = await import('@sparkjsdev/spark');
			if (disposed || !canvas) return;
			const el = canvas;

			// Mobile-aware capability probe (SSR-safe — onMount only runs in the browser).
			// Coarse pointer or a small viewport ⇒ treat as a phone: high-DPR phones push
			// 3–4× the pixels for little visual gain on a soft, blurred background.
			const isMobileGpu =
				(typeof window !== 'undefined' &&
					(window.matchMedia('(pointer: coarse)').matches ||
						window.matchMedia('(max-width: 600px)').matches)) ||
				false;
			// The renderer drives its backing buffer purely through setSize() below; the
			// original never called setPixelRatio, so it ran at an implicit ratio of 1
			// (buffer = clientSize × RENDER_SCALE, independent of screen DPR). Keep that
			// on every device — letting three multiply by devicePixelRatio would blow a
			// dpr-3 phone's buffer up 3–4× for a soft, blurred background. The phone win
			// comes from a lower RENDER_SCALE instead, which is a strict reduction.
			const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
			// Effective device-pixel budget for the backing buffer, capped at ~1.5 on
			// phones (full on desktop) so high-DPR screens stay within a sane envelope.
			const dprCap = isMobileGpu ? Math.min(dpr, 1.5) : dpr;
			// Rendered at a fraction of the real resolution — cheap, and fine for a soft
			// background (and invisible once blur is applied). On phones the scale is
			// lowered AND divided down by the capped DPR so the buffer never exceeds the
			// desktop pixel count; desktop keeps its original 0.6.
			const RENDER_SCALE = isMobileGpu ? Math.min(0.45, 0.6 / dprCap) : 0.6;
			// World Labs / .spz worlds arrive Z-up & Y-forward; three.js is Y-up &
			// -Z-forward. Tip the world a quarter-turn about X so it stands upright with
			// the horizon in front. Flip the sign if a world ends up upside-down.
			const ORIENT = new THREE.Euler(-Math.PI / 2, 0, 0);

			const renderer = new THREE.WebGLRenderer({ canvas: el, antialias: false, alpha: true });
			// Leave pixelRatio at the implicit 1 (as before): the backing-buffer size is
			// driven entirely by setSize() with RENDER_SCALE, which already folds in the
			// DPR cap, so we must not let three multiply by devicePixelRatio on top.
			renderer.setClearAlpha(0);
			const scene = new THREE.Scene();
			const camera = new THREE.PerspectiveCamera(65, 1, 0.01, 1000);
			camera.rotation.order = 'YXZ';

			const spark = new SparkRenderer({ renderer });
			scene.add(spark);

			type Layer = { mesh: SplatMeshType; target: number };
			let layers: Layer[] = [];
			let lastUrl: string | null = null;

			// Per-world camera anchor: the capture point (≈ origin for Marble worlds),
			// the centre of the well-reconstructed content to aim at, and a rough scale.
			const basePos = new THREE.Vector3(0, 0, 0);
			const lookCenter = new THREE.Vector3(0, 0, -1);
			let sceneScale = 5;
			// Baked viewpoints per world live in $lib/play/splatPoses (regenerated by
			// scripts/compute-splat-poses.mjs). Worlds not listed fall back to the auto
			// sharpness-weighted centroid — DEFERRED to idle, never on the load path.

			// Splats can only be sharp near where they were generated. Well-observed
			// regions have many small, opaque Gaussians; hallucinated regions have few
			// big blobby ones. Weighting each splat by opacity / size therefore points
			// us at the real content and away from the smeared parts.
			//
			// COST WARNING: `forEachSplat` walks EVERY gaussian synchronously on the
			// main thread (~1M for a shipped world). Every shipped world must have a
			// BAKED pose; this function is only the idle-deferred fallback for unknown
			// URLs (dev-added worlds), plus the offline baking path itself.
			function weightedViewpoint(
				mesh: SplatMeshType,
				base: { x: number; y: number; z: number }
			): { look: { x: number; y: number; z: number }; scale: number } {
				let sx = 0;
				let sy = 0;
				let sz = 0;
				let wsum = 0;
				mesh.forEachSplat((_i, center, scales, _q, opacity) => {
					const size = (scales.x + scales.y + scales.z) / 3;
					const w = opacity / (1e-3 + size);
					sx += center.x * w;
					sy += center.y * w;
					sz += center.z * w;
					wsum += w;
				});
				const look = new THREE.Vector3(0, 0, -1);
				if (wsum > 0) look.set(sx / wsum, sy / wsum, sz / wsum);
				// forEachSplat returns local centres — bring the aim point into world
				// space so it reflects the orientation correction applied to the mesh.
				mesh.updateMatrixWorld(true);
				look.applyMatrix4(mesh.matrixWorld);
				// Degenerate (≈ surround world centred on origin) → just look forward.
				const baseVec = new THREE.Vector3(base.x, base.y, base.z);
				if (look.distanceTo(baseVec) < 0.1) {
					look.set(base.x, base.y, base.z - 1);
				}
				return { look, scale: Math.max(0.5, look.distanceTo(baseVec)) };
			}

			/** Fallback for a world with NO baked pose: render immediately from the
			 *  default forward aim, and refine with the full splat scan only once the
			 *  main thread is IDLE — matchmaking timers and route transitions must
			 *  never wait behind a background aesthetic. */
			function deferAutoViewpoint(mesh: SplatMeshType, url: string) {
				if (dev) {
					console.warn(
						`[splat] no baked pose for ${url} — deferring the full splat scan to idle. ` +
							'Bake one with `node scripts/compute-splat-poses.mjs` before shipping this world.'
					);
				}
				const run = () => {
					// The world may have been switched/unmounted while we waited.
					if (disposed || lastUrl !== url || !layers.some((l) => l.mesh === mesh)) return;
					const { look, scale } = weightedViewpoint(mesh, basePos);
					lookCenter.set(look.x, look.y, look.z);
					sceneScale = scale;
				};
				if (typeof requestIdleCallback === 'function') {
					requestIdleCallback(() => run(), { timeout: 4000 });
				} else {
					setTimeout(run, 600);
				}
			}

			function resize() {
				const w = el.clientWidth || window.innerWidth;
				const h = el.clientHeight || window.innerHeight;
				renderer.setSize(Math.round(w * RENDER_SCALE), Math.round(h * RENDER_SCALE), false);
				camera.aspect = w / h;
				camera.updateProjectionMatrix();
			}
			resize();
			// Debounce resize so orientation changes / mobile toolbar show-hide (which fire
			// a rapid burst of ResizeObserver callbacks) don't thrash GPU buffer resizes.
			let resizeTimer = 0;
			const ro = new ResizeObserver(() => {
				if (resizeTimer) clearTimeout(resizeTimer);
				resizeTimer = window.setTimeout(() => {
					resizeTimer = 0;
					if (!disposed) resize();
				}, 120);
			});
			ro.observe(el);

			// ── World-switch warp: punch out to the void, swap under cover, rush in ──
			const WARP_OUT = 0.18; // seconds — fast accelerate into darkness
			const WARP_IN = 0.6; // seconds — dynamic zoom into the new world
			let warpPhase = 0; // 0 idle · 1 out · 2 in
			let warpT = 0; // seconds elapsed in the current phase
			let warp = 0; // 0..1 darkness + camera pull-back amount

			async function load(url: string | null) {
				if (url === lastUrl) return;
				// A real switch (not the first world) warps through the void; the very
				// first load just fades in normally.
				const isSwitch = lastUrl !== null && layers.length > 0 && !reduceMotion;
				lastUrl = url;
				// Begin fading out whatever is currently shown.
				for (const l of layers) l.target = 0;
				if (!url) return;
				if (isSwitch) {
					// Re-arm from the current darkness so rapid switches stay smooth.
					warpT = Math.sqrt(Math.max(0, warp)) * WARP_OUT;
					warpPhase = 1;
				}

				// HEAVY-STAGE GATES (backgroundGate): the fetch+decode below and the
				// first GPU upload/render after scene.add are real multi-second native
				// main-thread stalls. A latency-sensitive flow (Quick Play polling, a
				// held matched-room navigation) takes a HOLD; each gate parks this
				// pipeline until release, so a search started even MID-INIT never has
				// its timers starved by a background aesthetic.
				await whenHeavyBackgroundReleased();
				if (disposed || lastUrl !== url) return;
				const mesh = new SplatMesh({ url });
				mesh.rotation.copy(ORIENT);
				mesh.opacity = 0;
				try {
					await mesh.initialized;
				} catch {
					return; // load failed — keep showing the previous world
				}
				if (disposed) {
					mesh.dispose();
					return;
				}
				// A hold may have arrived DURING decode — park before the upload stall.
				await whenHeavyBackgroundReleased();
				if (disposed || lastUrl !== url) {
					mesh.dispose();
					return;
				}
				scene.add(mesh);
				const pose = POSE_BY_URL[url];
				if (pose) {
					basePos.fromArray(pose.base);
					lookCenter.fromArray(pose.look);
					sceneScale = Math.max(0.5, lookCenter.distanceTo(basePos));
				} else {
					// Default aim NOW (cheap), full scan only when the thread is idle.
					basePos.set(0, 0, 0);
					lookCenter.set(0, 0, -1);
					sceneScale = 5;
					deferAutoViewpoint(mesh, url);
				}
				layers.push({ mesh, target: 1 });
				hasSplat = true;
			}

			applySrc = (url) => void load(url);
			void load(src);

			// DEV-ONLY pose-baking hook for scripts/compute-splat-poses.mjs: computes a
			// world's auto viewpoint with the EXACT runtime algorithm (same ORIENT, same
			// weighting) so the baked table can never drift from what the fallback would
			// have produced. Never present in production builds.
			if (dev) {
				(
					window as unknown as {
						__arcSplatPose?: (url: string) => Promise<{
							base: [number, number, number];
							look: [number, number, number];
						} | null>;
					}
				).__arcSplatPose = async (url: string) => {
					const probe = new SplatMesh({ url });
					probe.rotation.copy(ORIENT);
					try {
						await probe.initialized;
						const { look } = weightedViewpoint(probe, { x: 0, y: 0, z: 0 });
						return {
							base: [0, 0, 0],
							look: [
								Number(look.x.toFixed(3)),
								Number(look.y.toFixed(3)),
								Number(look.z.toFixed(3))
							]
						};
					} catch {
						return null;
					} finally {
						probe.dispose();
					}
				};
			}

			const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			const clock = new THREE.Clock();

			// ── Auto camera: a gentle bounded random walk from the capture point ────
			// Position barely drifts; the view (yaw/pitch) looks around more. Each value
			// takes an Ornstein–Uhlenbeck step (small random nudge + pull back to 0) so
			// it wanders without ever straying far.
			const POS_LIMIT = { x: 0.3, y: 0.1, z: 0.3 };
			const YAW_LIMIT = 0.32; // ~18° left/right
			const PITCH_LIMIT = 0.12; // ~7° up/down
			const tgt = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
			const cur = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
			// Eased dolly amount (0..1): chases cam.push so entering a realm glides in.
			let pushCur = 0;
			// Rising-edge latch so onZoomSettled fires exactly ONCE per arrival at full push
			// (not every frame the eased dolly sits at the target). Reset when the dolly is
			// pulled back below the midpoint so a later enter beat fires again.
			let settledFired = false;
			const BASE_FOV = 65;
			const wander = (v: number, limit: number, dt: number) => {
				const next = v - 0.2 * v * dt + limit * 0.8 * (Math.random() * 2 - 1) * Math.sqrt(dt);
				return Math.max(-limit, Math.min(limit, next));
			};
			// Scratch vectors for aiming (reused each frame, no per-frame allocation).
			const _fwd = new THREE.Vector3();
			const _right = new THREE.Vector3();
			const _up = new THREE.Vector3();
			const _look = new THREE.Vector3();
			const _worldUp = new THREE.Vector3(0, 1, 0);

			// ── Manual fly camera (authoring aid; active only while `controls`) ─────
			const keys = new Set<string>();
			const lookDelta = { x: 0, y: 0 };
			const fly = { pos: new THREE.Vector3(), yaw: 0, pitch: 0 };
			let locked = false;
			let wasActive = false;
			const _mvF = new THREE.Vector3();
			const _mvR = new THREE.Vector3();
			const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
			const _dir = new THREE.Vector3();
			const _tmpC = new THREE.Vector3();

			function logPose() {
				const p = camera.position;
				const c = _tmpC
					.copy(p)
					.addScaledVector(camera.getWorldDirection(_dir), Math.max(1, sceneScale));
				// eslint-disable-next-line no-console
				console.log(
					`[splat pose] ${lastUrl ?? ''}\n` +
						`basePos.set(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)});\n` +
						`lookCenter.set(${c.x.toFixed(3)}, ${c.y.toFixed(3)}, ${c.z.toFixed(3)});`
				);
			}

			const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space'];
			const onKeyDown = (e: KeyboardEvent) => {
				if (!ui.active) return;
				keys.add(e.code);
				if (e.code === 'KeyP') logPose();
				if (MOVE_KEYS.includes(e.code)) e.preventDefault();
			};
			const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
			const onMouseMove = (e: MouseEvent) => {
				if (!ui.active || !locked) return;
				lookDelta.x += e.movementX * 0.0022;
				lookDelta.y += e.movementY * 0.0022;
			};
			const onLockChange = () => {
				locked = document.pointerLockElement === el;
			};
			const onClick = () => {
				if (ui.active && !locked) el.requestPointerLock();
			};
			window.addEventListener('keydown', onKeyDown);
			window.addEventListener('keyup', onKeyUp);
			document.addEventListener('mousemove', onMouseMove);
			document.addEventListener('pointerlockchange', onLockChange);
			el.addEventListener('click', onClick);

			let lastFrameAt = 0;
			function frame(now = 0) {
				raf = requestAnimationFrame(frame);
				// Pause all GPU work while the tab/app is backgrounded — a full splat scene
				// drawn behind a hidden window is pure battery/thermal waste on mobile.
				if (typeof document !== 'undefined' && document.hidden) return;
				// Throttle to the player's chosen cap (30/60; 0 ⇒ Off, but a contained
				// preview may still be mounted, so fall back to 30 rather than freezing).
				// 0.5ms tolerance so a 60Hz display's ~16.6ms ticks aren't dropped at the 60 cap.
				const fps = q.fps > 0 ? q.fps : 30;
				if (now - lastFrameAt < 1000 / fps - 0.5) return;
				lastFrameAt = now;
				// Clamp the frame delta: after a tab refocus / GC stall / the first frame
				// post-load, getDelta() can be multiple seconds, which would otherwise snap
				// every dt-driven easing (dolly, crossfade, wander) instead of gliding.
				const dt = Math.min(clock.getDelta(), 1 / 30);

				// Crossfade layer opacities toward their targets, then reap dead layers.
				for (const l of layers) {
					l.mesh.opacity += (l.target - l.mesh.opacity) * Math.min(1, dt * 3);
				}
				const dead = layers.filter((l) => l.target === 0 && l.mesh.opacity < 0.01);
				if (dead.length) {
					for (const l of dead) {
						scene.remove(l.mesh);
						l.mesh.dispose();
					}
					layers = layers.filter((l) => !dead.includes(l));
				}

				// ── World-switch warp timeline (darkness + camera pull-back amount) ──
				if (warpPhase === 1) {
					warpT += dt;
					const p = Math.min(1, warpT / WARP_OUT);
					warp = p * p; // accelerate hard into the void
					if (p >= 1) {
						warpPhase = 2;
						warpT = 0;
					}
				} else if (warpPhase === 2) {
					warpT += dt;
					const p = Math.min(1, warpT / WARP_IN);
					const s = p * p * (3 - 2 * p); // smoothstep — hold dark, then arrive
					warp = 1 - s;
					if (p >= 1) {
						warpPhase = 0;
						warp = 0;
					}
				}
				if (warpEl) warpEl.style.opacity = warp > 0.001 ? warp.toFixed(3) : '0';

				if (ui.active) {
					// ── Manual fly camera ──────────────────────────────────────────
					if (!wasActive) {
						// Entering fly mode: seed from wherever the auto camera was.
						fly.pos.copy(camera.position);
						_euler.setFromQuaternion(camera.quaternion);
						fly.yaw = _euler.y;
						fly.pitch = _euler.x;
						keys.clear();
						wasActive = true;
						// Start fly mode from the true resting capture pose so logged poses
						// are reproducible (undo any realm dolly / FOV narrowing).
						pushCur = 0;
						if (camera.fov !== BASE_FOV) {
							camera.fov = BASE_FOV;
							camera.updateProjectionMatrix();
						}
					}
					fly.yaw -= lookDelta.x;
					fly.pitch -= lookDelta.y;
					fly.pitch = Math.max(-1.45, Math.min(1.45, fly.pitch));
					lookDelta.x = 0;
					lookDelta.y = 0;
					camera.rotation.set(fly.pitch, fly.yaw, 0);

					const fast = keys.has('ShiftLeft') || keys.has('ShiftRight');
					const speed = sceneScale * (fast ? 1.1 : 0.4) * dt;
					_mvF.set(0, 0, -1).applyEuler(camera.rotation);
					_mvR.set(1, 0, 0).applyEuler(camera.rotation);
					if (keys.has('KeyW')) fly.pos.addScaledVector(_mvF, speed);
					if (keys.has('KeyS')) fly.pos.addScaledVector(_mvF, -speed);
					if (keys.has('KeyD')) fly.pos.addScaledVector(_mvR, speed);
					if (keys.has('KeyA')) fly.pos.addScaledVector(_mvR, -speed);
					if (keys.has('KeyE') || keys.has('Space')) fly.pos.y += speed;
					if (keys.has('KeyQ')) fly.pos.y -= speed;
					camera.position.copy(fly.pos);

					if (poseEl) {
						const p = fly.pos;
						const deg = (r: number) => ((r * 180) / Math.PI).toFixed(0);
						poseEl.textContent =
							`pos ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}  ·  ` +
							`yaw ${deg(fly.yaw)}°  pitch ${deg(fly.pitch)}°`;
					}
				} else {
					wasActive = false;

					// Advance the random-walk targets (position drifts a little; yaw/pitch
					// look around more), then ease the camera toward them for smoothness.
					if (!reduceMotion) {
						tgt.x = wander(tgt.x, POS_LIMIT.x, dt);
						tgt.y = wander(tgt.y, POS_LIMIT.y, dt);
						tgt.z = wander(tgt.z, POS_LIMIT.z, dt);
						tgt.yaw = wander(tgt.yaw, YAW_LIMIT, dt);
						tgt.pitch = wander(tgt.pitch, PITCH_LIMIT, dt);
					}
					const ease = Math.min(1, dt * 0.9);
					cur.x += (tgt.x - cur.x) * ease;
					cur.y += (tgt.y - cur.y) * ease;
					cur.z += (tgt.z - cur.z) * ease;
					cur.yaw += (tgt.yaw - cur.yaw) * ease;
					cur.pitch += (tgt.pitch - cur.pitch) * ease;

					// Sit at the capture point (+ tiny drift) and aim at the well-observed
					// content. "Looking around" nudges the aim point within the camera's own
					// right/up plane, scaled by distance so the sweep is a consistent angle.
					camera.position.set(basePos.x + cur.x, basePos.y + cur.y, basePos.z + cur.z);
					// Dolly toward the well-observed content as `push` ramps up — the camera
					// glides a chunk of the way in, and the FOV narrows slightly, so stepping
					// into a realm reads as moving forward rather than a hard cut.
					// Ease the dolly with frame-rate-independent exponential smoothing;
					// reduced-motion users get an instant snap rather than a glide + zoom.
					pushCur = reduceMotion
						? cam.push
						: pushCur + (cam.push - pushCur) * (1 - Math.exp(-1.6 * dt));
					// Fire onZoomSettled on the rising edge of reaching full push — the moment
					// the realm-enter dolly has arrived. Re-arm once the dolly is pulled back so a
					// subsequent enter beat fires again. (Reduced-motion snaps pushCur=cam.push, so
					// this still fires on the next frame.)
					if (cam.push < 0.5) settledFired = false;
					else if (cam.push >= 0.999 && Math.abs(pushCur - cam.push) < 0.01 && !settledFired) {
						settledFired = true;
						cb.settled?.();
					}
					// Dolly toward content (push) and pull back into the void (warp) in one
					// move; FOV narrows on the realm push and widens hard during a warp.
					const dollyT = pushCur * 0.55 - warp * 0.6;
					if (Math.abs(dollyT) > 0.001) camera.position.lerp(lookCenter, dollyT);
					const wantFov = BASE_FOV - pushCur * 12 + warp * 30;
					if (Math.abs(camera.fov - wantFov) > 0.05) {
						camera.fov = wantFov;
						camera.updateProjectionMatrix();
					}
					_fwd.copy(lookCenter).sub(camera.position).normalize();
					_right.crossVectors(_fwd, _worldUp).normalize();
					_up.crossVectors(_right, _fwd).normalize();
					const dist = camera.position.distanceTo(lookCenter) || 1;
					_look
						.copy(lookCenter)
						.addScaledVector(_right, Math.tan(cur.yaw) * dist)
						.addScaledVector(_up, Math.tan(cur.pitch) * dist);
					camera.lookAt(_look);
				}

				renderer.render(scene, camera);
			}
			frame();

			teardown = () => {
				cancelAnimationFrame(raf);
				if (resizeTimer) clearTimeout(resizeTimer);
				ro.disconnect();
				window.removeEventListener('keydown', onKeyDown);
				window.removeEventListener('keyup', onKeyUp);
				document.removeEventListener('mousemove', onMouseMove);
				document.removeEventListener('pointerlockchange', onLockChange);
				el.removeEventListener('click', onClick);
				if (document.pointerLockElement === el) document.exitPointerLock();
				for (const l of layers) {
					scene.remove(l.mesh);
					l.mesh.dispose();
				}
				layers = [];
				renderer.dispose();
				applySrc = null;
			};
		})();

		return () => {
			disposed = true;
			teardown?.();
		};
	});

	// Push URL changes into the running renderer.
	$effect(() => {
		const url = src;
		applySrc?.(url);
	});
</script>

<div class="splat-bg" class:controlling={controls} aria-hidden="true">
	<canvas
		bind:this={canvas}
		class="splat-canvas"
		class:visible={hasSplat}
		style:filter={blur > 0 ? `blur(${blur}px)` : null}
		style:transform={blur > 0 ? 'scale(1.12)' : 'none'}
	></canvas>

	<div bind:this={warpEl} class="warp-veil" aria-hidden="true"></div>

	{#if controls}
		<div class="fly-hud">
			<div class="fly-keys">
				click to look · <b>WASD</b> move · <b>Q/E</b> down/up · <b>Shift</b> faster · <b>P</b> log
				pose · <b>`</b> exit
			</div>
			<div bind:this={poseEl} class="fly-pose">click the scene, then move…</div>
		</div>
	{:else if !contained}
		<div class="vignette"></div>
	{/if}
</div>

<style>
	.splat-bg {
		position: absolute;
		inset: 0;
		overflow: hidden;
	}
	.splat-bg.controlling {
		cursor: crosshair;
	}
	.splat-canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		/* When blurred, the canvas is scaled up inline so the blur's soft edge bleeds
		   past the viewport instead of revealing the canvas rectangle. */
		transform-origin: center;
		opacity: 0;
		transition:
			opacity 700ms ease,
			filter 800ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.splat-canvas.visible {
		opacity: 1;
	}
	/* World-switch void veil: opacity is driven imperatively by the warp loop. A
	   radial so the centre collapses to black last, reading as a tunnel/portal. */
	.warp-veil {
		position: absolute;
		inset: 0;
		z-index: 1;
		pointer-events: none;
		opacity: 0;
		background: radial-gradient(circle at 50% 50%, #050309 0%, #0a0616 55%, #06040f 100%);
	}
	/* Heavy vignette: light universal dim + near-opaque edges to push the world
	   back and spotlight the action in the middle. */
	.vignette {
		position: absolute;
		inset: 0;
		pointer-events: none;
		background: radial-gradient(
			ellipse 78% 78% at 50% 45%,
			rgba(8, 5, 16, 0.12) 0%,
			rgba(8, 5, 16, 0.12) 28%,
			rgba(8, 5, 16, 0.58) 66%,
			rgba(8, 5, 16, 0.95) 100%
		);
	}
	/* Fly-mode heads-up display. pointer-events:none so clicks reach the canvas. */
	.fly-hud {
		position: absolute;
		left: 50%;
		bottom: 18px;
		transform: translateX(-50%);
		z-index: 2;
		display: flex;
		flex-direction: column;
		gap: 6px;
		align-items: center;
		padding: 10px 16px;
		border-radius: 8px;
		background: rgba(8, 5, 16, 0.82);
		border: 1px solid rgba(255, 255, 255, 0.12);
		color: #e7e0cf;
		font-family: var(--font-display, monospace);
		font-size: 0.8rem;
		letter-spacing: 0.04em;
		text-align: center;
		pointer-events: none;
	}
	.fly-keys b {
		color: var(--brand-cyan, #5cdfff);
	}
	.fly-pose {
		font-variant-numeric: tabular-nums;
		color: var(--brand-amber, #ffba3d);
	}
</style>

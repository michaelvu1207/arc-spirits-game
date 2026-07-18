<script lang="ts">
	import { onMount } from 'svelte';
	import { getGraphicsSettings } from '$lib/stores/graphicsSettings.svelte';
	import type { Mesh, Object3D, Vector3 } from 'three';
	import {
		guardianSeed,
		momentConfig,
		qualityConfig,
		type SpiritMoment,
		type VisualQuality
	} from '$lib/visual/lowPolyLanguage';

	interface Props {
		guardianName?: string;
		moment?: SpiritMoment;
		accent?: string;
		label?: string;
		compact?: boolean;
	}

	let {
		guardianName = 'Arc Spirit',
		moment = 'guardian',
		accent = '#65f3e1',
		label = '',
		compact = false
	}: Props = $props();

	const graphics = getGraphicsSettings();
	let canvas = $state<HTMLCanvasElement>();
	let rendererReady = $state(false);
	let rendererFailed = $state(false);
	let activate: (() => void) | null = null;
	const live = {
		guardianName: '',
		moment: 'guardian' as SpiritMoment,
		accent: '#65f3e1',
		quality: 'balanced' as VisualQuality,
		reduced: false
	};

	$effect(() => {
		live.guardianName = guardianName;
		live.moment = moment;
		live.accent = accent;
		live.quality = graphics.visualQuality;
		live.reduced = graphics.reducedMotion;
		activate?.();
	});

	onMount(() => {
		let disposed = false;
		let creating = false;
		let teardown: (() => void) | null = null;
		let refresh: (() => void) | null = null;

		async function createRenderer() {
			if (creating || disposed || teardown || !canvas || live.quality === 'off') return;
			creating = true;
			try {
				const THREE = await import('three');
				if (disposed || !canvas) return;
				const el = canvas;
				const renderer = new THREE.WebGLRenderer({ canvas: el, alpha: true, antialias: false, powerPreference: 'low-power' });
				renderer.setClearColor(0x000000, 0);
				const scene = new THREE.Scene();
				const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 30);
				camera.position.set(0, 0.05, 5.1);
				const root = new THREE.Group();
				scene.add(root);

				const ambient = new THREE.HemisphereLight(0xf5f0ff, 0x180d33, 1.8);
				const key = new THREE.DirectionalLight(0xffffff, 3.2);
				key.position.set(3, 4, 5);
				const rim = new THREE.PointLight(0xff2bc7, 9, 12, 2);
				rim.position.set(-2.5, 0.5, 2.5);
				scene.add(ambient, key, rim);

				let animated: Object3D[] = [];
				let shards: Mesh[] = [];
				let core: Mesh | null = null;
				let halo: Mesh | null = null;
				let lastSignature = '';

				function clearRoot() {
					for (const child of [...root.children]) {
						root.remove(child);
						child.traverse((node) => {
							if (node instanceof THREE.Mesh) {
								node.geometry.dispose();
								const materials = Array.isArray(node.material) ? node.material : [node.material];
								for (const material of materials) material.dispose();
							}
						});
					}
					animated = [];
					shards = [];
					core = null;
					halo = null;
				}

				function rebuild() {
					const signature = `${live.guardianName}|${live.moment}|${live.accent}`;
					if (signature === lastSignature) return;
					lastSignature = signature;
					clearRoot();
					const config = momentConfig(live.moment);
					const seed = guardianSeed(live.guardianName);
					const primary = new THREE.Color(live.accent);
					const secondary = new THREE.Color(live.moment === 'corruption' ? '#ff5b6e' : live.moment === 'reward' || live.moment === 'victory' ? '#ffce45' : '#ff2bc7');
					const coreMaterial = new THREE.MeshStandardMaterial({ color: primary, emissive: primary, emissiveIntensity: 0.32, roughness: 0.38, metalness: 0.16, flatShading: true });
					core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.86, 1), coreMaterial);
					core.rotation.set(((seed >>> 4) % 16) / 16, ((seed >>> 9) % 20) / 18, 0.18);
					root.add(core);

					const inner = new THREE.Mesh(new THREE.OctahedronGeometry(0.48, 0), new THREE.MeshStandardMaterial({ color: '#f5f0ff', emissive: secondary, emissiveIntensity: 0.65, roughness: 0.2, flatShading: true }));
					inner.rotation.z = Math.PI / 4;
					root.add(inner);
					animated.push(inner);

					for (let index = 0; index < config.rings; index += 1) {
						const ring = new THREE.Mesh(
							new THREE.TorusGeometry(1.15 + index * 0.23, 0.016 + index * 0.005, 4, 40),
							new THREE.MeshBasicMaterial({ color: index % 2 ? secondary : primary, transparent: true, opacity: 0.5 - index * 0.06 })
						);
						ring.rotation.set(Math.PI * (0.25 + index * 0.16), Math.PI * (0.14 + index * 0.11), index * 0.35);
						root.add(ring);
						animated.push(ring);
						if (index === 0) halo = ring;
					}

					for (let index = 0; index < config.shards; index += 1) {
						const angle = (index / config.shards) * Math.PI * 2 + ((seed % 53) / 53) * 0.7;
						const radius = 1.5 + ((seed >>> (index % 20)) & 3) * 0.11;
						const shard = new THREE.Mesh(
							new THREE.TetrahedronGeometry(0.11 + (index % 3) * 0.025, 0),
							new THREE.MeshStandardMaterial({ color: index % 3 === 0 ? secondary : primary, emissive: primary, emissiveIntensity: 0.2, roughness: 0.46, flatShading: true })
						);
						shard.position.set(Math.cos(angle) * radius, Math.sin(angle * 1.3) * 0.62, Math.sin(angle) * 0.58);
						shard.rotation.set(angle, angle * 0.5, index * 0.4);
						shard.userData.base = shard.position.clone();
						shard.userData.phase = angle;
						root.add(shard);
						shards.push(shard);
					}
				}

				function resize() {
					const width = Math.max(1, el.clientWidth);
					const height = Math.max(1, el.clientHeight);
					const quality = qualityConfig(live.quality);
					const ratio = Math.min(window.devicePixelRatio || 1, quality.pixelRatio || 1);
					renderer.setPixelRatio(Math.max(0.5, ratio));
					renderer.setSize(width, height, false);
					camera.aspect = width / height;
					camera.updateProjectionMatrix();
				}

				const observer = new ResizeObserver(resize);
				observer.observe(el);
				rebuild();
				resize();
				rendererReady = true;
				creating = false;

				let raf = 0;
				let lastFrame = 0;
				function render(time: number) {
					raf = requestAnimationFrame(render);
					if (document.hidden || live.quality === 'off') return;
					const quality = qualityConfig(live.quality);
					const frameMs = 1000 / Math.max(1, quality.fps);
					if (time - lastFrame < frameMs) return;
					lastFrame = time;
					rebuild();
					const config = momentConfig(live.moment);
					const t = live.reduced ? 0.7 : time / 1000;
					root.rotation.y = live.reduced ? 0.3 : t * config.spin;
					root.rotation.x = 0.04 + Math.sin(t * 0.35) * (live.reduced ? 0 : 0.04);
					const pulse = 1 + Math.sin(t * 1.8) * (live.reduced ? 0 : config.pulse);
					core?.scale.setScalar(pulse);
					if (halo) halo.scale.setScalar(1 + (pulse - 1) * 0.55);
					animated.forEach((object, index) => {
						if (!live.reduced) object.rotation.z += 0.0025 * (index % 2 ? -1 : 1) * config.spin;
					});
					const visibleShards = Math.max(1, Math.round(shards.length * quality.shardScale));
					shards.forEach((shard, index) => {
						shard.visible = index < visibleShards;
						if (!shard.visible) return;
						const base = shard.userData.base as Vector3;
						const phase = shard.userData.phase as number;
						shard.position.y = base.y + (live.reduced ? 0 : Math.sin(t * 1.25 + phase) * 0.11);
					});
					renderer.render(scene, camera);
				}
				raf = requestAnimationFrame(render);

				refresh = () => {
					rebuild();
					resize();
				};
				teardown = () => {
					cancelAnimationFrame(raf);
					observer.disconnect();
					clearRoot();
					renderer.dispose();
				};
			} catch {
				creating = false;
				rendererFailed = true;
			}
		}

		activate = () => {
			if (live.quality === 'off') {
				rendererReady = false;
				return;
			}
			if (teardown) {
				rendererReady = true;
				refresh?.();
			} else {
				void createRenderer();
			}
		};
		activate();

		return () => {
			disposed = true;
			activate = null;
			teardown?.();
		};
	});
</script>

<div
	class="spirit-stage"
	class:compact
	class:static-only={graphics.visualQuality === 'off' || rendererFailed}
	style={`--spirit-accent:${accent}`}
	data-testid="low-poly-spirit-stage"
	data-moment={moment}
	data-quality={graphics.visualQuality}
	aria-label={label || undefined}
	aria-hidden={label ? undefined : 'true'}
>
	<div class="fallback" aria-hidden="true"><i></i><b></b><span></span><em></em></div>
	<canvas bind:this={canvas} class:ready={rendererReady} aria-hidden="true"></canvas>
</div>

<style>
	.spirit-stage { position:relative; width:100%; min-height:220px; overflow:hidden; isolation:isolate; pointer-events:none; contain:layout paint; }
	.spirit-stage.compact { min-height:132px; }
	canvas { position:absolute; inset:0; width:100%; height:100%; opacity:0; transition:opacity 240ms ease; }
	canvas.ready { opacity:1; }
	.fallback { position:absolute; inset:0; display:grid; place-items:center; filter:drop-shadow(0 0 24px color-mix(in srgb,var(--spirit-accent) 48%,transparent)); opacity:.8; }
	.fallback i,.fallback b,.fallback span,.fallback em { position:absolute; width:min(36%,92px); aspect-ratio:1; border:1px solid color-mix(in srgb,var(--spirit-accent) 70%,transparent); transform:rotate(45deg); }
	.fallback b { width:min(24%,62px); background:color-mix(in srgb,var(--spirit-accent) 18%,transparent); }
	.fallback span { width:min(12%,30px); border:0; background:var(--spirit-accent); box-shadow:0 0 28px var(--spirit-accent); }
	.fallback em { width:min(52%,132px); border-radius:50%; border-color:color-mix(in srgb,var(--spirit-accent) 34%,transparent); transform:rotate(-18deg) scaleY(.36); }
	.spirit-stage:not(.static-only) .fallback { opacity:.18; }
	@media(prefers-reduced-motion:reduce){canvas{transition:none}.fallback{filter:none}}
</style>

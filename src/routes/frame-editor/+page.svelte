<script lang="ts">
	import { onMount } from 'svelte';
	import { loadAssets, getAssetState } from '$lib/stores/assetStore.svelte';
	import { STORAGE_BASE_URL } from '$lib/supabase';
	import {
		FRAME_BLEND_MODES,
		FRAME_CONFIGS,
		frameForOrigin,
		type FrameBlendMode,
		type FrameConfig
	} from '$lib/frameEditor/frameConfig';

	type SpiritChoice = {
		id: string;
		name: string;
		imageUrl: string;
		origin: string;
		frame: FrameConfig;
	};

	let canvas: HTMLCanvasElement;
	let canvasHost: HTMLDivElement;
	let assets = getAssetState();
	let query = $state('');
	let selectedFrameId = $state('fire');
	let selectedSpiritId = $state('');
	let blendMode = $state<FrameBlendMode>('screen');
	let glow = $state(0.7);
	let grain = $state(0.18);
	let hue = $state(0);
	let zoom = $state(0.92);
	let status = $state('Loading the live spirit catalog…');
	let pixiReady = $state(false);
	let renderer: any = null;
	let stage: any = null;
	let frameLayer: any = null;
	let previewAsset = $state<SpiritChoice | null>(null);
	let renderVersion = 0;

	const VERTEX = `#version 300 es
in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
void main() {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 / uOutputTexture.y) - 1.0;
  vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
  gl_Position = vec4(position, 0.0, 1.0);
}`;

	const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uTime;
uniform float uGlow;
uniform float uGrain;
uniform float uHue;
uniform vec3 uTint;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
mat3 hueRotate(float a) {
  float s = sin(a), c = cos(a);
  return mat3(0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
              0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
              0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072);
}
void main() {
  vec4 source = texture(uTexture, vTextureCoord);
  float edge = smoothstep(0.05, 0.55, max(max(source.r, source.g), source.b));
  float shimmer = 0.5 + 0.5 * sin(uTime * 1.4 + vTextureCoord.x * 13.0 + vTextureCoord.y * 7.0);
  float noise = (hash(vTextureCoord * 700.0 + uTime) - 0.5) * uGrain;
  vec3 rgb = hueRotate(uHue) * source.rgb;
  rgb += uTint * (uGlow * (0.25 + 0.75 * shimmer) * edge + noise);
  finalColor = vec4(max(rgb, 0.0), source.a);
}`;

	const originById = $derived(new Map([...assets.originTraits.values()].map((origin) => [origin.id, origin.name])));
	const allSpirits = $derived.by<SpiritChoice[]>(() => {
		return [...assets.spiritAssets.values()]
			.map((spirit) => {
				const originId = spirit.traits.origin_ids[0];
				const origin = originById.get(originId) ?? 'Arcane Spirits';
				const imageUrl = spirit.game_print_image_path
					? spirit.game_print_image_path.startsWith('http')
						? spirit.game_print_image_path
						: `${STORAGE_BASE_URL}/${spirit.game_print_image_path}`
					: '';
				return { id: spirit.id, name: spirit.name, imageUrl, origin, frame: frameForOrigin(origin) };
			})
			.filter((spirit) => spirit.imageUrl)
			.sort((a, b) => a.name.localeCompare(b.name));
	});
	const filteredSpirits = $derived(
		allSpirits.filter((spirit) => {
			const needle = query.trim().toLowerCase();
			return !needle || `${spirit.name} ${spirit.origin} ${spirit.frame.name}`.toLowerCase().includes(needle);
		})
	);
	const selectedFrame = $derived(FRAME_CONFIGS.find((frame) => frame.id === selectedFrameId) ?? FRAME_CONFIGS[0]);
	const sampleSpirits = $derived(
		FRAME_CONFIGS.map((frame) => allSpirits.find((spirit) => spirit.frame.id === frame.id) ?? null)
	);

	function selectSpirit(spirit: SpiritChoice) {
		previewAsset = spirit;
		selectedSpiritId = spirit.id;
		selectedFrameId = spirit.frame.id;
		blendMode = spirit.frame.blendMode;
		void renderPreview();
	}
	function selectFrame(frame: FrameConfig) {
		selectedFrameId = frame.id;
		blendMode = frame.blendMode;
		void renderPreview();
	}
	function selectFirstSpirit() {
		const first = allSpirits[0];
		if (first && !selectedSpiritId) selectSpirit(first);
	}

	async function renderPreview() {
		if (!renderer || !stage || !previewAsset || !canvasHost) return;
		const version = ++renderVersion;
		const pixi = await import('pixi.js');
		const { Assets, Container, Graphics, Sprite, Texture, Filter, GlProgram } = pixi;
		const texture = await Assets.load(previewAsset.imageUrl);
		if (version !== renderVersion) return;
		stage.removeChildren();
		frameLayer = new Container();
		const width = canvasHost.clientWidth || 680;
		const height = canvasHost.clientHeight || 640;
		renderer.resize(width, height);
		stage.position.set(width / 2, height / 2);
		const size = Math.min(width, height) * 0.74 * zoom;
		const points = Array.from({ length: 6 }, (_, i) => {
			const angle = -Math.PI / 2 + (i * Math.PI) / 3;
			return [Math.cos(angle) * size * 0.46, Math.sin(angle) * size * 0.46];
		}).flat();
		const mask = new Graphics().poly(points).fill({ color: 0xffffff });
		const portrait = new Sprite(texture);
		portrait.anchor.set(0.5);
		portrait.setSize(size * 0.86, size * 0.86);
		portrait.mask = mask;
		const backdrop = new Graphics().poly(points).fill({ color: 0x090615, alpha: 0.98 });
		const outer = new Graphics().poly(points).stroke({ color: selectedFrame.colors.outer, width: size * 0.06, alpha: 0.9 });
		const inner = new Graphics().poly(points).stroke({ color: selectedFrame.colors.inner, width: size * 0.018, alpha: 1 });
		const accent = new Graphics();
		for (let i = 0; i < 6; i += 1) {
			const angle = -Math.PI / 2 + (i * Math.PI) / 3;
			accent.circle(Math.cos(angle) * size * 0.46, Math.sin(angle) * size * 0.46, size * 0.028).fill({ color: selectedFrame.colors.accent, alpha: 0.92 });
		}
		const title = new Graphics().roundRect(-size * 0.34, size * 0.23, size * 0.68, size * 0.08, size * 0.02).fill({ color: 0x090615, alpha: 0.78 });
		frameLayer.addChild(backdrop, portrait, mask, outer, inner, accent, title);
		frameLayer.filters = [
			new Filter({
				glProgram: new GlProgram({ vertex: VERTEX, fragment: FRAGMENT }),
				resources: {
					frameUniforms: {
						uTime: { value: 0, type: 'f32' },
						uGlow: { value: glow, type: 'f32' },
						uGrain: { value: grain, type: 'f32' },
						uHue: { value: (hue * Math.PI) / 180, type: 'f32' },
						uTint: { value: hexToRgb(selectedFrame.colors.glow), type: 'vec3<f32>' }
					}
				}
			} as any)
		];
		frameLayer.blendMode = blendMode as any;
		stage.addChild(frameLayer);
		status = `${selectedFrame.name} · ${previewAsset.name}`;
	}

	function hexToRgb(hex: string): [number, number, number] {
		const value = Number.parseInt(hex.replace('#', ''), 16);
		return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
	}

	function exportFrame() {
		if (!renderer) return;
		const data = renderer.canvas.toDataURL('image/png');
		const link = document.createElement('a');
		link.href = data;
		link.download = `${previewAsset?.name ?? 'spirit'}-${selectedFrame.id}-frame.png`;
		link.click();
	}

	onMount(() => {
		let app: any = null;
		void (async () => {
			await loadAssets();
			assets = getAssetState();
			// Pixi ships this runtime patch without a declaration file.
			// @ts-expect-error Pixi runtime-only export
			await import('pixi.js/unsafe-eval');
			const pixi = await import('pixi.js');
			app = new pixi.Application();
			await app.init({ canvas, resizeTo: canvasHost, backgroundAlpha: 0, antialias: true, preference: 'webgl' });
			renderer = app.renderer;
			stage = app.stage;
			pixiReady = true;
			const ticker = app.ticker;
			ticker.add(() => {
				if (frameLayer?.filters?.[0]?.resources?.frameUniforms?.uniforms) {
					frameLayer.filters[0].resources.frameUniforms.uniforms.uTime += ticker.deltaTime / 60;
				}
			});
			status = 'Live catalog ready';
			selectFirstSpirit();
		})();
		return () => app?.destroy(true, { children: true, texture: false, context: true });
	});
</script>

<svelte:head>
	<title>Frame Editor · Arc Spirits</title>
	<meta name="description" content="Collaborative shader frame editor for Arc Spirits." />
</svelte:head>

<div class="editor-shell">
	<header class="topbar">
		<div><span class="eyebrow">ARC SPIRITS / FRAME LAB</span><h1>Frame Editor</h1></div>
		<div class="top-actions"><span class:ready={pixiReady} class="engine-chip">{pixiReady ? 'PIXI WEBGL READY' : 'STARTING RENDERER'}</span><button class="export" onclick={exportFrame}>Export PNG</button></div>
	</header>
	<div class="workspace">
		<aside class="gallery-panel">
			<div class="panel-head"><div><span class="eyebrow">SPIRIT CATALOG</span><h2>Showcase set</h2></div><span class="count">{filteredSpirits.length}</span></div>
			<input class="search" bind:value={query} placeholder="Search spirits, origins…" aria-label="Search spirits" />
			<div class="sample-grid">
				{#each sampleSpirits as sample, i (FRAME_CONFIGS[i].id)}
					{#if sample}<button class="sample" class:selected={sample.id === selectedSpiritId} onclick={() => selectSpirit(sample)}><img src={sample.imageUrl} alt={sample.name} loading="lazy" /><span class="sample-overlay"><strong>{FRAME_CONFIGS[i].shortName}</strong><small>{sample.name}</small></span></button>{/if}
				{/each}
			</div>
			<div class="spirit-list">
				{#each filteredSpirits as spirit (spirit.id)}<button class="spirit-row" class:selected={spirit.id === selectedSpiritId} onclick={() => selectSpirit(spirit)}><img src={spirit.imageUrl} alt="" loading="lazy" /><span><strong>{spirit.name}</strong><small>{spirit.origin} · {spirit.frame.shortName}</small></span></button>{/each}
			</div>
		</aside>
		<main class="stage-panel">
			<div class="stage-head"><div><span class="eyebrow">LIVE PREVIEW</span><h2>{previewAsset?.name ?? 'Choose a spirit'}</h2></div><span class="status">{status}</span></div>
			<div class="canvas-wrap" bind:this={canvasHost}><canvas bind:this={canvas} aria-label="Shader frame preview"></canvas><div class="canvas-hint">Drag the controls on the right to shape the frame</div></div>
		</main>
		<aside class="inspector-panel">
			<div class="panel-head"><div><span class="eyebrow">FRAME SYSTEM</span><h2>Configuration</h2></div><span class="live-dot"></span></div>
			<label>Frame family<select value={selectedFrameId} onchange={(event) => { const frame = FRAME_CONFIGS.find((candidate) => candidate.id === event.currentTarget.value); if (frame) selectFrame(frame); }}>
				{#each FRAME_CONFIGS as frame}<option value={frame.id}>{frame.name}</option>{/each}
			</select></label>
			<p class="description">{selectedFrame.description}</p>
			<label>Blend mode<select bind:value={blendMode} onchange={() => renderPreview()}>{#each FRAME_BLEND_MODES as mode}<option value={mode}>{mode}</option>{/each}</select></label>
			<label>Glow <output>{Math.round(glow * 100)}%</output><input type="range" min="0" max="1.5" step="0.01" bind:value={glow} oninput={() => renderPreview()} /></label>
			<label>Shader grain <output>{Math.round(grain * 100)}%</output><input type="range" min="0" max="0.8" step="0.01" bind:value={grain} oninput={() => renderPreview()} /></label>
			<label>Hue shift <output>{hue}°</output><input type="range" min="-180" max="180" step="1" bind:value={hue} oninput={() => renderPreview()} /></label>
			<label>Preview zoom <output>{Math.round(zoom * 100)}%</output><input type="range" min="0.65" max="1.15" step="0.01" bind:value={zoom} oninput={() => renderPreview()} /></label>
			<div class="swatches"><span style={`--swatch:${selectedFrame.colors.outer}`}></span><span style={`--swatch:${selectedFrame.colors.inner}`}></span><span style={`--swatch:${selectedFrame.colors.accent}`}></span><small>Outer · inner · accent</small></div>
			<div class="future"><span class="eyebrow">COLLAB READY</span><p>Next: save frame presets, compare revisions, and invite collaborators into the same scene.</p></div>
		</aside>
	</div>
</div>

<style>
	:global(body) { margin: 0; background: #06040e; color: #f8f4ff; }
	.editor-shell { min-height: 100vh; background: radial-gradient(circle at 50% 0%, #23124a 0%, transparent 38%), #06040e; font-family: var(--font-body, Inter, system-ui, sans-serif); }
	.topbar { display:flex; justify-content:space-between; align-items:center; gap:1rem; padding:1.2rem clamp(1rem,3vw,3rem); border-bottom:1px solid rgba(255,255,255,.1); background:rgba(7,4,18,.86); backdrop-filter:blur(18px); }
	h1,h2,p { margin:0; } h1 { font-family:var(--font-display, Impact, sans-serif); letter-spacing:.06em; text-transform:uppercase; font-size:clamp(1.6rem,3vw,2.6rem); } h2 { font-family:var(--font-display, Impact, sans-serif); letter-spacing:.04em; font-size:1.15rem; text-transform:uppercase; }
	.eyebrow { display:block; color:#8de9ff; font-size:.64rem; letter-spacing:.18em; font-weight:800; text-transform:uppercase; }
	.top-actions { display:flex; align-items:center; gap:.75rem; } .engine-chip,.count,.status { color:#aaa4c0; font-size:.7rem; letter-spacing:.08em; text-transform:uppercase; } .engine-chip.ready { color:#78f2c9; }
	.export { border:1px solid #ff4bd6; color:#fff; background:#a71b81; border-radius:999px; padding:.65rem 1rem; font-weight:800; cursor:pointer; }
	.workspace { display:grid; grid-template-columns:minmax(220px,300px) minmax(420px,1fr) minmax(220px,300px); min-height:calc(100vh - 92px); }
	.gallery-panel,.inspector-panel { padding:1.2rem; background:rgba(10,6,24,.76); } .gallery-panel { border-right:1px solid rgba(255,255,255,.08); } .inspector-panel { border-left:1px solid rgba(255,255,255,.08); }
	.panel-head,.stage-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; margin-bottom:1rem; }
	.search,select { width:100%; box-sizing:border-box; border:1px solid #3c2b63; border-radius:9px; background:#0d081e; color:#fff; padding:.7rem .8rem; font:inherit; } label { display:grid; gap:.45rem; margin-top:1rem; color:#c9c3d9; font-size:.82rem; } output { float:right; color:#8de9ff; }
	.sample-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:.45rem; margin:1rem 0; } .sample { position:relative; aspect-ratio:1/1.12; overflow:hidden; border:1px solid #3c2b63; border-radius:10px; padding:0; background:#0c0718; cursor:pointer; } .sample.selected { border-color:#ff4bd6; box-shadow:0 0 0 2px #ff4bd655; } .sample img { width:100%; height:100%; object-fit:cover; } .sample-overlay { position:absolute; inset:auto 0 0; padding:.45rem; display:grid; gap:.1rem; text-align:left; background:linear-gradient(transparent,rgba(6,4,14,.95)); } .sample-overlay strong { font-size:.7rem; text-transform:uppercase; } .sample-overlay small { color:#bdb6d0; font-size:.58rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
	.spirit-list { display:grid; gap:.3rem; max-height:calc(100vh - 390px); overflow:auto; margin-top:.75rem; } .spirit-row { display:flex; align-items:center; gap:.6rem; width:100%; border:1px solid transparent; border-radius:8px; padding:.35rem; background:transparent; color:#fff; text-align:left; cursor:pointer; } .spirit-row:hover,.spirit-row.selected { border-color:#5cdfff66; background:#5cdfff12; } .spirit-row img { width:38px; height:38px; object-fit:cover; border-radius:7px; } .spirit-row span { min-width:0; display:grid; gap:.1rem; } .spirit-row strong { font-size:.76rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .spirit-row small { color:#a9a4bd; font-size:.62rem; }
	.stage-panel { display:flex; flex-direction:column; min-width:0; padding:1.2rem; } .canvas-wrap { position:relative; flex:1; min-height:560px; overflow:hidden; border:1px solid #3c2b63; border-radius:16px; background:radial-gradient(circle,#1a0e3d,#070411 70%); } canvas { display:block; width:100%; height:100%; } .canvas-hint { position:absolute; bottom:.8rem; left:50%; transform:translateX(-50%); color:#8e88a5; font-size:.7rem; pointer-events:none; }
	.inspector-panel { display:flex; flex-direction:column; gap:.2rem; } .description { color:#aaa4c0; font-size:.78rem; line-height:1.5; margin:.4rem 0 .6rem; } input[type=range] { accent-color:#ff4bd6; width:100%; } .swatches { display:flex; align-items:center; gap:.45rem; margin-top:1.2rem; flex-wrap:wrap; } .swatches span { width:22px; height:22px; border-radius:6px; background:var(--swatch); box-shadow:0 0 15px var(--swatch); } .swatches small { color:#8e88a5; font-size:.65rem; } .future { margin-top:auto; padding-top:1rem; border-top:1px solid rgba(255,255,255,.08); } .future p { color:#aaa4c0; font-size:.75rem; line-height:1.5; margin-top:.35rem; } .live-dot { width:8px; height:8px; margin-top:.3rem; border-radius:50%; background:#78f2c9; box-shadow:0 0 12px #78f2c9; }
	@media (max-width:1050px) { .workspace { grid-template-columns:230px minmax(360px,1fr); } .inspector-panel { grid-column:1 / -1; border-left:0; border-top:1px solid rgba(255,255,255,.08); display:grid; grid-template-columns:repeat(4,1fr); gap:0 1rem; } .inspector-panel .panel-head,.inspector-panel .description,.inspector-panel .future { grid-column:1 / -1; } }
	@media (max-width:720px) { .topbar { align-items:flex-start; flex-direction:column; } .workspace { display:flex; flex-direction:column; } .gallery-panel { border-right:0; border-bottom:1px solid rgba(255,255,255,.08); } .sample-grid { grid-template-columns:repeat(6,minmax(80px,1fr)); overflow:auto; } .spirit-list { display:none; } .canvas-wrap { min-height:420px; } .inspector-panel { display:flex; } }
</style>

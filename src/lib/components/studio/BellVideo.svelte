<script lang="ts">
	import { onMount } from 'svelte';

	// The looping bell-scene video. Fills its parent; the parent sets the frame.
	let { position = '50% 50%' }: { position?: string } = $props();
	let video = $state<HTMLVideoElement | null>(null);

	onMount(() => {
		// Reduced motion: keep the still poster frame, do not play the loop.
		const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
		const sync = () => {
			if (!video) return;
			if (reduce.matches) video.pause();
			else void video.play().catch(() => {});
		};
		sync();
		reduce.addEventListener('change', sync);
		return () => reduce.removeEventListener('change', sync);
	});
</script>

<video
	bind:this={video}
	style:object-position={position}
	src="/video/bell-scene.mp4"
	poster="/video/bell-scene-poster.jpg"
	autoplay
	muted
	loop
	playsinline
	preload="auto"
	disablepictureinpicture
	aria-hidden="true"
	tabindex="-1"
></video>

<style>
	video {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
		pointer-events: none;
	}
</style>

/**
 * Display-size URLs for game art in the `game_assets` bucket.
 *
 * The bucket holds print-size originals: a spirit front is a ~5 MB 2784px PNG, a
 * guardian mat ~8 MB, a location background up to 13 MB. The play board preloads
 * every image before it starts, so serving originals meant ~400 MB per first visit.
 * Supabase's image-transformation endpoint returns the same art resized (aspect
 * kept, never enlarged) and re-encoded as WebP/AVIF when the browser accepts it —
 * a spirit front drops to ~80 KB. The URL is deterministic per path, so the
 * preloader and every `<img>` share one cache entry.
 *
 * Editors and print/export tools must keep using the original object URLs.
 */
import { ART_PRESIZED, STORAGE_BASE_URL } from '$lib/supabase';

const OBJECT_SEGMENT = '/storage/v1/object/public/';
/** Same bucket through the transformation endpoint; null if the base is not a Supabase object URL,
 *  or when the package's art is already display size (ART_PRESIZED: scripts/package/art.mjs). */
const STORAGE_RENDER_BASE_URL =
	!ART_PRESIZED && STORAGE_BASE_URL.includes(OBJECT_SEGMENT)
		? STORAGE_BASE_URL.replace(OBJECT_SEGMENT, '/storage/v1/render/image/public/')
		: null;

/** Raster formats the transformation endpoint accepts. SVG and the rest pass through. */
const RESIZABLE = /\.(png|jpe?g|webp)$/i;

/** Longest edge (px) for the display copy. Art that is shown large gets more pixels. */
function maxEdgeFor(path: string): number {
	if (/^(game_locations|misc_assets\/(map|spirit_world_map))\//.test(path)) return 1600;
	if (path.startsWith('hex_spirits/')) return 1024;
	// Printed cards (monster faces): their small type must stay readable (~593 x 1024).
	if (path.startsWith('card_images/')) return 1024;
	return 512;
}

/**
 * Display URL for a storage path (or an absolute URL into the bucket). Absolute
 * URLs outside the bucket and non-raster files are returned unchanged.
 */
export function gameImageUrl(path: string | null | undefined): string | null {
	if (!path) return null;
	let rel = path;
	if (/^https?:/.test(path)) {
		if (!path.startsWith(`${STORAGE_BASE_URL}/`)) return path;
		rel = path.slice(STORAGE_BASE_URL.length + 1);
	}
	if (!STORAGE_RENDER_BASE_URL || !RESIZABLE.test(rel)) return `${STORAGE_BASE_URL}/${rel}`;
	const edge = maxEdgeFor(rel);
	return `${STORAGE_RENDER_BASE_URL}/${rel}?width=${edge}&height=${edge}&resize=contain&quality=80`;
}

/** The original object URL behind a display URL, or null if `url` is not one. */
export function originalImageUrl(url: string): string | null {
	if (!STORAGE_RENDER_BASE_URL || !url.startsWith(`${STORAGE_RENDER_BASE_URL}/`)) return null;
	return `${STORAGE_BASE_URL}/${url.slice(STORAGE_RENDER_BASE_URL.length + 1).split('?')[0]}`;
}

/**
 * Safety net: if the transformation endpoint ever refuses a request (quota, outage,
 * unsupported file), swap the failed image to its original so art still shows.
 * Installs one capture-phase listener; returns its remover.
 */
export function installImageFallback(): () => void {
	const onError = (event: Event) => {
		const el = event.target;
		if (el instanceof HTMLImageElement) {
			const original = originalImageUrl(el.currentSrc || el.src);
			if (original) el.src = original;
		} else if (typeof SVGImageElement !== 'undefined' && el instanceof SVGImageElement) {
			const href = el.href.baseVal;
			const original = originalImageUrl(href);
			if (original) el.setAttribute('href', original);
		}
	};
	window.addEventListener('error', onError, true);
	return () => window.removeEventListener('error', onError, true);
}

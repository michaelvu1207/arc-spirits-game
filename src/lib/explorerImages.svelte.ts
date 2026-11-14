import { SvelteSet } from 'svelte/reactivity';

// Local game explorer: an image the local art folder does not have (404) must show as a plain
// hex with the spirit's name, not as the browser's broken-image icon. Each URL is tried once.
const broken = new SvelteSet<string>();
const tried = new Set<string>();

/** The URL, or null once it is known not to load. */
export function usableImage(url: string | null | undefined): string | null {
	if (!url) return null;
	if (typeof Image !== 'undefined' && !tried.has(url)) {
		tried.add(url);
		const probe = new Image();
		probe.onerror = () => broken.add(url);
		probe.src = url;
	}
	return broken.has(url) ? null : url;
}

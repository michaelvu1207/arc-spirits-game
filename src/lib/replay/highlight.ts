export type ReplayHighlightInput = {
	title: string;
	guardian: string;
	playerColor: string;
	round: number;
	gain: number;
	accent?: string;
};

function xml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function short(value: string, fallback: string, max = 52): string {
	const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
	return xml((clean || fallback).slice(0, max));
}

function color(value?: string): string {
	return value && /^#[0-9a-f]{6}$/i.test(value) ? value : '#66f2df';
}

/**
 * A self-contained, privacy-safe animated SVG highlight. It contains only the
 * already-public pivotal summary and uses CSS motion so reduced-motion viewers
 * receive the same legible static card. No external font, image, script, room
 * credential, or hidden replay state is embedded.
 */
export function buildReplayHighlightSvg(input: ReplayHighlightInput): string {
	const accent = color(input.accent);
	const title = short(input.title, 'Arc Spirits Match');
	const guardian = short(input.guardian, 'Arc Spirit', 36);
	const player = short(input.playerColor, 'Player', 20);
	const round = Math.max(0, Math.trunc(Number(input.round) || 0));
	const gain = Math.max(0, Math.trunc(Number(input.gain) || 0));
	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080" role="img" aria-labelledby="title description">
  <title id="title">${title} — pivotal Arc Spirits highlight</title>
  <desc id="description">${player} gained ${gain} victory points in round ${round} with ${guardian}.</desc>
  <defs>
    <radialGradient id="void" cx="50%" cy="34%" r="76%"><stop offset="0" stop-color="#32135c"/><stop offset=".55" stop-color="#100822"/><stop offset="1" stop-color="#05030d"/></radialGradient>
    <linearGradient id="spirit" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#bf80ff"/><stop offset="1" stop-color="${accent}"/></linearGradient>
    <filter id="glow"><feGaussianBlur stdDeviation="16" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <style>
    .orbit{transform-origin:540px 418px;animation:orbit 8s linear infinite}.core{transform-origin:540px 418px;animation:pulse 2.4s ease-in-out infinite}.shard{transform-origin:center;animation:float 3.2s ease-in-out infinite}.shard.b{animation-delay:-1.1s}.shard.c{animation-delay:-2.1s}.reveal{animation:reveal 4s ease-in-out infinite}
    @keyframes orbit{to{transform:rotate(360deg)}}@keyframes pulse{0%,100%{transform:scale(.92) rotate(-5deg)}50%{transform:scale(1.08) rotate(7deg)}}@keyframes float{0%,100%{transform:translateY(0) rotate(0)}50%{transform:translateY(-24px) rotate(9deg)}}@keyframes reveal{0%,12%{opacity:.45}35%,82%{opacity:1}100%{opacity:.45}}
    @media (prefers-reduced-motion:reduce){.orbit,.core,.shard,.reveal{animation:none!important}}
    text{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;fill:#f8f4ff}.eyebrow{font-size:22px;font-weight:800;letter-spacing:7px;fill:${accent}}.headline{font-size:64px;font-weight:900;letter-spacing:1px}.guardian{font-size:31px;font-weight:750;fill:#c7bad8}.gain{font-size:116px;font-weight:950}.label{font-size:24px;font-weight:800;letter-spacing:5px;fill:${accent}}.footer{font-size:20px;letter-spacing:4px;fill:#9387a5}
  </style>
  <rect width="1080" height="1080" fill="url(#void)"/>
  <circle cx="540" cy="418" r="226" fill="none" stroke="${accent}" stroke-opacity=".18" stroke-width="2"/>
  <g class="orbit" fill="none" stroke="${accent}" stroke-width="5" stroke-linecap="round" stroke-opacity=".72"><path d="M540 171a247 247 0 0 1 214 123"/><path d="M540 665a247 247 0 0 1-214-123"/></g>
  <g class="core" filter="url(#glow)"><path d="M540 233 704 365 649 565 435 596 360 378Z" fill="url(#spirit)" fill-opacity=".82"/><path d="M540 286 636 384 604 510 478 532 418 401Z" fill="#ffffff" fill-opacity=".32"/><path d="M540 342 590 402 568 474 500 482 467 411Z" fill="#ffffff" fill-opacity=".76"/></g>
  <path class="shard" d="M259 343 302 306 319 378 278 404Z" fill="${accent}" fill-opacity=".7"/><path class="shard b" d="M763 295 816 330 784 397 746 355Z" fill="#b77bff" fill-opacity=".68"/><path class="shard c" d="M742 559 807 540 798 620 748 638Z" fill="${accent}" fill-opacity=".58"/>
  <g text-anchor="middle"><text class="eyebrow" x="540" y="91">PIVOTAL MOMENT</text><text class="headline" x="540" y="754">${title}</text><text class="guardian" x="540" y="802">${guardian} · ${player}</text><g class="reveal"><text class="gain" x="540" y="932">+${gain} VP</text><text class="label" x="540" y="978">ROUND ${round}</text></g><text class="footer" x="540" y="1040">ARC SPIRITS · LIVE MATCH REPLAY</text></g>
</svg>`;
}

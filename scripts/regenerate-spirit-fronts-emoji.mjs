import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const env = Object.fromEntries(
	(await fs.readFile('.env', 'utf8'))
		.split(/\r?\n/)
		.map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
		.filter(Boolean)
		.map(([, key, value]) => [key, value])
);
const SUPABASE_URL = env.PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Missing Supabase credentials in .env');

const BUCKET = 'game_assets';
const ASSETS_SCHEMA = 'arc_spirits_assets';
const OUTPUT_TAG = 'rework-2026-10-28-emoji';
const BASE_VERSION = 'rework-2026-10-15/game-fit-v2';
const OUT_DIR = path.resolve('verification/regenerated-spirit-fronts');
const ORIGIN_TOKEN_REGION = { left: 710, top: 1940, right: 1115, bottom: 2360 };
const TOKEN_STRIP_REGION = { left: 650, top: 1880, right: 2080, bottom: 2400 };
const headers = {
	apikey: SERVICE_KEY,
	Authorization: `Bearer ${SERVICE_KEY}`,
	'Content-Type': 'application/json'
};
const publicUrl = (objectPath) => `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;
const objectUrl = (objectPath) => `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`;

function originKind(name) {
	const normalized = String(name ?? '').toLowerCase();
	if (['fire', 'fire region', 'lantern lights'].includes(normalized)) return 'fire';
	if (['mountain', 'mountain region', 'cyber city'].includes(normalized)) return 'mountain';
	return null;
}

function replacementIcon(kind) {
	if (kind === 'fire') {
		return Buffer.from(`<svg width="360" height="360" viewBox="0 0 360 360" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="fire" x1="0" y1="1" x2="0.7" y2="0"><stop stop-color="#ff321d"/><stop offset=".55" stop-color="#ff8a1f"/><stop offset="1" stop-color="#ffe26b"/></linearGradient></defs>
<path d="M182 328c-73 0-118-43-118-102 0-44 28-72 61-111 18-21 29-44 34-79 43 32 60 67 57 105 19-12 33-31 35-54 39 37 67 86 67 137 0 62-51 104-136 104Z" fill="url(#fire)" stroke="#32121b" stroke-width="12" stroke-linejoin="round"/>
<path d="M177 292c-33 0-54-21-54-49 0-23 16-38 34-57 10-11 16-22 18-39 24 20 31 39 28 61 12-8 19-17 22-29 17 21 27 45 27 68 0 28-23 45-75 45Z" fill="#fff1a3" stroke="#8d2a21" stroke-width="8"/>
</svg>`);
	}
	return Buffer.from(`<svg width="360" height="360" viewBox="0 0 360 360" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="rock" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#d8e0e9"/><stop offset=".5" stop-color="#8392a3"/><stop offset="1" stop-color="#394757"/></linearGradient></defs>
<path d="M40 294 62 172 138 94 230 121 318 224 290 306Z" fill="url(#rock)" stroke="#17202c" stroke-width="12" stroke-linejoin="round"/>
<path d="m62 172 76-78 20 113-66 52Z" fill="#f1f5f8" opacity=".8"/>
<path d="m158 207 72-86 88 103-91 17Z" fill="#aebdca" opacity=".9"/>
<path d="m92 259 66-52 75 34-69 65Z" fill="#556576"/>
</svg>`);
}

async function getRows() {
	const response = await fetch(
		`${SUPABASE_URL}/rest/v1/hex_spirits?select=id,name,traits,game_print_image_path&order=name`,
		{ headers: { ...headers, 'Accept-Profile': ASSETS_SCHEMA } }
	);
	if (!response.ok) throw new Error(`Read hex_spirits failed (${response.status})`);
	return response.json();
}

async function getOrigins() {
	const response = await fetch(`${SUPABASE_URL}/rest/v1/origins?select=id,name,icon_token_png`, {
		headers: { ...headers, 'Accept-Profile': ASSETS_SCHEMA }
	});
	if (!response.ok) throw new Error(`Read origins failed (${response.status})`);
	return response.json();
}

async function getClasses() {
	const response = await fetch(`${SUPABASE_URL}/rest/v1/classes?select=id,name,icon_png`, {
		headers: { ...headers, 'Accept-Profile': ASSETS_SCHEMA }
	});
	if (!response.ok) throw new Error(`Read classes failed (${response.status})`);
	return response.json();
}

async function bytes(url, label) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Fetch ${label} failed (${response.status})`);
	return Buffer.from(await response.arrayBuffer());
}

async function regenerate(row, originMap, classMap, assetCache) {
	const basePath = `hex_spirits/${row.id}/${BASE_VERSION}/front-base.png`;
	const oldPath = `hex_spirits/${row.id}/${BASE_VERSION}/front.png`;
	const [baseBytes, oldBytes] = await Promise.all([
		bytes(publicUrl(basePath), `${row.name} front-base`),
		bytes(publicUrl(oldPath), `${row.name} front`)
	]);
	const base = await sharp(baseBytes).raw().toBuffer({ resolveWithObject: true });
	const old = await sharp(oldBytes).raw().toBuffer({ resolveWithObject: true });
	if (base.info.width !== old.info.width || base.info.height !== old.info.height) {
		throw new Error(`${row.name} front dimensions do not match`);
	}
	const overlay = Buffer.alloc(base.data.length, 0);
	const { width, height } = base.info;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const i = (y * width + x) * 4;
			const inTokenStrip = x >= TOKEN_STRIP_REGION.left && x <= TOKEN_STRIP_REGION.right && y >= TOKEN_STRIP_REGION.top && y <= TOKEN_STRIP_REGION.bottom;
			if (inTokenStrip) continue;
			const difference =
				Math.abs(base.data[i] - old.data[i]) +
				Math.abs(base.data[i + 1] - old.data[i + 1]) +
				Math.abs(base.data[i + 2] - old.data[i + 2]);
			if (difference < 30) continue;
			overlay[i] = old.data[i];
			overlay[i + 1] = old.data[i + 1];
			overlay[i + 2] = old.data[i + 2];
			overlay[i + 3] = 255;
		}
	}
	const origin = originMap.get(row.traits?.origin_ids?.[0]);
	const originName = origin?.name ?? '';
	const kind = originKind(originName);
	const originPath = origin?.icon_token_png;
	const classIds = Array.isArray(row.traits?.class_ids) ? row.traits.class_ids : [];
	const layers = [
		{ input: await sharp(overlay, { raw: { width, height, channels: 4 } }).png().toBuffer(), left: 0, top: 0 }
	];
	if (originPath || kind) {
		const cacheKey = kind ? `replacement:${kind}` : originPath;
		if (!assetCache.has(cacheKey)) assetCache.set(cacheKey, kind ? replacementIcon(kind) : await bytes(publicUrl(originPath), `${originName} origin icon`));
		layers.push({ input: await sharp(assetCache.get(cacheKey)).resize(350, 350).png().toBuffer(), left: 725, top: 1980 });
	}
	const classCount = classIds.length;
	const classLeft = classCount <= 1 ? 1300 : classCount === 2 ? 1160 : 1030;
	const classStep = classCount <= 2 ? 340 : 300;
	for (let index = 0; index < classCount; index += 1) {
		const classInfo = classMap.get(classIds[index]);
		if (!classInfo?.icon_png) continue;
		const cacheKey = `class:${classInfo.icon_png}`;
		if (!assetCache.has(cacheKey)) assetCache.set(cacheKey, await bytes(publicUrl(classInfo.icon_png), `${classInfo.name} class icon`));
		const left = classLeft + index * classStep;
		const sample = await sharp(baseBytes).extract({ left, top: 2040, width: 220, height: 220 }).raw().toBuffer({ resolveWithObject: true });
		let luminance = 0;
		for (let i = 0; i < sample.data.length; i += sample.info.channels) luminance += sample.data[i] * 0.2126 + sample.data[i + 1] * 0.7152 + sample.data[i + 2] * 0.0722;
		luminance /= sample.data.length / sample.info.channels;
		let icon = sharp(assetCache.get(cacheKey));
		if (luminance < 105) icon = icon.tint('#ffffff');
		layers.push({ input: await icon.resize(300, 300, { fit: 'contain' }).png().toBuffer(), left, top: 1985 });
	}
	const output = await sharp(baseBytes).composite(layers).png({ compressionLevel: 9 }).toBuffer();
	return { output, originName, replaced: kind, classCount };
}

const apply = process.argv.includes('--apply');
await fs.mkdir(OUT_DIR, { recursive: true });
const [rows, origins, classes] = await Promise.all([getRows(), getOrigins(), getClasses()]);
const originMap = new Map(origins.map((origin) => [origin.id, origin]));
const classMap = new Map(classes.map((item) => [item.id, item]));
const assetCache = new Map();
const report = [];
for (const row of rows) {
	const { output, originName, replaced, classCount } = await regenerate(row, originMap, classMap, assetCache);
	const outputPath = `hex_spirits/${row.id}/${OUTPUT_TAG}/game-fit-v2/front.png`;
	await fs.writeFile(path.join(OUT_DIR, `${row.id}-front.png`), output);
	if (apply) {
		const upload = await fetch(objectUrl(outputPath), {
			method: 'POST',
			headers: { ...headers, 'x-upsert': 'true', 'cache-control': '31536000' },
			body: output
		});
		if (!upload.ok) throw new Error(`Upload ${row.name} failed (${upload.status})`);
		const patch = await fetch(`${SUPABASE_URL}/rest/v1/hex_spirits?id=eq.${row.id}`, {
			method: 'PATCH',
			headers: { ...headers, 'Content-Profile': ASSETS_SCHEMA, Prefer: 'return=representation' },
			body: JSON.stringify({ game_print_image_path: outputPath })
		});
		if (!patch.ok) throw new Error(`Update ${row.name} failed (${patch.status})`);
		const check = await fetch(publicUrl(outputPath), { method: 'HEAD' });
		if (!check.ok) throw new Error(`Public asset check failed for ${row.name}`);
	}
	report.push({ id: row.id, name: row.name, origin: originName, replaced, classCount, bytes: output.byteLength, outputPath });
}
await fs.writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({ apply, count: report.length, report }, null, 2));
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', count: report.length, replaced: report.filter((x) => x.replaced), outputDir: OUT_DIR }, null, 2));

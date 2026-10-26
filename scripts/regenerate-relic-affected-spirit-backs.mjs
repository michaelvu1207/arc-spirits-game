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
const BASE_PREFIX = 'hex_spirits';
const OUTPUT_TAG = 'rework-2026-10-26-runes';
const OUT_DIR = path.resolve('verification/regenerated-rune-spirit-backs');
const ICON_SIZE = { width: 280, height: 282 };
const ICON_X = [724, 1058, 1383];
const ICON_Y = 422;
const BASE_VERSION = 'rework-2026-10-15/game-fit-v2';

const RUNE = {
  fire: '480cd5f7-adea-481d-8ea9-aad776599d7b',
  forest: '34b2a963-f8c6-4fc0-8272-ddc50b0036a8',
  mountain: '356f3ad2-4cac-4b69-a3cc-7559f8891d8e',
  water: '5eba8681-16b8-4563-b017-22c80a84b35b',
  any: '7ca279f0-1ca8-484a-a86e-0a87aaa7b312'
};

// These are exactly the spirits whose old awakening requirement referenced a
// relic, plus Solar Reliquarian whose requirement was text-only.
const AFFECTED = [
  ['955abfc0-fa04-4ab3-bcaf-5dc2839ddec0', [RUNE.water, RUNE.water, RUNE.water]],
  ['18154c10-1422-4655-a7cd-c637ac947916', [RUNE.forest, RUNE.forest]],
  ['728c5151-2da6-4202-b5b0-aae13dec68be', [RUNE.any, RUNE.any, RUNE.any]],
  ['ed612933-fd19-4b68-993e-6e61b52eb4ce', [RUNE.any, RUNE.any]],
  ['40016186-6b98-4dbb-8364-b50d27e9f394', [RUNE.mountain, RUNE.mountain]],
  ['5c864c2d-20bd-4134-a829-09a2cc793e41', [RUNE.mountain, RUNE.mountain]],
  ['0a775e09-555f-43a7-ac5b-06aaeaa4b69c', [RUNE.mountain, RUNE.mountain]],
  ['a77653c5-69fa-4351-833d-59d302722365', [RUNE.any, RUNE.any, RUNE.any]],
  ['25848694-6c69-408c-9b78-94948c6df3a6', [RUNE.fire, RUNE.fire]],
  ['b8314d8f-ea32-44de-a3ad-62944e5ccecb', [RUNE.any, RUNE.mountain, RUNE.mountain]],
  ['3b196b06-a047-4505-aad6-bf0c9fe05ac0', [RUNE.forest, RUNE.forest]],
  ['e24e9f91-7333-44c0-968e-15b900af3385', [RUNE.any, RUNE.any]],
  ['be2072ea-ccdb-4941-b1b3-26890a7b64cf', [RUNE.water, RUNE.water, RUNE.any]],
  ['d89f5d3a-5519-4b96-baf0-1f0a49c0ada1', [RUNE.fire, RUNE.fire]],
  ['5dc44c85-8224-4c49-89ff-90a37aa10040', null]
].map(([id, runeIds]) => ({ id, runeIds }));

const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json'
};
const publicUrl = (objectPath) => `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;
const objectUrl = (objectPath) => `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`;

async function getRows() {
  const url = `${SUPABASE_URL}/rest/v1/hex_spirits?select=id,name,awaken_condition,back_side_export&order=name`;
  const response = await fetch(url, {
    headers: { ...headers, 'Accept-Profile': ASSETS_SCHEMA }
  });
  if (!response.ok) throw new Error(`Read hex_spirits failed (${response.status})`);
  return response.json();
}

async function fetchBytes(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fetch ${label} failed (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

async function buildCard(row, runeIds) {
  const basePath = `${BASE_PREFIX}/${row.id}/${BASE_VERSION}/back-base.png`;
  const base = await fetchBytes(publicUrl(basePath), `${row.name} back-base`);
  const overlays = [];
  if (runeIds) {
    const iconBuffers = new Map();
    for (const runeId of runeIds) {
      if (!iconBuffers.has(runeId)) {
        const iconPath = `runes/${runeId}/icon.png`;
        const icon = await fetchBytes(publicUrl(iconPath), `${row.name} rune icon`);
        iconBuffers.set(runeId, await sharp(icon).resize(ICON_SIZE).png().toBuffer());
      }
    }
    const start = ICON_X.length - runeIds.length;
    if (start < 0) throw new Error(`${row.name} has too many awakening icons`);
    runeIds.forEach((runeId, index) => {
      overlays.push({ input: iconBuffers.get(runeId), left: ICON_X[start + index], top: ICON_Y });
    });
  } else {
    const textOverlay = Buffer.from(`<svg width="2784" height="2414" xmlns="http://www.w3.org/2000/svg"><rect x="650" y="380" width="1500" height="210" fill="#05000f"/><text x="1400" y="512" text-anchor="middle" font-family="Arial, sans-serif" font-size="78" fill="#fde8e8">Discard 2 Runes of different types.</text></svg>`);
    overlays.push({ input: textOverlay });
  }
  return sharp(base).composite(overlays).png({ compressionLevel: 9 }).toBuffer();
}

function expectedAwaken(runeIds) {
  if (!runeIds) return { type: 'text', text: 'Discard 2 Runes of different types.' };
  return { type: 'rune_cost', rune_ids: runeIds };
}

const apply = process.argv.includes('--apply');
await fs.mkdir(OUT_DIR, { recursive: true });
const rows = await getRows();
const byId = new Map(rows.map((row) => [row.id, row]));
const backup = [];
const report = [];
for (const entry of AFFECTED) {
  const row = byId.get(entry.id);
  if (!row) throw new Error(`Missing spirit row ${entry.id}`);
  const expected = expectedAwaken(entry.runeIds);
  const live = row.awaken_condition;
  const matches = expected.type === 'text'
    ? live?.type === 'text' && live.text === expected.text
    : live?.type === 'rune_cost' && JSON.stringify(live.rune_ids) === JSON.stringify(expected.rune_ids);
  if (!matches) {
    throw new Error(`${row.name} awakening data does not match the migrated rule: ${JSON.stringify(row.awaken_condition)}`);
  }
  const output = await buildCard(row, entry.runeIds);
  const localPath = path.join(OUT_DIR, `${row.id}-back.png`);
  await fs.writeFile(localPath, output);
  const outputPath = `${BASE_PREFIX}/${row.id}/${OUTPUT_TAG}/game-fit-v2/back.png`;
  backup.push({ id: row.id, name: row.name, oldPath: row.back_side_export, newPath: outputPath });
  if (apply) {
    const upload = await fetch(objectUrl(outputPath), {
      method: 'POST',
      headers: { ...headers, 'x-upsert': 'true', 'cache-control': '31536000' },
      body: output
    });
    if (!upload.ok) throw new Error(`Upload ${row.name} failed (${upload.status}): ${await upload.text()}`);
    const patch = await fetch(
      `${SUPABASE_URL}/rest/v1/hex_spirits?id=eq.${encodeURIComponent(row.id)}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Content-Profile': ASSETS_SCHEMA, Prefer: 'return=representation' },
        body: JSON.stringify({ back_side_export: outputPath })
      }
    );
    if (!patch.ok) throw new Error(`Update ${row.name} failed (${patch.status}): ${await patch.text()}`);
    const updated = await patch.json();
    if (updated.length !== 1 || updated[0].back_side_export !== outputPath) {
      throw new Error(`Update verification failed for ${row.name}`);
    }
    const publicCheck = await fetch(publicUrl(outputPath), { method: 'HEAD' });
    if (!publicCheck.ok) throw new Error(`Public asset check failed for ${row.name} (${publicCheck.status})`);
  }
  report.push({ name: row.name, id: row.id, oldPath: row.back_side_export, newPath: outputPath, bytes: output.byteLength });
}
await fs.writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({ apply, generatedAt: new Date().toISOString(), report, backup }, null, 2));
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', count: report.length, outputDir: OUT_DIR, report }, null, 2));

// Exports page: card and graphic templates made from the generated art and the local game data
// (~/ArcSpiritsArt/game/*.json and references/icons, imported one time with tools/import-game.mjs).
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, cpus, totalmem } from 'node:os';
// Renders run as separate python processes, one per spirit (Michael, 2026-11-09: use as many cores as possible).
// The server gates the renders by the memory that is free right now.
// The page may send several requests at once; the extra ones wait here for a slot.
// Measured 2026-11-09: one render peaks at 1.1 GB; more than 6 processes at once is slower (memory bandwidth).
const PARALLEL = Math.max(1, Math.min(6, cpus().length)), RENDER_GB = 1.2;
let running = 0, fresh = 0; const waiters = []; // fresh = renders started in the last 4 s (their memory is not in use yet)
async function availableBytes() { // macOS: free + inactive + speculative + purgeable pages (os.freemem() counts only the free ones)
  try { const { stdout } = await run('vm_stat'); const page = Number(stdout.match(/page size of (\d+)/)?.[1] ?? 16384), n = (k) => Number(stdout.match(new RegExp(`Pages ${k}:\\s+(\\d+)`))?.[1] ?? 0); return (n('free') + n('inactive') + n('speculative') + n('purgeable')) * page; }
  catch { return totalmem() * 0.3; }
}
async function renderSlot() {
  for (;;) {
    // Room for one more: free memory for this render plus the ones that just started. The first render always runs.
    if (!running || (running < PARALLEL && await availableBytes() >= RENDER_GB * 1e9 * (1 + fresh))) {
      running++; fresh++; setTimeout(() => { fresh--; }, 4000);
      return () => { running--; waiters.shift()?.(); };
    }
    await new Promise((r) => { waiters.push(r); setTimeout(r, 3000); }); // a slot freed, or look at the memory again
  }
}
const run = promisify(execFile);
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as workspace from './workspace.mjs';

const ROOT = workspace.ROOT;
const NAMES = JSON.parse(await readFile(join(fileURLToPath(new URL('.', import.meta.url)), 'names.json'), 'utf8'));
const SETTINGS = join(ROOT, '.niji-exports.json'); // per-card choices, for example another art image
const game = async (table) => JSON.parse(await readFile(join(ROOT, 'game', `${table}.json`), 'utf8'));
const clean = (s) => String(s).replace(/[\\/:*?"<>|]/g, '').trim();
const loadSettings = async () => (existsSync(SETTINGS) ? JSON.parse(await readFile(SETTINGS, 'utf8')) : {});
// Local helpers (the workspace module keeps its own private): image names of a folder, and the pinned paths.
const IMG = /\.(png|jpe?g|webp|gif)$/i;
const imagesIn = async (dir) => (await readdir(dir)).filter((n) => IMG.test(n) && !n.startsWith('.')).sort();
const pinnedPaths = async () => new Set(existsSync(join(ROOT, '.niji-pins.json')) ? JSON.parse(await readFile(join(ROOT, '.niji-pins.json'), 'utf8')) : []);
const iconFile = async (dir, name) => {
  const files = existsSync(join(ROOT, dir)) ? await readdir(join(ROOT, dir)) : [];
  const f = files.find((x) => x.replace(/\.[^.]+$/, '') === name);
  return f ? `${dir}/${f}` : null;
};

// ---------- hex spirits made with the Figma design ----------
// The arcane and non-arcane hexes are designed in Figma. tools/hex_generate.py rebuilds that design from the template kit
// (references/hex_template, exported from Figma) whenever a spirit's art or data changes. Per spirit (references/hex_bases/<Name>/):
//   figma-<side>.png  the card exported from Figma (used while the spirit's data is what it was at export time)
//   gen-<side>.png    the card made by the generator (used once something changed)
//   hexgen.json       { front: key, back: key } - the input keys the gen files were made from
// The Figma export is only shown until the generator has made the card (the generator always uses the current data).
const HEXGEN_VERSION = 1;
const KIT = join(ROOT, 'references/hex_template');
const LAND = ['Fire', 'Forest', 'Mountain', 'Water'];
/** Which template and which origin look a spirit uses (null = heroes, old frame). */
function hexKit(m) {
  if (!m.origin) return null;
  const origin = [...LAND, 'Sun', 'Moon'].includes(m.origin) ? m.origin : m.tier === 'royal_family' || m.subfolder === 'standalone' ? 'Eclipse' : m.subfolder === 'void' ? 'Moon' : 'Sun'; // Sun and Moon are origins of their own since 2026-11-11
  return { template: LAND.includes(m.origin) && m.cost < 7 ? 'non-arcane' : 'arcane', origin };
}
const hexSides = (m) => hexKit(m)?.template === 'non-arcane' ? ['front'] : ['front', 'back'];
/** Everything a side depends on; a change of any of it makes a new card. */
async function hexInputs(m, side, mt) {
  const k = hexKit(m), abs = (f) => (f ? join(ROOT, f) : null);
  const spec = { ...k, side, name: m.name, art: abs(m.art), transform: m.transform ?? null,
    classes: m.classes.map((c) => ({ name: c.name, icon: abs(c.icon), special: c.special })),
    runes: side === 'back' ? m.runes.map((g) => g.map(abs)) : [], awakenType: side === 'back' ? m.awakenType : null,
    awakenText: side === 'back' ? m.awakenText : null, className: side === 'back' ? m.className : null, classDesc: side === 'back' ? m.classDesc : null };
  if (side === 'front') { delete spec.runes; }
  const files = [m.art, ...m.classes.map((c) => c.icon), ...(side === 'back' ? m.runes.flat() : [])].filter(Boolean);
  const key = createHash('sha1').update(JSON.stringify([HEXGEN_VERSION, spec, await Promise.all(files.map(mt))])).digest('hex').slice(0, 16);
  return { key, spec: { ...spec, kit: KIT } };
}
const readJson = async (f, d) => (existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : d);
/** Picks the card to show per side and marks the sides that must be made again. */
async function hexState(m, dir, mt) {
  const rel = `references/hex_bases/${clean(m.name)}`, f = join(dir, 'hexgen.json'), st = await readJson(f, {});
  m.source = 'figma'; m.final = {}; m.stale = []; m.kit = hexKit(m); const keys = {};
  for (const side of hexSides(m)) {
    const { key } = await hexInputs(m, side, mt); keys[side] = key;
    const fig = existsSync(join(dir, `figma-${side}.png`)), gen = existsSync(join(dir, `gen-${side}.png`));
    if (gen && st[side] === key) m.final[side] = `${rel}/gen-${side}`;
    else if (fig && st.baseline?.[side] === key) m.final[side] = `${rel}/figma-${side}`;
    else { m.stale.push(side); if (gen) m.final[side] = `${rel}/gen-${side}`; else if (fig) m.final[side] = `${rel}/figma-${side}`; }
  }
  m.finalKey = createHash('sha1').update(JSON.stringify([keys, await Promise.all(Object.values(m.final).map((p) => mt(p + '.png')))])).digest('hex').slice(0, 16);
}
let hexBusy = Promise.resolve();
/** Makes the given sides of one spirit with tools/hex_generate.py, then exports them to assets/exports/hex-spirits. */
async function hexGenerate(m, sides) {
  const dir = join(ROOT, 'references/hex_bases', clean(m.name)), mt = async (f) => (await stat(join(ROOT, f)).catch(() => null))?.mtimeMs ?? 0;
  if (!m.art) throw new Error(`${m.name}: no art.`);
  const tool = join(fileURLToPath(new URL('.', import.meta.url)), 'tools/hex_generate.py');
  const py = process.env.NIJI_PYTHON || join(homedir(), 'Documents/Programming/ArcSpirits/products/game-data-backend/.venv-psd/bin/python');
  const outDir = join(ROOT, 'assets/exports/hex-spirits'); await mkdir(outDir, { recursive: true });
  for (const side of sides) {
    const { key, spec } = await hexInputs(m, side, mt), specFile = join(dir, `gen-${side}.spec.json`);
    await writeFile(specFile, JSON.stringify({ ...spec, out: join(dir, `gen-${side}.png`), preview: join(dir, `gen-${side}-preview.png`) }, null, 1));
    const release = await renderSlot();
    try { await run(py, [tool, '--spec', specFile], { maxBuffer: 1 << 24, timeout: 300000 }); }
    catch (e) { throw new Error(`${m.name} ${side}: ${(e.stderr || e.message || '').toString().trim().split('\n').slice(-2).join(' ')}`); }
    finally { release(); }
    const f = join(dir, 'hexgen.json'), st = await readJson(f, {}); st[side] = key; await writeFile(f, JSON.stringify(st));
    await writeFile(join(outDir, `${clean(m.name)}_${side}.png`), await readFile(join(dir, `gen-${side}.png`)));
  }
}
// ---------- monster cards made with the Figma design ----------
// tools/monster_generate.py rebuilds the merged monster card from Figma (page Design Drafts) with the kit in
// references/monster_template. Per monster: references/monster_cards/<Name>/card.png (+ card-preview.png, state.json = input key),
// and a copy in assets/exports/monster-cards/<Name>.png.
const MONSTER_VERSION = 1, MKIT = join(ROOT, 'references/monster_template');
const mtAbs = async (f) => (f ? (await stat(join(ROOT, f)).catch(() => null))?.mtimeMs ?? 0 : 0);
async function monsterInputs(m) {
  const abs = (f) => (f ? join(ROOT, f) : null);
  const spec = { name: m.name, health: m.barrier, damage: m.damage, classLabel: `Class ${m.stage}`, art: abs(m.art), transform: m.transform ?? null,
    rewards: m.rewards.map((r) => abs(r.icon)).filter(Boolean) };
  const key = createHash('sha1').update(JSON.stringify([MONSTER_VERSION, spec, await mtAbs(m.art), await Promise.all(m.rewards.map((r) => mtAbs(r.icon)))])).digest('hex').slice(0, 16);
  return { key, spec: { ...spec, kit: MKIT } };
}
async function monsterState(m) {
  const rel = `references/monster_cards/${clean(m.name)}`, st = await readJson(join(ROOT, rel, 'state.json'), {});
  const { key } = await monsterInputs(m);
  m.card = existsSync(join(ROOT, rel, 'card.png')) ? `${rel}/card` : null;
  m.stale = !m.card || st.key !== key; m.missingIcons = m.rewards.filter((r) => !r.icon).map((r) => r.name);
  m.cardKey = createHash('sha1').update(key + (await mtAbs(m.card ? m.card + '.png' : null))).digest('hex').slice(0, 16);
}
async function monsterGenerate(m) {
  const dir = join(ROOT, 'references/monster_cards', clean(m.name)); await mkdir(dir, { recursive: true });
  const { key, spec } = await monsterInputs(m), specFile = join(dir, 'spec.json');
  await writeFile(specFile, JSON.stringify({ ...spec, out: join(dir, 'card.png'), preview: join(dir, 'card-preview.png') }, null, 1));
  const tool = join(fileURLToPath(new URL('.', import.meta.url)), 'tools/monster_generate.py');
  const py = process.env.NIJI_PYTHON || join(homedir(), 'Documents/Programming/ArcSpirits/products/game-data-backend/.venv-psd/bin/python');
  const release = await renderSlot();
  try { await run(py, [tool, '--spec', specFile], { maxBuffer: 1 << 24, timeout: 120000 }); }
  catch (e) { throw new Error(`${m.name}: ${(e.stderr || e.message || '').toString().trim().split('\n').slice(-2).join(' ')}`); }
  finally { release(); }
  await writeFile(join(dir, 'state.json'), JSON.stringify({ key }));
  const outDir = join(ROOT, 'assets/exports/monster-cards'); await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, `${clean(m.name)}.png`), await readFile(join(dir, 'card.png')));
}

/** Background: every 5 s, make the cards of one spirit whose art or data changed. NIJI_HEX_AUTOGEN=0 turns it off. */
const hexLog = [], hexFailed = new Set();
async function hexAuto() {
  const [, list] = await routes['GET /api/game/hex-spirits']();
  const m = list.spirits.find((x) => x.stale?.length && x.art && !hexFailed.has(x.name + x.finalKey));
  if (!m) { // then one monster card
    const [, mons] = await routes['GET /api/game/monsters']();
    const mm = mons.find((x) => x.stale && !hexFailed.has('monster:' + x.name + x.cardKey));
    if (mm) {
      try { await monsterGenerate(mm); hexLog.unshift({ at: Date.now(), monster: mm.name }); }
      catch (e) { hexLog.unshift({ at: Date.now(), monster: mm.name, error: e.message }); hexFailed.add('monster:' + mm.name + mm.cardKey); }
      hexLog.length = Math.min(hexLog.length, 50);
    }
  }
  if (m) {
    try { await hexGenerate(m, m.stale); hexLog.unshift({ at: Date.now(), name: m.name, sides: m.stale }); }
    catch (e) { hexLog.unshift({ at: Date.now(), name: m.name, error: e.message }); hexFailed.add(m.name + m.finalKey); } // not again until something changes
    hexLog.length = Math.min(hexLog.length, 50);
  }
}
if (process.env.NIJI_HEX_AUTOGEN !== '0' && !process.env.NIJI_WORKER && !process.env.NIJI_TEST) { // runs here in normal and client mode (the files are here)
  let hexTick = false;
  setInterval(() => { if (hexTick) return; hexTick = true; hexBusy = hexBusy.then(hexAuto).catch(() => {}).finally(() => { hexTick = false; }); }, 5000);
}

// ---------- data editor: the local game tables in ~/ArcSpiritsArt/game/*.json ----------
const GAME = join(ROOT, 'game');
const EDITABLE = ['monsters_v2', 'classes', 'origins', 'runes', 'relics', 'augments', 'reward_sets']; // Michael (2026-11-07): monsters, classes, and the local runes table
const REWARDS = join(GAME, 'reward_values.json'); // subjective reward values (VP) + the expected-value curve
const DEFAULT_REWARDS = { curve: { a: 1, b: 0.4 }, bands: { jackpot: 0.5, strong: 0.2, weak: -0.2, trap: -0.5 }, values: {} };
const loadRewards = async () => (existsSync(REWARDS) ? { ...DEFAULT_REWARDS, ...JSON.parse(await readFile(REWARDS, 'utf8')) } : DEFAULT_REWARDS);
const tableName = (n) => EDITABLE.includes(String(n)) ? String(n) : null;

// Symmetric reward sets (Michael, 2026-11-07): the four members of a set (one per land) share difficulty, health, damage and track;
// only the origin token differs. Saving the sets re-applies them to their members in monsters_v2.json.
const RUNE = { Fire: 'Rune: Lantern Lights', Forest: 'Rune: Forest', Mountain: 'Rune: Cyber City', Water: 'Rune: Tidal Tribe' };
const RELIC = { Fire: 'Rune: Firecracker', Forest: 'Rune: Flower', Mountain: 'Rune: Magnet', Water: 'Rune: Teapot' };
async function applySets(sets) {
  const [monsters, pool] = await Promise.all([game('monsters_v2'), game('icon_pool')]);
  const idOf = Object.fromEntries(pool.map((t) => [t.name, t.id]));
  for (const m of monsters) {
    const st = m.set && sets.find((x) => x.id === m.set);
    if (!st) { if (m.set) delete m.set; continue; }
    m.sub_difficulty = Number(st.sub_difficulty); m.barrier = Number(st.barrier); m.damage = Number(st.damage);
    m.reward_track = (st.template ?? []).map((n) => idOf[n === '{rune}' ? RUNE[m.theme] : n === '{relic}' ? RELIC[m.theme] : n]).filter(Boolean);
    m.choose_amount = m.reward_track.length;
  }
  await writeFile(join(GAME, 'monsters_v2.json'), JSON.stringify(monsters, null, 1));
}

export const routes = {
  /** The tables with their row counts. */
  async 'GET /api/game/tables'() {
    const out = [];
    for (const n of EDITABLE) if (existsSync(join(GAME, `${n}.json`))) out.push({ name: n, rows: JSON.parse(await readFile(join(GAME, `${n}.json`), 'utf8')).length });
    return [200, out];
  },
  /** The local icon file of each origin: { origin name: workspace path }. */
  async 'GET /api/game/origin-icons'() {
    const out = {};
    for (const o of await game('origins')) out[o.name] = await iconFile('references/icons/origins', `${clean(o.name)} (icon)`) ?? await iconFile('references/icons/origins', clean(o.name));
    return [200, out];
  },
  /** The icon pool with local icon files and reward values, for the reward picker. */
  async 'GET /api/game/icons'() {
    const [pool, rv] = await Promise.all([game('icon_pool'), loadRewards()]), out = [];
    for (const t of pool.sort((a, b) => a.name.localeCompare(b.name))) out.push({ id: t.id, name: t.name, icon: await iconFile('references/icons/icon_pool', clean(t.name)), value: rv.values[t.id] ?? null });
    return [200, out];
  },
  /** Reward values: { curve: {a, b}, bands, values: {iconId: VP}, used: {iconId: count on monster tracks} }. */
  async 'GET /api/game/rewards'() {
    const [rv, monsters] = await Promise.all([loadRewards(), game('monsters_v2')]);
    const used = {};
    for (const m of monsters) for (const id of m.reward_track ?? []) used[id] = (used[id] ?? 0) + 1;
    return [200, { ...rv, used }];
  },
  /** Saves the reward values: { curve, bands?, values }. The old file stays as reward_values.bak.json. */
  async 'POST /api/game/rewards'(body) {
    if (!body.curve || typeof body.values !== 'object') return [400, { error: 'Bad reward values.' }];
    const cur = await loadRewards();
    const values = Object.fromEntries(Object.entries(body.values).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)));
    if (existsSync(REWARDS)) await writeFile(join(GAME, 'reward_values.bak.json'), await readFile(REWARDS));
    await writeFile(REWARDS, JSON.stringify({ ...cur, curve: { a: Number(body.curve.a) || 0, b: Number(body.curve.b) || 0 }, bands: body.bands ?? cur.bands, values }, null, 1));
    return [200, { tokens: Object.keys(values).length }];
  },
  async 'GET /api/game/table'(_, url) {
    const name = tableName(url.searchParams.get('name'));
    if (!name || !existsSync(join(GAME, `${name}.json`))) return [404, { error: 'Table not found.' }];
    return [200, JSON.parse(await readFile(join(GAME, `${name}.json`), 'utf8'))];
  },
  /** Replaces a table: { name, rows }. The old file stays as <name>.bak.json (one step back). */
  async 'POST /api/game/table'(body) {
    const name = tableName(body.name);
    if (!name || !Array.isArray(body.rows)) return [400, { error: 'Bad table.' }];
    const file = join(GAME, `${name}.json`);
    if (existsSync(file)) await writeFile(join(GAME, `${name}.bak.json`), await readFile(file));
    await writeFile(file, JSON.stringify(body.rows, null, 1));
    if (name === 'reward_sets') await applySets(body.rows);
    return [200, { rows: body.rows.length }];
  },
  /** The monsters with their card values, the art to use and the reward track icons. */
  async 'GET /api/game/monsters'() {
    const [monsters, pool, origins, settings] = await Promise.all([game('monsters_v2'), game('icon_pool'), game('origins'), loadSettings()]);
    const byId = Object.fromEntries(pool.map((x) => [x.id, x]));
    const pins = await pinnedPaths();
    const out = [];
    for (const m of monsters.sort((a, b) => a.stage - b.stage || a.order_num - b.order_num)) {
      const map = { ...(NAMES.monsters[m.name] ?? { name: m.name, origin: null }) };
      if (m.theme) map.origin = m.theme === 'Arcane' ? null : m.theme; // the Arcane Spirits origin is gone (2026-11-12): these monsters have no origin
      const folder = `assets/monsters/Difficulty ${m.stage}/${clean(map.name)}`;
      if (!existsSync(join(ROOT, folder))) continue; // removed from the game art (for example the fairy monsters)
      const images = await imagesIn(join(ROOT, folder));
      const pinned = images.filter((n) => pins.has(`${folder}/${n}`));
      const chosen = settings['monster-card']?.[map.name]?.art;
      const rewards = [];
      for (const id of m.reward_track ?? []) { const t = byId[id]; if (t) rewards.push({ name: t.name, icon: await iconFile('references/icons/icon_pool', clean(t.name)) }); }
      out.push({
        name: map.name, dbName: m.name, stage: m.stage, barrier: m.barrier, damage: m.damage, attackType: m.attack_type, origin: map.origin,
        originIcon: map.origin ? await iconFile('references/icons/origins', `${clean(map.origin)} (icon)`) ?? await iconFile('references/icons/origins', clean(map.origin)) : null,
        folder, images, art: chosen && images.includes(chosen) ? `${folder}/${chosen}` : pinned[0] ? `${folder}/${pinned[0]}` : images[0] ? `${folder}/${images[0]}` : null,
        rewards, transform: settings['monster-card']?.[map.name]?.transform ?? null,
      });
    }
    for (const m of out) await monsterState(m);
    return [200, out];
  },
  /** The hex spirits for the icon placer: base images, tier, origin/class/rune icons, awaken text. */
  async 'GET /api/game/hex-spirits'() {
    const [spirits, classes, origins, runes, place] = await Promise.all([game('hex_spirits'), game('classes'), game('origins'), game('runes'), game('icon_placement')]);
    const names = JSON.parse(await readFile(join(fileURLToPath(new URL('.', import.meta.url)), 'spirit-names.json'), 'utf8'));
    const byClass = Object.fromEntries(classes.map((c) => [c.id, c])), byOrigin = Object.fromEntries(origins.map((o) => [o.id, o])), byRune = Object.fromEntries(runes.map((r) => [r.id, r]));
    const FAIRY = 'd4752205-1dcb-4f87-8b46-14c4b1bd97d5', FAIRY_DROID = '41180098-1490-4223-9a5a-415a6ec89ca0', ARCANE = '91322cba-4201-48a3-86b1-2d6d034fce3f';
    const LANDS = ['Water', 'Forest', 'Fire', 'Mountain'];
    const REGION = { forest: 'Forest', florest: 'Forest', cyber: 'Mountain', lantern: 'Fire', tidal: 'Water', astral: 'Sun', void: 'Moon', standalone: null };
    // The old editor's rule (game-data-backend getSpiritTierAndSubfolder) + fixed tiers for the spirits it could not place.
    const tierOf = (s, name, origin) => {
      if (place.tiers?.overrides?.[name]) return place.tiers.overrides[name];
      const cls = s.traits?.class_ids ?? [];
      if (cls.includes(FAIRY_DROID) || cls.includes(FAIRY)) return 'fairy';
      if (cls.includes(ARCANE)) return 'arcane';
      if (!LANDS.includes(origin)) return null;
      if (s.cost >= 11) return null;
      return s.cost < 7 ? 'spirit_world' : 'abyss';
    };
    const out = [], pins = [...await pinnedPaths()], settings = await loadSettings();
    for (const s of spirits) {
      const origin = byOrigin[s.traits?.origin_ids?.[0]]?.name ?? null;
      const name = names[`${origin}/${s.name}`] ?? s.name;
      const base = `references/hex_bases/${clean(name)}`;
      if (!s.local && !existsSync(join(ROOT, base, 'front-base.png'))) continue; // local: a spirit made here, not in the game database; its base comes from the first render
      const cls = (s.traits?.class_ids ?? []).map((id) => byClass[id]).filter(Boolean);
      // The art: the spirit's folder under assets/spirits; default = the image pinned last (Michael, 2026-11-09), or a chosen one.
      const folder = `assets/spirits/${origin === null ? 'Heroes' : origin}/${clean(name)}`;
      const images = [];
      if (existsSync(join(ROOT, folder))) for (const sub of ['', 'character design', 'portraits']) { const d = join(ROOT, folder, sub); if (existsSync(d)) for (const f of await imagesIn(d)) if (!/^(current|guide)\./.test(f)) images.push(sub ? `${sub}/${f}` : f); }
      const spiritPins = pins.filter((p) => p.startsWith(folder + '/')).map((p) => p.slice(folder.length + 1)).filter((p) => images.includes(p));
      const chosen = settings['hex-spirit']?.[name]?.art;
      const art = chosen && images.includes(chosen) ? chosen : spiritPins.at(-1) ?? null;
      const special = cls.find((c) => c.is_special || c.class_type === 'special' || c.class_type === 'human');
      const classDesc = special ? (special.effect_schema ?? []).flatMap((b) => (b.effects ?? []).map((e) => e.description)).filter(Boolean).join(' ') || special.description || '' : '';
      const sub = place.tiers?.subfolders?.[name] ?? (cls.some((c) => c.id === ARCANE) ? 'florest' : place.tiers?.land_subfolder?.[origin] ?? null);
      const classIcons = [];
      for (const c of cls) classIcons.push({ name: c.name, icon: await iconFile('references/icons/classes', `${clean(c.name)} (icon)`), special: !!(c.is_special || c.class_type === 'special' || c.class_type === 'human') });
      const aw = s.awaken_condition;
      const runeGroups = []; // each group: the icons of one slot (1 icon, or several for an "or" choice)
      if (aw?.type === 'rune_cost') for (const tok of aw.rune_ids ?? []) {
        const ids = typeof tok === 'string' ? [tok] : tok?.kind === 'or' ? tok.rune_ids ?? [] : [];
        const icons = [];
        for (const id of ids) { const r = byRune[id]; const f = r && await iconFile('references/icons/runes', clean(r.name)); if (f) icons.push(f); }
        if (icons.length) runeGroups.push(icons);
      }
      out.push({
        name, dbName: s.name, cost: s.cost, origin, tier: tierOf(s, name, origin) ?? null,
        originIcon: origin ? await iconFile('references/icons/origins', `${clean(origin)} (icon)`) ?? await iconFile('references/icons/origins', clean(origin)) : null,
        classes: classIcons, runes: runeGroups, awakenType: aw?.type ?? null, awakenText: aw?.type === 'text' ? aw.text : null,
        front: `${base}/front-base.png`, back: existsSync(join(ROOT, base, 'back-base.png')) ? `${base}/back-base.png` : null,
        subfolder: sub, folder, images, pinned: spiritPins, art: art ? `${folder}/${art}` : null, artName: art, className: special?.name ?? null, classDesc,
        transform: settings['hex-spirit']?.[name]?.transform ?? null, region: REGION[sub] ?? (origin && LANDS.includes(origin) ? origin : tierOf(s, name, origin) === 'royal_family' ? 'Sun' : 'Heroes'), // royal_family has the Sun rim, as in tools/hex_render.py
        rendered: existsSync(join(ROOT, base, 'render.json')) ? JSON.parse(await readFile(join(ROOT, base, 'render.json'), 'utf8')) : null,
      });
    }
    // The finished hexes (base + icons) are saved by the page: references/hex_bases/<Name>/final-<side>.png (+ a small preview).
    // finalKey changes when a base, the icons, the awaken data or the icon placement changes; then the page draws and saves again.
    // Arcane and non-arcane spirits are made in Figma (file ARC SPIRITS DESIGN (LATEST), page Hex Spirits): their exported cards
    // are references/hex_bases/<Name>/figma-<side>.png (+ preview) and are the finished hexes; the old frame is not used for them.
    // Only the heroes (no Figma export) still use the old frame + icon placer below.
    for (const m of out) {
      const dir = join(ROOT, 'references/hex_bases', clean(m.name)), mt = async (f) => (await stat(join(ROOT, f)).catch(() => null))?.mtimeMs ?? 0;
      if (hexKit(m)) { // every spirit with an origin uses the Figma design (heroes keep the old frame)
        await hexState(m, dir, mt);
        continue;
      }
      m.source = 'frame';
      m.finalKey = createHash('sha1').update(JSON.stringify([2, await mt(m.front), m.back ? await mt(m.back) : 0, m.tier, m.originIcon, m.originIcon ? await mt(m.originIcon) : 0, m.classes, await Promise.all(m.classes.map((c) => c.icon ? mt(c.icon) : 0)), m.runes, await Promise.all(m.runes.flat().map(mt)), m.awakenText, place])).digest('hex').slice(0, 16);
      const saved = existsSync(join(dir, 'final.json')) ? JSON.parse(await readFile(join(dir, 'final.json'), 'utf8')) : {};
      m.final = {}; for (const side of ['front', 'back']) if (saved[side] === m.finalKey && existsSync(join(dir, `final-${side}.png`))) m.final[side] = `references/hex_bases/${clean(m.name)}/final-${side}`;
    }
    out.sort((a, b) => (a.origin ?? 'zz').localeCompare(b.origin ?? 'zz') || a.cost - b.cost || a.name.localeCompare(b.name));
    return [200, { spirits: out, placement: place, parallel: PARALLEL }];
  },
  /** Renders the front-base and back-base of one hex spirit from its art with the old repo's compositor: { name }. */
  async 'POST /api/game/hex-render'(body) {
    const [, list] = await routes['GET /api/game/hex-spirits']();
    const m = list.spirits.find((x) => x.name === body.name);
    if (!m) return [404, { error: 'Spirit not found.' }];
    if (m.kit) return [409, { error: `${m.name}: this hex uses the Figma design; it is made with POST /api/game/hex-generate.` }];
    if (!m.art) return [400, { error: `${m.name}: no pinned image to use as art.` }];
    if (!m.tier || !m.subfolder) return [400, { error: `${m.name}: no frame (tier ${m.tier}, subfolder ${m.subfolder}).` }];
    const aw = (await game('hex_spirits')).find((s) => s.name === m.dbName)?.awaken_condition ?? null;
    const outDir = join(ROOT, 'references/hex_bases', clean(m.name));
    await mkdir(outDir, { recursive: true });
    // The frame cache knows no 'abyss_void_astral': that is only the icon-slot tier; its frame is abyss/void or abyss/astral.
    const spec = { name: m.name, tier: m.tier === 'abyss_void_astral' ? 'abyss' : m.tier, subfolder: m.subfolder, art: join(ROOT, m.art), out_dir: outDir, crop: true, cost: m.cost, transform: m.transform ?? undefined,
      back: { awaken_type: aw?.type ?? null, awaken_text: aw?.type === 'text' ? aw.text : null, class_name: m.className ? m.className.toUpperCase() : null, class_desc: m.classDesc || null } };
    const specFile = join(outDir, 'render-spec.json');
    await writeFile(specFile, JSON.stringify(spec, null, 1));
    const REPO = join(homedir(), 'Documents/Programming/ArcSpirits/products/game-data-backend');
    const tool = join(fileURLToPath(new URL('.', import.meta.url)), 'tools/hex_render.py');
    const release = await renderSlot();
    try {
      // A render that runs alone uses 4 threads; renders in a batch use 2 each.
      const env = { ...process.env, HEX_RENDER_THREADS: running > 1 ? '2' : '4' };
      const { stdout } = await run(process.env.NIJI_PYTHON || join(REPO, '.venv-psd/bin/python'), [tool, '--spec', specFile], { maxBuffer: 1 << 24, timeout: 300000, env });
      await writeFile(join(outDir, 'render.json'), JSON.stringify({ art: m.art, at: Date.now(), tier: m.tier, subfolder: m.subfolder, transform: m.transform ?? null }, null, 1));
      return [200, { art: m.art, log: stdout.trim().split('\n').at(-1) }];
    } catch (e) { return [500, { error: `${m.name}: ${(e.stderr || e.message || '').toString().trim().split('\n').slice(-3).join(' ')}` }]; }
    finally { release(); }
  },
  /** The frame alone (no art) of one spirit for the interactive editor: { frame, mask } paths. Made one time per frame key. */
  async 'GET /api/game/hex-frame'(_, url) {
    const [, list] = await routes['GET /api/game/hex-spirits']();
    const m = list.spirits.find((x) => x.name === url.searchParams.get('name'));
    if (!m || (!m.tier && !m.kit)) return [404, { error: 'Spirit or frame not found.' }]; // a kit spirit (Figma design) needs no old tier: new Sun and Moon spirits have none
    if (m.kit) { // the Figma design: the frame of its template and origin, from the kit
      const d = `references/hex_template/${m.kit.template}/${m.kit.origin}`;
      return [200, { frame: `${d}/editor-frame.png`, mask: 'references/hex_template/shared/editor-mask.png' }];
    }
    const tier = m.tier === 'abyss_void_astral' ? 'abyss' : m.tier, sub = m.subfolder ?? 'standalone', region = m.region ?? 'Heroes', cost = m.cost;
    const key = `${tier}__${sub}__${cost}`, rel = `references/hex_frames/${key}.png`;
    if (!existsSync(join(ROOT, rel))) {
      const REPO = join(homedir(), 'Documents/Programming/ArcSpirits/products/game-data-backend');
      const tool = join(fileURLToPath(new URL('.', import.meta.url)), 'tools/hex_render.py');
      try { await run(process.env.NIJI_PYTHON || join(REPO, '.venv-psd/bin/python'), [tool, '--frame-preview', tier, sub, region, String(cost), join(ROOT, rel)], { maxBuffer: 1 << 24, timeout: 120000 }); }
      catch (e) { return [500, { error: (e.stderr || e.message || '').toString().trim().split('\n').at(-1) }]; }
    }
    return [200, { frame: rel, mask: rel.replace(/\.png$/, '-mask.png') }];
  },
  /** Saves a composed rune or augment icon: { name, base64 } -> references/icons/icon_pool/<name>.png and a local icon_pool row. Returns { iconId, icon }. */
  async 'POST /api/game/rune-icon'(body) {
    const name = String(body.name ?? '').trim();
    if (!name || typeof body.base64 !== 'string' || !body.base64) return [400, { error: 'Need a name and an image.' }];
    const file = `references/icons/icon_pool/${clean(name)}.png`;
    await mkdir(join(ROOT, 'references/icons/icon_pool'), { recursive: true });
    await writeFile(join(ROOT, file), Buffer.from(body.base64, 'base64'));
    const pool = await game('icon_pool');
    let row = pool.find((t) => t.name === name);
    if (!row) { row = { id: crypto.randomUUID(), name, source_type: 'local', file_path: null, tags: ['icon'], description: 'Made in the Niji Batch data editor.' }; pool.push(row); }
    await writeFile(join(GAME, 'icon_pool.json'), JSON.stringify(pool, null, 1));
    return [200, { iconId: row.id, icon: file }];
  },
  async 'GET /api/exports/settings'() { return [200, await loadSettings()]; },
  /** Saves one choice: { template, key, values: {...} } (merged into the entry). */
  async 'POST /api/exports/settings'(body) {
    const s = await loadSettings();
    const t = (s[String(body.template)] ??= {});
    t[String(body.key)] = { ...(t[String(body.key)] ?? {}), ...(body.values ?? {}) };
    await writeFile(SETTINGS, JSON.stringify(s, null, 1));
    return [200, {}];
  },
  /** Writes an exported PNG into the workspace: { folder, name, base64 }. The folder is made if needed. */
  /** The page saves a finished hex side (full size and a small preview). */
  async 'POST /api/game/hex-final'(body) {
    const dir = join(ROOT, 'references/hex_bases', clean(String(body.name ?? ''))), side = body.side === 'back' ? 'back' : 'front';
    if (!body.name || !existsSync(dir) || typeof body.full !== 'string' || typeof body.preview !== 'string') return [400, { error: 'Give name, side, key, full and preview.' }];
    if (existsSync(join(dir, 'figma-front.png'))) return [409, { error: `${body.name}: this hex is made in Figma now.` }];
    await writeFile(join(dir, `final-${side}.png`), Buffer.from(body.full, 'base64'));
    await writeFile(join(dir, `final-${side}-preview.png`), Buffer.from(body.preview, 'base64'));
    const f = join(dir, 'final.json'), saved = existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : {};
    saved[side] = String(body.key); await writeFile(f, JSON.stringify(saved));
    return [200, {}];
  },
  /** Makes a spirit's hex again with the generator: { name, force } (force: all sides, else only the changed ones). */
  async 'POST /api/game/hex-generate'(body) {
    const [, list] = await routes['GET /api/game/hex-spirits']();
    const m = list.spirits.find((x) => x.name === body.name);
    if (!m || !m.kit) return [404, { error: 'Spirit not found, or it does not use the Figma design.' }];
    const sides = body.force ? hexSides(m) : m.stale;
    try { const job = hexBusy.then(() => hexGenerate(m, sides)); hexBusy = job.catch(() => {}); await job; }
    catch (e) { return [500, { error: e.message }]; }
    return [200, { sides }];
  },
  /** Makes one monster card now: { name }. */
  async 'POST /api/game/monster-generate'(body) {
    const [, mons] = await routes['GET /api/game/monsters']();
    const m = mons.find((x) => x.name === body.name);
    if (!m) return [404, { error: 'Monster not found.' }];
    try { const job = hexBusy.then(() => monsterGenerate(m)); hexBusy = job.catch(() => {}); await job; }
    catch (e) { return [500, { error: e.message }]; }
    return [200, {}];
  },
  /** What the background generator did lately, and what is still waiting. */
  async 'GET /api/game/hex-generate'() {
    const [, list] = await routes['GET /api/game/hex-spirits']();
    const [, mons] = await routes['GET /api/game/monsters']();
    return [200, { log: hexLog, waiting: list.spirits.filter((m) => m.stale?.length).map((m) => ({ name: m.name, sides: m.stale })), monstersWaiting: mons.filter((m) => m.stale).map((m) => m.name) }];
  },
  /** Saves one side of a hex exported from Figma (2784 x 2414 PNG + a small preview): { name, side, full, preview } (base64). */
  async 'POST /api/game/hex-figma'(body) {
    const dir = join(ROOT, 'references/hex_bases', clean(String(body.name ?? ''))), side = body.side === 'back' ? 'back' : 'front';
    if (!body.name || !existsSync(dir) || typeof body.full !== 'string' || typeof body.preview !== 'string') return [400, { error: 'Give name, side, full and preview.' }];
    await writeFile(join(dir, `figma-${side}.png`), Buffer.from(body.full, 'base64'));
    await writeFile(join(dir, `figma-${side}-preview.png`), Buffer.from(body.preview, 'base64'));
    return [200, {}];
  },
  async 'POST /api/export'(body) {
    const folder = String(body.folder ?? '').replace(/^\/+|\/+$/g, '');
    if (!/^assets\/exports(\/|$)/.test(folder)) return [400, { error: 'Exports go under assets/exports.' }];
    const name = clean(String(body.name ?? 'export')).replace(/\.png$/i, '') + '.png';
    if (typeof body.base64 !== 'string' || !body.base64) return [400, { error: 'No image.' }];
    const dir = workspace.safe(folder);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), Buffer.from(body.base64, 'base64'));
    return [200, { path: `${folder}/${name}` }];
  },
};

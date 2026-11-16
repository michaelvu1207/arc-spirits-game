#!/usr/bin/env python3
"""Hex spirit generator: the Figma design (file "ARC SPIRITS DESIGN (LATEST)", page "Hex Spirits") rebuilt in code.

    python hex_generate.py --spec spec.json

The fixed parts of the frame (borders, rim glow, outline texture, Arcane Fill panels, paint strokes, origin icons,
non-arcane ring) were exported from Figma once into <workspace>/references/hex_template/ (the "template kit").
This script adds what changes per spirit: the art (placed like the art editor, with the Figma blurs), the name and
its plate (sized to the name), the class / rune icons, the back text, and the outline colour (Difference blend,
base colour chosen from the art, as in Figma).

spec = { "template": "arcane" | "non-arcane", "origin": "Fire" | ... , "side": "front" | "back", "name": "...",
         "art": "/abs/art.png", "transform": {scale,x,y,flip} | null,
         "classes": [{"name","icon": "/abs" | null, "special": bool}], "runes": [["/abs", ...], ...],
         "awakenType": "text" | "rune_cost" | null, "awakenText": str | null, "className": str | null, "classDesc": str,
         "kit": "/abs/references/hex_template", "out": "/abs/out.png", "preview": "/abs/out-preview.png" }
"""
import argparse, json, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

CW, CH = 2784, 2414
OX, OY = 110, 298            # card origin inside the old 3000 x 3000 PSD canvas (back text styles use PSD coordinates)
BACKING = (26, 26, 26)
BLUR_K = 0.5                 # Figma blur radius -> gaussian sigma
DIFF_TARGET = {'Fire': (180, 41, 41), 'Mountain': (150, 155, 165), 'Water': (45, 110, 200)}   # Difference-blend origins
FIXED_BASE = {'Forest': (116, 138, 56), 'Sun': (242, 184, 28), 'Moon': (16, 16, 26), 'Eclipse': (58, 34, 92)}  # Normal-blend origins
NAME_STYLE = {'left': 656.409066055798, 'baseline': 2072.4574923083997, 'visual_pt': 181.87399314424766}
NAME_COLOUR = (242, 242, 242)
RUNE_SLOTS = [(1048, 419), (1373, 413), (714, 414), (1698, 408)]  # 4th slot (2026-11-14): Sun spirits that cost 4 runes


# ---------------------------------------------------------------- small helpers
def f32(im):
    return np.asarray(im.convert('RGBA'), dtype=np.float32) / 255.0

def layer(kit, folder, name, offsets):
    """A kit layer as a full-card float RGBA array (straight alpha)."""
    out = np.zeros((CH, CW, 4), np.float32)
    off = offsets.get(folder, {}).get(name)
    if off is None:
        return out
    a = f32(Image.open(os.path.join(kit, folder, name + '.png')))
    x, y = off; h, w = a.shape[:2]
    out[y:y + h, x:x + w] = a[:CH - y, :CW - x]
    return out

def over(dst, src, opacity=1.0):
    """Normal blend of a straight-alpha RGBA layer onto an opaque RGB canvas."""
    a = src[..., 3:4] * opacity
    return dst * (1 - a) + src[..., :3] * a

def blend(dst, src, mode, opacity=1.0):
    a = src[..., 3:4] * opacity; s = src[..., :3]
    if mode == 'difference':
        r = np.abs(dst - s)
    elif mode == 'hard_light':
        r = np.where(s <= 0.5, dst * 2 * s, 1 - (1 - dst) * (1 - (2 * s - 1)))
    else:
        r = s
    return dst * (1 - a) + r * a

def poly_alpha(points, ox, oy, ss=4):
    """Anti-aliased polygon coverage (card coordinates), as a full-card float array."""
    xs = [p[0] + ox for p in points]; ys = [p[1] + oy for p in points]
    x0, y0 = int(np.floor(min(xs))) - 2, int(np.floor(min(ys))) - 2
    x1, y1 = int(np.ceil(max(xs))) + 2, int(np.ceil(max(ys))) + 2
    im = Image.new('L', ((x1 - x0) * ss, (y1 - y0) * ss), 0)
    ImageDraw.Draw(im).polygon([((x - x0) * ss, (y - y0) * ss) for x, y in zip(xs, ys)], fill=255)
    im = im.resize((x1 - x0, y1 - y0), Image.Resampling.BOX)
    out = np.zeros((CH, CW), np.float32)
    a = np.asarray(im, np.float32) / 255
    cx0, cy0 = max(0, x0), max(0, y0); cx1, cy1 = min(CW, x1), min(CH, y1)
    out[cy0:cy1, cx0:cx1] = a[cy0 - y0:cy1 - y0, cx0 - x0:cx1 - x0]
    return out

def contain(path, size, white=False):
    im = Image.open(path).convert('RGBA'); k = min(size / im.width, size / im.height)
    im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.Resampling.LANCZOS)
    if white:
        w = Image.new('RGBA', im.size, (255, 255, 255, 255)); w.putalpha(im.getchannel('A')); im = w
    cv = Image.new('RGBA', (size, size), (0, 0, 0, 0)); cv.paste(im, ((size - im.width) // 2, (size - im.height) // 2)); return cv

def paste_layer(img, x, y):
    out = np.zeros((CH, CW, 4), np.float32); a = f32(img); h, w = a.shape[:2]
    sx0, sy0 = max(0, -x), max(0, -y); dx0, dy0 = max(0, x), max(0, y)
    w2, h2 = min(w - sx0, CW - dx0), min(h - sy0, CH - dy0)
    if w2 > 0 and h2 > 0: out[dy0:dy0 + h2, dx0:dx0 + w2] = a[sy0:sy0 + h2, sx0:sx0 + w2]
    return out


# ---------------------------------------------------------------- art
def place_art(spec):
    """Art on the card exactly as the art editor / old renderer places it: cover-fit, then scale and offset."""
    art = Image.open(spec['art']).convert('RGBA'); t = spec.get('transform') or {}
    k = max(CW / art.width, CH / art.height) * float(t.get('scale', 1) or 1)
    sw, sh = max(1, round(art.width * k)), max(1, round(art.height * k))
    ax = round(1502 - OX + float(t.get('x', 0) or 0) - sw / 2); ay = round(1505 - OY + float(t.get('y', 0) or 0) - sh / 2)
    a = art.resize((sw, sh), Image.Resampling.LANCZOS)
    if t.get('flip'): a = a.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    cv = Image.new('RGBA', (CW, CH), BACKING + (255,)); cv.alpha_composite(a, (ax, ay)) if ax >= 0 and ay >= 0 else cv.paste(a, (ax, ay), a)
    return cv.convert('RGB')

def gblur(im, radius):
    return im.filter(ImageFilter.GaussianBlur(radius * BLUR_K))

def progressive_blur(im, y0=1500, y1=2414, radius=60, steps=6):
    """Figma progressive layer blur: no blur above y0, growing to `radius` at y1."""
    top = max(0, y0 - int(radius * 2)); crop = im.crop((0, top, CW, CH))
    levels = [np.asarray(crop, np.float32)] + [np.asarray(gblur(crop, radius * i / steps), np.float32) for i in range(1, steps + 1)]
    ys = np.arange(top, CH, dtype=np.float32); t = np.clip((ys - y0) / (y1 - y0), 0, 1) * steps
    lo = np.floor(t).astype(int); hi = np.minimum(lo + 1, steps); f = (t - lo)[:, None, None]
    L = np.stack(levels); rows = np.arange(len(ys))
    res = L[lo, rows] * (1 - f) + L[hi, rows] * f
    out = np.asarray(im, np.float32).copy(); out[top:] = res
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


# ---------------------------------------------------------------- text
def load_font(kit, file, size):
    return ImageFont.truetype(os.path.join(kit, 'fonts', file), size=max(8, int(round(size))))

def name_mask(kit, text):
    """The spirit name in Opsilon Italic with its soft glow (same as the Figma name layers). Returns an 'L' image."""
    GLOW, SOFTEN, HALO, MINPT, FITW = 7.0, 1.0, 0.70, 45, 1600.0
    left, baseline, size = NAME_STYLE['left'], NAME_STYLE['baseline'], NAME_STYLE['visual_pt']
    font = load_font(kit, 'Opsilon-Italic.ttf', size); sc = ImageDraw.Draw(Image.new('RGBA', (1, 1)))
    tb = sc.textbbox((0, 0), text, font=font, anchor='ls'); tw = tb[2] - tb[0]
    if tw > FITW: size = max(MINPT, size * (FITW / float(tw))); font = load_font(kit, 'Opsilon-Italic.ttf', size)
    tb = sc.textbbox((left, baseline), text, font=font, anchor='ls'); pad = int(round(GLOW * 3)) + 16
    lx0, ly0, lx1, ly1 = int(tb[0]) - pad, int(tb[1]) - pad, int(tb[2]) + pad, int(tb[3]) + pad
    lay = Image.new('RGBA', (max(1, lx1 - lx0), max(1, ly1 - ly0)), (0, 0, 0, 0))
    ImageDraw.Draw(lay).text((left - lx0, baseline - ly0), text, font=font, fill=(255, 255, 255, 255), anchor='ls')
    ha = lay.getchannel('A').filter(ImageFilter.GaussianBlur(radius=GLOW)).point(lambda p: int(p * HALO))
    halo = Image.new('RGBA', lay.size, (255, 255, 255, 0)); halo.putalpha(ha)
    return Image.alpha_composite(halo, lay.filter(ImageFilter.GaussianBlur(radius=SOFTEN))).getchannel('A')

def wrap_text(draw, text, font, max_width):
    lines = []
    for para in (text or '').replace('\r\n', '\n').replace('\r', '\n').split('\n'):
        cur = ''
        for word in para.split(' '):
            test = word if not cur else f'{cur} {word}'
            if draw.textlength(test, font=font) > max_width and cur: lines.append(cur); cur = word
            else: cur = test
        if cur or not lines: lines.append(cur)
    return lines

def back_text(kit, spec):
    """The back's text exactly as on the Figma backs: awaken header + requirement, class name, class description.
    Returns (RGBA image of the card, bottom of the awaken text in card px or None)."""
    man = json.load(open(os.path.join(kit, 'back_overlay', 'manifest.json'))); styles = man['type_styles']
    st = lambda n: next(s for s in styles if s.get('name') == n)
    cv = Image.new('RGBA', (3000, 3000), (0, 0, 0, 0)); awb = None; aw = spec.get('awakenType')
    if aw:
        tf = 'T01_L01_to_awaken.png' if aw == 'text' else 'T00_L00_DISCARD_to_awaken.png'
        T0 = next(x for x in man['static_types'] if x['file'] == tf)
        cv.alpha_composite(Image.open(os.path.join(kit, 'back_overlay', tf)).convert('RGBA'), (T0['bbox'][0], T0['bbox'][1])); awb = 719
        if aw == 'text' and (spec.get('awakenText') or '').strip():
            s = st('REQUIREMENT'); x1, y1, x2, y2 = s['box_bounds']; width, height = x2 - x1, y2 - y1
            size = float(s['visual_pt']); lead = float(s.get('auto_leading') or 1.2); fill = tuple(s['fill'])
            sc = ImageDraw.Draw(Image.new('RGBA', (1, 1))); text = spec['awakenText'].lstrip()
            font = load_font(kit, 'Lato-Regular.ttf', size); lines = wrap_text(sc, text, font, width); guard = 0
            while len(lines) * size * lead > height + 4 and size > 48 and guard < 12:
                size *= 0.94; font = load_font(kit, 'Lato-Regular.ttf', size); lines = wrap_text(sc, text, font, width); guard += 1
            l = Image.new('RGBA', (3000, 3000), fill[:3] + (0,)); d = ImageDraw.Draw(l)
            for i, line in enumerate(lines): d.text((x1 + width / 2, y1 + i * size * lead), line, font=font, fill=fill, anchor='mt')
            bb = l.getchannel('A').getbbox()
            if bb: awb = bb[3] - OY
            cv.alpha_composite(l)
    if spec.get('className'):
        s = st('CLASS_NAME'); size = float(s['visual_pt']); font = load_font(kit, 'Opsilon-Regular.ttf', size); text = spec['className'].upper()
        bbox = s['bbox']; max_w = max(8, int(bbox[2]) - int(bbox[0])); tw = ImageDraw.Draw(Image.new('RGBA', (1, 1))).textbbox((0, 0), text, font=font)[2]
        if tw > max_w * 1.15: size = max(40.0, size * (max_w / float(tw))); font = load_font(kit, 'Opsilon-Regular.ttf', size)
        ImageDraw.Draw(cv).text((float(s['left']), float(s['baseline'])), text, font=font, fill=tuple(s['fill']), anchor='ls')
        desc = (spec.get('classDesc') or '').strip()
        if desc:
            s = st('CLASS_DESC'); fill = tuple(s['fill'][:4]); size = float(s['visual_pt'])
            while True:   # wrap inside the hex, beside the class icon and right of the origin corner; shrink until it fits
                font = load_font(kit, 'Lato-Regular.ttf', size); sc = ImageDraw.Draw(Image.new('RGBA', (1, 1))); lh = size * 1.2
                words = desc.split(); lines = []; j = 0; y = 1408
                while j < len(words):
                    yb = y + lh; left = max(957, 1091 + (yb - 1923) * 0.58 + 80) if yb > 1960 else 957
                    right = min(2250, 2790 - (yb - 1210) * 0.5795 - 185 - 50); cur = ''
                    while j < len(words):
                        tt = (cur + ' ' + words[j]).strip()
                        if sc.textlength(tt, font=font) <= right - left or not cur: cur = tt; j += 1
                        else: break
                    lines.append((left, y, cur)); y += lh
                if y <= 2235 or size < 70: break
                size -= 3
            d = ImageDraw.Draw(cv)
            for lft, yv, sx in lines: d.text((lft + OX, yv - 21 + OY), sx, font=font, fill=fill)
    return cv.crop((OX, OY, OX + CW, OY + CH)), awb


# ---------------------------------------------------------------- outline colour
def base_colour(spec, art_rgb, frameshape, factor):
    """Difference-blend origins: the solid base under the outline texture, per channel, so that |below - base| lands on
    the origin's target colour on average (same search as in Figma)."""
    o = spec['origin']
    if o not in DIFF_TARGET: return FIXED_BASE.get(o, (128, 128, 128)), 'normal'
    Q = 4; b = np.asarray(art_rgb.resize((CW // Q, CH // Q), Image.Resampling.BILINEAR)).astype(np.float32)
    m = frameshape[::Q, ::Q][:b.shape[0], :b.shape[1]] > 0.5
    pix = np.round(b * factor).astype(np.uint8)[m]; T = DIFF_TARGET[o]; c = []
    v = np.arange(256)
    for ch in range(3):
        h = np.bincount(pix[:, ch], minlength=256).astype(np.float64)
        c.append(int(np.argmin([(h * ((np.abs(v - k) - T[ch]) ** 2)).sum() for k in range(256)])))
    return tuple(c), 'difference'

def outline(kit, folder, offs, prefix, base):
    """Outline texture with the given solid base colour: linear between the black-base and white-base exports."""
    f0 = layer(kit, folder, prefix + 'frame0', offs); f1 = layer(kit, folder, prefix + 'frame1', offs)
    c = np.array(base, np.float32) / 255
    out = f0.copy(); out[..., :3] = f0[..., :3] + (f1[..., :3] - f0[..., :3]) * c
    return out


# ---------------------------------------------------------------- the cards
def plate_points(w):
    return [(0, 0), (w - 83, 0), (w, 143), (w - 83, 286), (165.7, 286)]

def arcane(spec, kit, offs):
    side = spec['side']; folder = 'arcane/' + spec['origin']
    if not os.path.isdir(os.path.join(kit, folder)): folder = 'arcane/Fire'
    art = place_art(spec)
    if side == 'front': art_b = progressive_blur(art)
    else: art_b = art
    img = np.asarray(art_b, np.float32) / 255
    band = layer(kit, 'shared', 'bandmask', offs)[..., 3:4]
    img = img * (1 - band) + (np.asarray(gblur(art, 110), np.float32) / 255) * band            # edge blur, outer 25% of the hex
    fs = layer(kit, 'shared', 'frameshape', offs)[..., 3]
    if side == 'front':
        img = over(img, layer(kit, folder, 'borders', offs))
        img = blend(img, layer(kit, folder, 'rim', offs), 'hard_light')
        nm = name_mask(kit, spec['name'].upper()); w = nm.width + 316
        pa = poly_alpha(plate_points(w), 255.85, 1495)[..., None]
        img = img * (1 - pa * 0.82)                                                                   # under-shade, 82 % black
        # the name plate texture, stretched to this plate's width like Figma does, Difference blend
        pl = Image.open(os.path.join(kit, folder, 'plate.png')).convert('RGBA'); px, py = offs[folder]['plate']
        pl = pl.resize((max(1, round(w)), pl.height), Image.Resampling.BILINEAR)   # stretched with the plate, like the Figma gradient
        P = paste_layer(pl, px, py); P[..., 3] = pa[..., 0] * (P[..., 3] > 0.02)
        img = blend(img, P, 'difference')
        img = over(img, layer(kit, folder, 'frame_under', offs))
        base, mode = base_colour(spec, art, fs, 0.4)
        img = blend(img, outline(kit, folder, offs, '', base), mode)
    else:
        img = img * 0.65                                                                              # 35 % dim behind the text
        txt, awb = back_text(kit, spec)
        if awb is not None:
            ap = layer(kit, folder, 'awaken_panel', offs); ap[min(CH, awb + 90):] = 0; img = over(img, ap)
        img = over(img, layer(kit, folder, 'class_panel', offs))
        sk = layer(kit, folder, 'strokes', offs)                     # strokes of the awaken area only with an awaken panel, and not below it
        cut = min(950, awb + 130) if awb is not None else 0; sk[cut:950] = 0
        img = over(img, sk)
        img = over(img, layer(kit, folder, 'back_borders', offs))
        base, mode = base_colour(spec, art, fs, 0.65)
        img = blend(img, outline(kit, folder, offs, 'back_', base), mode)
        img = over(img, layer(kit, folder, 'strokes_over', offs))
    hexa = layer(kit, 'shared', 'hexmask', offs)[..., 3:4]
    out = np.concatenate([img, hexa], -1)
    def top(lay):
        nonlocal out
        a = lay[..., 3:4]; out[..., :3] = out[..., :3] * (1 - a) + lay[..., :3] * a; out[..., 3:4] = out[..., 3:4] + a * (1 - out[..., 3:4])
    top(layer(kit, folder, 'origin_icon', offs))
    if side == 'front':
        n = Image.new('RGBA', nm.size, NAME_COLOUR + (0,)); n.putalpha(nm)
        top(paste_layer(n, 431, round(1638 - nm.height / 2)))
        for i, c in enumerate([c for c in spec.get('classes', []) if c.get('icon')][:5]):
            top(paste_layer(contain(c['icon'], 300, white=True), 1290 + i * 290, 1940))
    else:
        top(paste_layer(txt, 0, 0))
        for i, group in enumerate((spec.get('runes') or [])[:len(RUNE_SLOTS)]):
            top(paste_layer(rune_slot(group), *RUNE_SLOTS[i]))
        sp = next((c for c in spec.get('classes', []) if c.get('special') and c.get('icon')), None)
        if sp: top(paste_layer(contain(sp['icon'], 300, white=True), 552, 1439))
    return out

def rune_slot(icons, s=300):
    if len(icons) == 1: return contain(icons[0], s)
    cv = Image.new('RGBA', (s, s), (0, 0, 0, 0)); n = len(icons); sub = int(s / (n + 0.35 * (n - 1)))
    gap = int(0.35 * sub); total = n * sub + (n - 1) * gap; x = (s - total) // 2; d = ImageDraw.Draw(cv)
    for i, p in enumerate(icons):
        cv.alpha_composite(contain(p, sub), (x, (s - sub) // 2)); x += sub
        if i < n - 1: d.text((x + gap / 2, s / 2), '/', fill=(255, 255, 255, 255), anchor='mm', font=ImageFont.load_default(size=sub)); x += gap
    return cv

def non_arcane(spec, kit, offs):
    folder = 'non-arcane/' + spec['origin']
    if not os.path.isdir(os.path.join(kit, folder)): folder = 'non-arcane/Fire'
    art = progressive_blur(place_art(spec)); img = np.asarray(art, np.float32) / 255
    nm = name_mask(kit, spec['name'].upper()); w = nm.width + 417
    pa = poly_alpha(plate_points(w), 207.3, 1585)
    P = layer(kit, folder, 'plate', offs); P[..., 3] = pa
    img = over(img, P)
    n = max(1, len([c for c in spec.get('classes', []) if c.get('icon')]))
    L = 545 + 293 * (n - 1); ib = poly_alpha([(0, 0), (L, 0), (L + 261.3, 451), (261.3, 451)], 1042, 1967)[..., None]
    img = img * (1 - ib) + np.array([219, 224, 229], np.float32) / 255 * ib
    img = over(img, layer(kit, folder, 'ring', offs))
    hexa = layer(kit, 'shared', 'hexmask', offs)[..., 3:4]
    out = np.concatenate([img, hexa], -1)
    def top(lay):
        a = lay[..., 3:4]; out[..., :3] = out[..., :3] * (1 - a) + lay[..., :3] * a; out[..., 3:4] = out[..., 3:4] + a * (1 - out[..., 3:4])
    n2 = Image.new('RGBA', nm.size, NAME_COLOUR + (0,)); n2.putalpha(nm); top(paste_layer(n2, 483, round(1728 - nm.height / 2)))
    top(layer(kit, folder, 'origin_icon', offs))
    slots = [(1234, 2006), (1527, 1997), (1820, 1988)]
    for i, c in enumerate([c for c in spec.get('classes', []) if c.get('icon')][:3]):
        top(paste_layer(contain(c['icon'], 300), *slots[i]))
    return out

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--spec', required=True); a = ap.parse_args()
    spec = json.load(open(a.spec)); kit = spec['kit']; offs = json.load(open(os.path.join(kit, 'offsets.json')))
    out = (arcane if spec['template'] == 'arcane' else non_arcane)(spec, kit, offs)
    im = Image.fromarray(np.clip(np.round(out * 255), 0, 255).astype(np.uint8), 'RGBA')
    os.makedirs(os.path.dirname(spec['out']), exist_ok=True)
    tmp = spec['out'] + '.tmp.png'; im.save(tmp, compress_level=6); os.replace(tmp, spec['out'])
    if spec.get('preview'): im.resize((696, round(696 * CH / CW)), Image.Resampling.LANCZOS).save(spec['preview'], optimize=True)
    print(json.dumps({'ok': True, 'out': spec['out']}))

if __name__ == '__main__':
    main()

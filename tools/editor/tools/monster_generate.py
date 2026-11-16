#!/usr/bin/env python3
"""Monster card generator: the merged monster card from Figma (page "Design Drafts", "Ash Puff — merged monster card",
2.75 x 4.75 in = 825 x 1425 px at 300 dpi) rebuilt in code.

    python monster_generate.py --spec spec.json

Fixed parts come from the template kit <workspace>/references/monster_template/ (exported from Figma):
background.png (card colour, rounded), artmask.png (arch window), artstroke.png (cream outline of the window),
overlay.png (bottom gradient, arch line, health/damage badges, class pill, Kill Rewards ribbon).
Per monster: art (cover-fit into the window, progressive blur at the bottom like Figma), health and damage values,
"CLASS <stage>", the name, and the kill-reward icons.

spec = { "name", "health", "damage", "classLabel", "art": "/abs" | null, "transform": {scale,x,y,flip} | null,
         "rewards": ["/abs icon", ...], "kit": "/abs/references/monster_template", "out": "/abs.png", "preview": "/abs.png" | null }
"""
import argparse, json, os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 825, 1425
WIN = (40, 40, 745, 1345)                       # art window: x, y, w, h
CREAM, VALUE_FILL = (252, 244, 219), (254, 235, 201)
HEALTH_STROKE, DAMAGE_STROKE, CLASS_TEXT = (68, 39, 35), (85, 39, 33), (137, 69, 60)

def font(kit, size): return ImageFont.truetype(os.path.join(kit, 'fonts', 'Opsilon-Regular.ttf'), max(8, int(round(size))))

def f32(im): return np.asarray(im.convert('RGBA'), np.float32) / 255.0

def art_layer(spec, kit):
    """Art cover-fit into the arch window (plus the window's cream outline), as a straight-alpha float RGBA card."""
    x, y, w, h = WIN; cv = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    if spec.get('art'):
        art = Image.open(spec['art']).convert('RGBA'); t = spec.get('transform') or {}
        k = max(w / art.width, h / art.height) * float(t.get('scale', 1) or 1)
        sw, sh = max(1, round(art.width * k)), max(1, round(art.height * k))
        a = art.resize((sw, sh), Image.Resampling.LANCZOS)
        if t.get('flip'): a = a.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        win = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        win.paste(a, (round((w - sw) / 2 + float(t.get('x', 0) or 0)), round((h - sh) / 2 + float(t.get('y', 0) or 0))), a)
        cv.paste(win, (x, y))
    m = Image.open(os.path.join(kit, 'artmask.png')).getchannel('A')
    cv.putalpha(Image.fromarray((np.asarray(cv.getchannel('A'), np.float32) * np.asarray(m, np.float32) / 255).astype(np.uint8)))
    cv.alpha_composite(Image.open(os.path.join(kit, 'artstroke.png')).convert('RGBA'))
    return f32(cv)

def progressive_blur(rgba, y0, y1, radius, steps=6):
    """Figma progressive layer blur on a straight-alpha RGBA layer (premultiplied, so it bleeds out like Figma)."""
    pm = rgba.copy(); pm[..., :3] *= pm[..., 3:4]
    top = max(0, int(y0 - radius * 2)); crop = pm[top:]
    def blur(a, r):
        if r <= 0: return a
        ch = [np.asarray(Image.fromarray(np.clip(np.round(a[..., i] * 255), 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r * 0.5)), np.float32) / 255 for i in range(4)]
        return np.stack(ch, -1)
    L = np.stack([blur(crop, radius * i / steps) for i in range(steps + 1)])
    ys = np.arange(top, H, dtype=np.float32); t = np.clip((ys - y0) / (y1 - y0), 0, 1) * steps
    lo = np.floor(t).astype(int); hi = np.minimum(lo + 1, steps); f = (t - lo)[:, None, None]; rows = np.arange(len(ys))
    pm[top:] = L[lo, rows] * (1 - f) + L[hi, rows] * f
    out = pm.copy(); a = np.maximum(pm[..., 3:4], 1e-6); out[..., :3] = np.where(pm[..., 3:4] > 0, pm[..., :3] / a, 0)
    return out

def over(dst, src):
    """Straight-alpha 'over' of two RGBA float layers."""
    sa = src[..., 3:4]; da = dst[..., 3:4]; oa = sa + da * (1 - sa)
    rgb = np.where(oa > 0, (src[..., :3] * sa + dst[..., :3] * da * (1 - sa)) / np.maximum(oa, 1e-6), 0)
    return np.concatenate([rgb, oa], -1)

def text_layer(kit, text, size, centre, fill, stroke=None, stroke_w=0, shadow=None, max_w=None):
    f = font(kit, size); d = ImageDraw.Draw(Image.new('RGBA', (1, 1)))
    if max_w:
        while d.textlength(text, font=f) > max_w and size > 20: size *= 0.95; f = font(kit, size)
    cv = Image.new('RGBA', (W, H), fill + (0,)); dr = ImageDraw.Draw(cv)
    dr.text(centre, text, font=f, fill=fill + (255,), anchor='mm', stroke_width=stroke_w, stroke_fill=(stroke + (255,)) if stroke else None)
    lay = f32(cv)
    if shadow:   # (rgb, alpha, dy, radius)
        rgb, al, dy, r = shadow; sa = cv.getchannel('A').filter(ImageFilter.GaussianBlur(r * 0.5))
        sh = Image.new('RGBA', (W, H), rgb + (0,)); sh.putalpha(Image.fromarray((np.asarray(sa, np.float32) * al).astype(np.uint8)))
        sh2 = Image.new('RGBA', (W, H), (0, 0, 0, 0)); sh2.paste(sh, (0, dy)); lay = over(f32(sh2), lay)
    return lay

def contain(path, s):
    im = Image.open(path).convert('RGBA'); k = min(s / im.width, s / im.height)
    im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.Resampling.LANCZOS)
    cv = Image.new('RGBA', (s, s), (0, 0, 0, 0)); cv.paste(im, ((s - im.width) // 2, (s - im.height) // 2)); return cv

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--spec', required=True); spec = json.load(open(ap.parse_args().spec)); kit = spec['kit']
    bg = f32(Image.open(os.path.join(kit, 'background.png')))
    x, y, w, h = WIN
    art = progressive_blur(art_layer(spec, kit), y + 0.62 * h, y + h, 44)
    img = over(bg, art)
    img = over(img, f32(Image.open(os.path.join(kit, 'overlay.png'))))
    img = over(img, text_layer(kit, str(spec.get('health', '')), 90.3, (107, 147), VALUE_FILL, HEALTH_STROKE, 3))
    img = over(img, text_layer(kit, str(spec.get('damage', '')), 90.3, (719, 147), VALUE_FILL, DAMAGE_STROKE, 3))
    if spec.get('classLabel'): img = over(img, text_layer(kit, spec['classLabel'].upper(), 40, (413, 44), CLASS_TEXT, max_w=150))
    img = over(img, text_layer(kit, spec['name'].upper(), 78, (412.5, 1040), CREAM, shadow=((13, 5, 20), 0.7, 4, 10), max_w=690))
    icons = [p for p in spec.get('rewards') or [] if p and os.path.exists(p)]
    if icons:
        n = len(icons); s = min(170, int((700 - 36 * (n - 1)) / n)); total = n * s + (n - 1) * 36; x0 = 412.5 - total / 2
        cv = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        for i, p in enumerate(icons): ic = contain(p, s); cv.alpha_composite(ic, (round(x0 + i * (s + 36)), round(1273 - s / 2)))
        img = over(img, f32(cv))
    img[..., 3:4] = np.minimum(img[..., 3:4], bg[..., 3:4])   # clipped to the card's rounded corners
    im = Image.fromarray(np.clip(np.round(img * 255), 0, 255).astype(np.uint8), 'RGBA')
    os.makedirs(os.path.dirname(spec['out']), exist_ok=True); tmp = spec['out'] + '.tmp.png'; im.save(tmp); os.replace(tmp, spec['out'])
    if spec.get('preview'): im.resize((330, 570), Image.Resampling.LANCZOS).save(spec['preview'], optimize=True)
    print(json.dumps({'ok': True, 'out': spec['out']}))

if __name__ == '__main__': main()

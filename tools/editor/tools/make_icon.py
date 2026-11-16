#!/usr/bin/env python3
"""Makes one game icon in the Arc Spirits class-icon style (guidelines: tools/ICON-GUIDELINES.md).

Usage:  python3 tools/make_icon.py "<Class name>" "<subject>" [--art <workspace image>] [--out <folder>]
Example: python3 tools/make_icon.py "Paladin" "only a sword with one flame above it, in front of a kite shield" --art "assets/spirits/Fire/Ash Paladin/character design/x.png"

Writes <out>/<Class name>.png (default out: references/icons/classes_new, shown as a "new" proposal in the Data page).
It calls `codex exec` with the built-in image_gen tool, then turns the white background into transparency.
"""
import argparse, glob, json, os, subprocess, sys, tempfile, time
from PIL import Image, ImageOps

ROOT = os.path.expanduser('~/ArcSpiritsArt/')
STYLE = ROOT + 'references/icons/icon-style-reference.png'  # six original icons: King, Fairy, Fighter, Cultivator, Healer, Elementalist
COLOR = (0x41, 0x3c, 0x3b)
PROMPT = ("A single game class icon, a flat one-color dark charcoal silhouette emblem on a pure white background, in the style of the six icons "
          "in the first reference image. SIMPLE and BOLD: one strong clear silhouette made of a few large solid shapes, readable at 32 pixels. "
          "Only a few thick negative-space cuts for the most important inner details. No fine lines, no small ornaments, no filigree, no scattered "
          "dots or sparkles, no decorative border or swirls around the subject. About half the detail of an ornate emblem. No text, no letters, "
          "no frame, no gradient, no grey tones, centered with margin. Close-up: the subject fills the frame. Subject: {subject}.{art}")

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('name'); ap.add_argument('subject'); ap.add_argument('--art'); ap.add_argument('--out', default=ROOT + 'references/icons/classes_new')
    a = ap.parse_args()
    refs = [STYLE] + ([os.path.join(ROOT, a.art)] if a.art else [])
    art = ' The second reference image is the character that has this class; take its main prop or shape as the motif, but draw an emblem, not a portrait.' if a.art else ''
    work = tempfile.mkdtemp(prefix='icon-'); start = time.time()
    task = ("Use your built-in image_gen tool to make ONE image, then copy the generated PNG file into the current directory as icon.png. Do nothing else.\n"
            f"Image prompt: {PROMPT.format(subject=a.subject, art=art)}\nReference image paths (pass them as referenced_image_paths): {json.dumps(refs)}")
    try:
        subprocess.run(['codex', 'exec', '-s', 'workspace-write', '-C', work, '--skip-git-repo-check', task], stdin=subprocess.DEVNULL, capture_output=True, timeout=420)
    except subprocess.TimeoutExpired:
        pass  # codex often makes the image and then hangs before the copy; the image is still in ~/.codex/generated_images
    src = os.path.join(work, 'icon.png')
    if not os.path.exists(src):
        new = [f for f in glob.glob(os.path.expanduser('~/.codex/generated_images/*/*.png')) if os.path.getmtime(f) > start]
        if not new: sys.exit('No image was made. Run it again.')
        src = max(new, key=os.path.getmtime)  # with several runs at once this can be the wrong one: run one at a time, or check the result
    g = ImageOps.autocontrast(Image.open(src).convert('L'))
    alpha = g.point(lambda v: 255 if v < 96 else 0 if v > 200 else int((200 - v) * 255 / 104))
    im = Image.new('RGBA', g.size, COLOR + (0,)); im.putalpha(alpha); im = im.crop(alpha.getbbox()); im.thumbnail((512, 512))
    os.makedirs(a.out, exist_ok=True); out = os.path.join(a.out, a.name + '.png'); im.save(out); print(out)

if __name__ == '__main__': main()

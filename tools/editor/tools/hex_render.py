#!/usr/bin/env python3
"""Render FRONT-BASE and BACK-BASE of one Arc Spirits hex spirit from new art.

Offline. Reuses the old editor repo (game-data-backend) by import; nothing in
that repo is changed (no .pyc is written there either). It replays the
pipeline that made the live bases (rework 2026-10-15):

  1. scripts/render_migration_spirits.py
       front: export_hex_prints._export_one_from_cache steps, with the art fit
              swapped to export_reworked_hex_gallery.fit_for_hex, MIN_NAME_PT=45,
              and the IMG_5368 / "art" overlays dropped
       back : export_hex_icons_and_backs.export_one_back steps, without the icon
              stamp. The 385px special-class icon square is only reserved
              (CLASS_DESC wraps around it). No origin/class/rune icons are drawn.
  2. scripts/finalize_migration_assets.mjs
       regional rim: src/lib/generators/spirits/regionalHexEdges.js
       restyleHexEdges(rgba, 3000, 3000, region, cost), run through node
  3. scripts/fix_game_texture_bounds.py
       both bases take the front's solidified alpha (alpha > 0 -> 255), then
       crop to the hex box (110, 298, 2894, 2712) -> 2784 x 2414 (when crop=true)

Usage:
  .venv-psd/bin/python hex_render.py --spec spec.json     (or --spec - for stdin)

spec.json:
  {"name": "Caldera", "tier": "abyss", "subfolder": "lantern",
   "art": "/abs/art.png", "out_dir": "/abs/dir",
   "back": {"awaken_type": "rune_cost" | "text" | null, "awaken_text": "..." | null,
            "class_name": "TITAN" | null, "class_desc": "..." | null} | null,
   "crop": true,
   "cost": 9,          # optional, 1|3|7|9; sets the rim facets. Default by tier.
   "region": "Fire",   # optional; default from subfolder/tier
   "edges": true}      # optional; false keeps the original frame rim (no node)
Relative "art"/"out_dir" paths resolve against the spec file's folder.
Writes <out_dir>/front-base.png and <out_dir>/back-base.png, then prints one
JSON line {"front": path, "back": path}. On failure: exit 1, {"error": ...} on stderr.
"""
from __future__ import annotations

import argparse
import contextlib
from concurrent.futures import ThreadPoolExecutor
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True  # keep the old repo's scripts/__pycache__ untouched

BACKEND = Path(str(Path.home()) + "/Documents/Programming/ArcSpirits/products/game-data-backend")
SCRIPTS = BACKEND / "scripts"
CACHE_ROOT = SCRIPTS / "_frame_cache"
EDGES_JS = BACKEND / "src/lib/generators/spirits/regionalHexEdges.js"
sys.path.insert(0, str(SCRIPTS))

import numpy as np  # noqa: E402
from psd_tools.composite.utils import clip, divide, union  # noqa: E402
from PIL import Image, ImageFilter  # noqa: E402

import export_hex_prints  # noqa: E402
from export_hex_icons_and_backs import (  # noqa: E402
    hex_mask_from,
    load_fallback_styles,
    overlay_name_for,
    paint_back_text,
    paste_static,
    resolve_overlays,
)
from bake_back_overlays import load_back_cache  # noqa: E402
from export_hex_prints import (  # noqa: E402
    HEX_EDGE_BLUR_RADIUS,
    HEX_OUTER_FEATHER,
    TIER_SUBGROUPS,
    clip_to_hex,
    draw_name,
)
from export_reworked_hex_gallery import fit_for_hex  # noqa: E402
from hex_frame_cache import OverlayCompositor, cache_dirname, load_origin_cache, place_overlay  # noqa: E402
from hex_icon_overlay import (  # noqa: E402
    BACK_SPECIAL_CLASS_DRAW_SIZE,
    load_json,
    solidify_non_transparent,
    special_class_icon_print_box,
)

# Same as render_migration_spirits.py: long names may shrink to fit the plate.
export_hex_prints.MIN_NAME_PT = 45

# Hex box on the 3000 print canvas = the live base crop (2784 x 2414).
HEX_BOX = (110, 298, 2894, 2712)
# Fallback for the special-class icon square: authored slot (552, 1439) + hex inset.
FALLBACK_ICON_BOX = [662.0, 1737.0, 662.0 + BACK_SPECIAL_CLASS_DRAW_SIZE, 1737.0 + BACK_SPECIAL_CLASS_DRAW_SIZE]
AWAKEN_TYPES = {None: "none", "none": "none", "text": "text", "rune_cost": "rune_cost"}
REGIONS = ("Forest", "Mountain", "Fire", "Water", "Sun", "Moon", "Heroes")  # regionalHexFrame.FRAME_REGIONS
# Region/cost of the 48 live spirits per frame (spirit-regional-edges-v2 manifest).
SUBFOLDER_REGION = {"forest": "Forest", "florest": "Forest", "cyber": "Mountain", "lantern": "Fire",
                    "tidal": "Water", "astral": "Sun", "void": "Moon"}
TIER_REGION = {"human_enclave": "Heroes", "royal_family": "Sun"}
TIER_COST = {"spirit_world": 3, "human_enclave": 1, "fairy": 7, "abyss": 7, "royal_family": 7, "arcane": 9}
AMBIGUOUS_COST_TIERS = {"abyss", "royal_family"}  # live spirits here are cost 7 or 9
SPEC_KEYS = {"name", "tier", "subfolder", "art", "out_dir", "back", "crop", "cost", "region", "edges", "transform"}
# The hex (3000-space) the art must cover: box (110, 298)-(2894, 2712), center (1502, 1505).
HEX_W, HEX_H, HEX_CX, HEX_CY = 2784, 2414, 1502.0, 1505.0
BACK_KEYS = {"awaken_type", "awaken_text", "class_name", "class_desc"}

# Runs the repo's restyleHexEdges on raw RGBA from stdin; writes the result to stdout.
EDGES_RUNNER = r"""
import { pathToFileURL } from 'node:url';
const [mod, w, h, region, cost] = process.argv.slice(1);
const { restyleHexEdges } = await import(pathToFileURL(mod).href);
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const buf = Buffer.concat(chunks);
const changed = restyleHexEdges(buf, Number(w), Number(h), region, Number(cost));
process.stderr.write(`rim pixels restyled: ${changed}\n`);
process.stdout.write(buf);
"""


THREADS = max(1, int(os.environ.get("HEX_RENDER_THREADS") or min(4, os.cpu_count() or 1)))  # more than 4 gives no gain
STRIP_ROWS = 96  # rows per work unit: the float temporaries stay in the CPU cache


def _unit(arr, scale):
    out = arr.astype(np.float32)
    return out / 255.0 if scale else out


def _placed_small(png: Image.Image) -> Image.Image:
    """place_overlay's paste (the layer through its own alpha onto transparent), at the layer's own size."""
    im = png.convert("RGBA")
    canvas = Image.new("RGBA", im.size, (0, 0, 0, 0))
    canvas.paste(im, (0, 0), im)
    return canvas


def composite_overlays(art_canvas: Image.Image, overlays, canvas_size, missing_out=None):
    """hex_frame_cache.composite_overlays with the same math (the repo's OverlayCompositor), but done in
    row strips on threads. Each pixel is independent, so the result is byte-identical; the peak memory
    is the 8-bit layers plus small per-strip floats, not full-canvas float arrays."""
    W, H = int(canvas_size[0]), int(canvas_size[1])
    art = art_canvas.convert("RGBA")
    if art.size != (W, H):
        canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        canvas.paste(art, (0, 0), art)
        art = canvas
    layers = []  # (uint8 array, x, y, rgb is 0-255, alpha is 0-255, fill, opacity, clipping, blend_fn)
    for ov in [None, *overlays]:
        x = y = 0
        if ov is None:
            arr, rec = np.asarray(art), {}
        else:
            rec = ov["rec"]
            im, bbox = ov["image"], [int(v) for v in (rec.get("bbox") or (0, 0, W, H))]
            if im is not None and im.size != (W, H) and bbox[0] >= 0 and bbox[1] >= 0 and bbox[0] + im.width <= W and bbox[1] + im.height <= H:
                # Same pixels as place_overlay on the full canvas, but kept at the layer's own size.
                x, y = bbox[0], bbox[1]
                arr = np.asarray(_placed_small(im))
            else:
                arr = np.asarray(place_overlay(im, bbox, (W, H)))
            if missing_out is not None and not ov.get("blend_ok"):
                key = ov.get("blend_key")
                if key not in missing_out:
                    missing_out.append(key)
        # The repo decides "is this 0-255?" on the whole layer (max > 1.5); keep that decision per layer.
        layers.append((arr, x, y, int(arr[:, :, :3].max()) > 1, int(arr[:, :, 3].max()) > 1,
                       float(rec.get("fill_opacity", 255) or 255) / 255.0, float(rec.get("opacity", 255) or 255) / 255.0,
                       bool(rec.get("clipping")), ov and ov["blend_fn"]))
    out = np.empty((H, W, 4), dtype=np.uint8)

    def rows(arr, x, y, y0, y1):
        """Rows y0..y1 of a layer at full canvas width, or None when the layer does not touch them."""
        a, b = max(y0, y), min(y1, y + arr.shape[0])
        if a >= b or not arr[a - y:b - y, :, 3].any():
            return None
        if arr.shape[1] == W and a == y0 and b == y1:
            return arr[a - y:b - y]
        full = np.zeros((y1 - y0, W, 4), dtype=np.uint8)
        full[a - y0:b - y0, x:x + arr.shape[1]] = arr[a - y:b - y]
        return full

    def strip(y0):
        y1 = min(H, y0 + STRIP_ROWS)
        arr, _, _, rgb255, a255 = layers[0][:5]
        alpha = _unit(arr[y0:y1, :, 3:4], a255)
        comp = OverlayCompositor(_unit(arr[y0:y1, :, :3], rgb255), alpha)
        last_base_shape = alpha.copy()
        for arr, x, y, rgb255, a255, fill, opac, clipping, blend_fn in layers[1:]:
            src = rows(arr, x, y, y0, y1)
            if src is None:
                # The layer does not touch this strip: shape = alpha = 0. The repo formula then reduces to
                # this (the blend term is multiplied by 0), so the blend function is not needed.
                comp.color = clip(divide(comp.alpha * comp.color, union(comp.alpha_0, comp.alpha_g)))
                comp.alpha = union(comp.alpha_0, comp.alpha_g)
                if not clipping:
                    last_base_shape = np.zeros_like(last_base_shape)
                continue
            src_shape = _unit(src[:, :, 3:4], a255)
            shape = src_shape * fill
            src_alpha = src_shape * opac * fill
            if clipping:
                shape = shape * last_base_shape
                src_alpha = src_alpha * last_base_shape
            comp.apply(_unit(src[:, :, :3], rgb255), shape, src_alpha, blend_fn)
            if not clipping:
                last_base_shape = shape
        out[y0:y1, :, :3] = np.clip(np.round(comp.color * 255.0), 0, 255)
        out[y0:y1, :, 3:4] = np.clip(np.round(comp.alpha * 255.0), 0, 255)

    with ThreadPoolExecutor(THREADS) as pool:
        list(pool.map(strip, range(0, H, STRIP_ROWS)))
    return Image.fromarray(out, "RGBA")


def _mix_where(src_img: Image.Image, dst_img: Image.Image, rim, keep_alpha=False) -> Image.Image:
    """src * (1 - rim) + dst * rim, as the repo does it on the full canvas, but only on the pixels where
    rim > 0. Where rim is 0 the repo formula returns src exactly, so the result is byte-identical."""
    if float(rim.max()) < 1e-6:
        return src_img
    src = np.asarray(src_img)
    ys, xs = np.nonzero(rim)
    r = rim[ys, xs][:, None]
    s = src[ys, xs].astype(np.float32)
    o = s * (1.0 - r) + np.asarray(dst_img)[ys, xs].astype(np.float32) * r
    if keep_alpha:
        o[:, 3] = s[:, 3]
    out = src.copy()
    out[ys, xs] = np.clip(np.round(o), 0, 255).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def _unit2d(img: Image.Image):
    return np.asarray(img).astype(np.float32) / 255.0


def apply_hex_rim_blur(art, hex_mask, art_box, radius=HEX_EDGE_BLUR_RADIUS):
    """export_hex_prints.apply_hex_rim_blur (same result, rim pixels only)."""
    if art is None or hex_mask is None or radius <= 0:
        return art
    art = art.convert("RGBA")
    local = hex_mask.crop(tuple(int(v) for v in art_box))
    if local.size != art.size:
        local = local.resize(art.size, Image.Resampling.BILINEAR)
    soft = local.filter(ImageFilter.GaussianBlur(radius=float(radius)))
    rim = np.clip(np.abs(_unit2d(soft) - _unit2d(local)) * 3.5, 0.0, 1.0)
    if float(rim.max()) < 1e-6:
        return art
    return _mix_where(art, art.filter(ImageFilter.GaussianBlur(radius=float(radius))), rim)


def art_through_hex(fitted, hex_mask, art_box, canvas_size):
    """export_hex_prints.art_through_hex (same result; only the alpha channel goes through float)."""
    canvas = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    if fitted is None:
        return canvas
    canvas.paste(fitted, (int(art_box[0]), int(art_box[1])), fitted)
    if hex_mask is None:
        return canvas
    a = np.asarray(canvas.getchannel("A")).astype(np.float32)
    a *= _unit2d(hex_mask.resize(canvas_size, Image.Resampling.BILINEAR))
    canvas.putalpha(Image.fromarray(np.clip(np.round(a), 0, 255).astype(np.uint8), "L"))
    return canvas


def restore_art_outside_frame(composite, art_canvas, art_mask, frame_mask):
    """export_hex_prints.restore_art_outside_frame (same result, band pixels only)."""
    if composite is None or art_canvas is None or art_mask is None or frame_mask is None:
        return composite
    w = np.clip(_unit2d(art_mask) * (1.0 - _unit2d(frame_mask)), 0.0, 1.0)
    return _mix_where(composite.convert("RGBA"), art_canvas.convert("RGBA"), w)


def soften_hex_outer_edge(img, radius=HEX_OUTER_FEATHER):
    """export_hex_prints.soften_hex_outer_edge (same result, rim pixels only)."""
    if img is None or radius <= 0:
        return img
    rgba = img.convert("RGBA")
    alpha = rgba.getchannel("A")
    soft_a = alpha.filter(ImageFilter.GaussianBlur(radius=float(radius)))
    rim = np.clip(np.abs(_unit2d(soft_a) - _unit2d(alpha)) * 3.5, 0.0, 1.0)
    if float(rim.max()) < 1e-6:
        return img
    return _mix_where(rgba, rgba.filter(ImageFilter.GaussianBlur(radius=float(radius))), rim, keep_alpha=True)


class SpecError(ValueError):
    pass


def log(msg):
    print(f"hex_render: {msg}", file=sys.stderr, flush=True)


def _text(value, field):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise SpecError(f"{field} must be a string or null")
    return value.strip()


def parse_spec(spec: dict, base_dir: Path) -> dict:
    if not isinstance(spec, dict):
        raise SpecError("spec must be a JSON object")
    unknown = set(spec) - SPEC_KEYS
    if unknown:
        log(f"ignoring unknown spec keys {sorted(unknown)}")

    name = _text(spec.get("name"), "name")
    if not name:
        raise SpecError("name is required")

    tier = _text(spec.get("tier"), "tier")
    if tier not in TIER_SUBGROUPS:
        raise SpecError(f"tier {tier!r} is not one of {sorted(TIER_SUBGROUPS)}")
    subfolder = _text(spec.get("subfolder"), "subfolder") or None
    subs = TIER_SUBGROUPS[tier]
    if subs and subfolder not in subs:
        raise SpecError(f"subfolder {subfolder!r} is not valid for tier {tier}; use one of {subs}")
    frame_key = cache_dirname(tier, subfolder, TIER_SUBGROUPS)
    if not (CACHE_ROOT / frame_key / "manifest.json").exists():
        have = sorted(p.parent.name for p in CACHE_ROOT.glob("*__*/manifest.json"))
        raise SpecError(f"no baked frame for {frame_key}; available: {have}")

    art = _text(spec.get("art"), "art")
    if not art:
        raise SpecError("art is required")
    art_path = (base_dir / art).resolve()
    if not art_path.is_file():
        raise SpecError(f"art file not found: {art_path}")

    out_dir = _text(spec.get("out_dir"), "out_dir")
    if not out_dir:
        raise SpecError("out_dir is required")

    back = spec.get("back")
    if back is None:
        back = {}
    if not isinstance(back, dict):
        raise SpecError("back must be an object or null")
    unknown = set(back) - BACK_KEYS
    if unknown:
        log(f"ignoring unknown back keys {sorted(unknown)}")
    awaken_raw = back.get("awaken_type")
    if awaken_raw not in AWAKEN_TYPES:
        raise SpecError(f"back.awaken_type {awaken_raw!r} must be 'rune_cost', 'text' or null")
    awaken = AWAKEN_TYPES[awaken_raw]
    awaken_text = _text(back.get("awaken_text"), "back.awaken_text")
    if awaken == "text" and not awaken_text:
        raise SpecError("back.awaken_type 'text' needs back.awaken_text")
    if awaken != "text" and awaken_text:
        log(f"awaken_type {awaken_raw!r}: awaken_text is not drawn (rune icons are placed later)")
    class_name = _text(back.get("class_name"), "back.class_name")
    class_desc = _text(back.get("class_desc"), "back.class_desc")
    if class_desc and not class_name:
        raise SpecError("back.class_desc needs back.class_name")

    crop = spec.get("crop", False)
    if not isinstance(crop, bool):
        raise SpecError("crop must be true or false")

    edges = spec.get("edges", True)
    # Art placement (Michael, 2026-11-09): cover the whole hex by aspect ratio, centered; then the editor's
    # transform: scale (1 = cover), x/y offset in 3000-space px, optional flip.
    t = spec.get("transform") or {}
    transform = {"scale": max(0.05, float(t.get("scale", 1) or 1)), "x": float(t.get("x", 0) or 0), "y": float(t.get("y", 0) or 0), "flip": bool(t.get("flip", False))}
    if not isinstance(edges, bool):
        raise SpecError("edges must be true or false")
    region = _text(spec.get("region"), "region")
    if region:
        match = [r for r in REGIONS if r.lower() == region.lower()]
        if not match:
            raise SpecError(f"region {region!r} is not one of {list(REGIONS)}")
        region = match[0]
    else:
        region = TIER_REGION.get(tier) or SUBFOLDER_REGION.get(subfolder or "")
    cost = spec.get("cost")
    if cost is None:
        cost = TIER_COST[tier]
        if edges and tier in AMBIGUOUS_COST_TIERS:
            log(f"no cost given; rim uses cost {cost} (tier {tier} has cost 7 and 9 spirits)")
    elif isinstance(cost, bool) or cost not in (1, 3, 7, 9):
        raise SpecError("cost must be 1, 3, 7 or 9")
    if edges:
        if not region:
            raise SpecError(f"cannot derive region for {tier}/{subfolder}; set region")
        if (region == "Heroes") != (cost == 1):
            raise SpecError(f"rim {region}/{cost} does not exist: Heroes is cost 1 only, other regions 3/7/9")

    return {
        "name": name,
        "tier": tier,
        "subfolder": subfolder,
        "art": art_path,
        "out_dir": (base_dir / out_dir).resolve(),
        "crop": crop,
        "edges": edges,
        "transform": transform,
        "region": region,
        "cost": cost,
        # Same field names as the hex_spirits_art_raw.csv rows the repo functions read.
        "row": {
            "Name": name,
            "Tier": tier,
            "OriginSubfolder": subfolder or "",
            "AwakenType": awaken,
            "AwakenText": awaken_text if awaken == "text" else "",
            "SpecialClassName": class_name,
            "SpecialClassDesc": class_desc,
        },
    }


def load_front_cache(tier, subfolder):
    cached = load_origin_cache(CACHE_ROOT, tier, subfolder, TIER_SUBGROUPS)
    # Same overlay filter as render_migration_spirits.py.
    cached["overlays"] = [
        ov for ov in cached["overlays"]
        if ov["rec"].get("name") != "IMG_5368" and " / art / " not in ov["rec"].get("path", "")
    ]
    return cached


def place_art(img: Image.Image, art_box, transform: dict) -> Image.Image:
    """The art scaled to cover the hex (by aspect ratio), centered on the hex, then the editor's scale/offset.
    Returns an RGBA canvas of the art_box size (transparent where the art does not reach)."""
    w, h = int(art_box[2] - art_box[0]), int(art_box[3] - art_box[1])
    src = img.convert("RGBA")
    if transform.get("flip"):
        src = src.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    k = max(HEX_W / src.width, HEX_H / src.height) * float(transform.get("scale", 1))
    sw, sh = max(1, round(src.width * k)), max(1, round(src.height * k))
    src = src.resize((sw, sh), Image.Resampling.LANCZOS)
    cx, cy = HEX_CX - art_box[0] + float(transform.get("x", 0)), HEX_CY - art_box[1] + float(transform.get("y", 0))
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas.paste(src, (round(cx - sw / 2), round(cy - sh / 2)), src)
    return canvas


def render_front(art_path: Path, name: str, cached: dict, transform: dict | None = None) -> Image.Image:
    """export_hex_prints._export_one_from_cache, minus its CSV/pack/report glue."""
    canvas_size = tuple(cached["canvas"])
    fitted = place_art(Image.open(art_path), cached["art_box"], transform or {})
    fitted = apply_hex_rim_blur(fitted, cached.get("hex_mask"), cached["art_box"])
    art_canvas = art_through_hex(fitted, cached.get("hex_mask"), cached["art_box"], canvas_size)
    missing = list(cached.get("missing_blend_modes") or [])
    img = composite_overlays(art_canvas, cached["overlays"], canvas_size, missing_out=missing)
    if missing:
        log(f"blend modes replayed as normal: {missing}")
    img = restore_art_outside_frame(img, art_canvas, cached.get("hex_mask"), cached.get("frame_mask"))
    hex_alpha = img.split()[-1]
    img = soften_hex_outer_edge(img)
    img = clip_to_hex(img, cached.get("hex_mask") or cached.get("frame_mask") or hex_alpha)
    img = clip_to_hex(img, hex_alpha)
    draw_name(img, cached["name_style"], name.strip().upper())  # paints in place (img is RGBA)
    return img


def render_back(front: Image.Image, row: dict) -> Image.Image:
    """export_hex_icons_and_backs.export_one_back with the icon stamp left out.

    The original computes the CLASS_DESC exclusion only when it stamps icons;
    here it is always computed, so the 385px icon square stays empty for the
    later icon step.
    """
    overlay = overlay_name_for(row.get("OriginSubfolder") or "")
    cached = load_back_cache(CACHE_ROOT, overlay)
    awaken = row["AwakenType"]
    special = bool(row["SpecialClassName"])
    sections = {"base"}
    if awaken != "none":
        sections.add("awaken")
    if special:
        sections.add("special_class")
    overlays = resolve_overlays(cached, sections)
    canvas_size = cached.get("canvas") or front.size
    img = composite_overlays(front.convert("RGBA"), overlays, canvas_size)
    img = paste_static(img, cached, awaken)
    exclude = None
    if special:
        back_config = load_json(CACHE_ROOT / "icon_placement_back.json")
        exclude = special_class_icon_print_box(img, back_config) or list(FALLBACK_ICON_BOX)
        log(f"back overlay {overlay}; reserved class icon box {[round(v) for v in exclude]} (3000-space)")
    img = paint_back_text(img, cached, overlay, row, load_fallback_styles(), class_desc_exclude=exclude)
    img = clip_to_hex(img, hex_mask_from(front, CACHE_ROOT))
    img = clip_to_hex(img, front.convert("RGBA").split()[-1])
    return img


def find_node() -> str:
    node = os.environ.get("HEX_RENDER_NODE") or shutil.which("node")
    if not node:
        nvm = sorted(Path.home().glob(".nvm/versions/node/*/bin/node"))
        node = str(nvm[-1]) if nvm else None
    if not node:
        raise RuntimeError("node not found (needed for the regional rim); set HEX_RENDER_NODE or edges=false")
    return node


def restyle_edges(img: Image.Image, region: str, cost: int) -> Image.Image:
    """finalize_migration_assets.mjs: regionalHexEdges.restyleHexEdges on the 3000 canvas."""
    img = img.convert("RGBA")
    proc = subprocess.run(
        [find_node(), "--input-type=module", "-e", EDGES_RUNNER,
         str(EDGES_JS), str(img.width), str(img.height), region, str(cost)],
        input=img.tobytes(), capture_output=True, cwd=str(BACKEND),
    )
    if proc.returncode != 0:
        raise RuntimeError(f"restyleHexEdges failed: {proc.stderr.decode(errors='replace').strip()}")
    out = Image.frombytes("RGBA", img.size, proc.stdout)
    if out.getchannel("A").tobytes() != img.getchannel("A").tobytes():
        raise RuntimeError("restyleHexEdges changed alpha")
    return out


def run(job: dict) -> dict:
    cached = load_front_cache(job["tier"], job["subfolder"])
    front = render_front(job["art"], job["name"], cached, job["transform"])
    with ThreadPoolExecutor(2) as pool:
        # The back is built from the front before its rim restyle, as live. The front's rim restyle (node)
        # runs at the same time as the back render; the two PNG saves also run together.
        restyled = None
        if job["edges"]:
            log(f"regional rim {job['region']} / cost {job['cost']}")
            restyled = pool.submit(restyle_edges, front, job["region"], job["cost"])
        back = render_back(front, job["row"])
        if restyled:
            back = restyle_edges(back, job["region"], job["cost"])
            front = restyled.result()
        # fix_game_texture_bounds.py: both bases take the front's alpha after the icon
        # step solidified it (any alpha > 0 -> 255).
        alpha = solidify_non_transparent(front).getchannel("A")
        front.putalpha(alpha)
        back.putalpha(alpha)
        if job["crop"]:
            front = front.crop(HEX_BOX)
            back = back.crop(HEX_BOX)
        out_dir = job["out_dir"]
        out_dir.mkdir(parents=True, exist_ok=True)
        front_path = out_dir / "front-base.png"
        back_path = out_dir / "back-base.png"
        saves = [pool.submit(front.save, front_path), pool.submit(back.save, back_path)]
        for f in saves:
            f.result()
    return {"front": str(front_path), "back": str(back_path)}


def frame_preview(tier: str, subfolder, region: str, cost: int, edges: bool, out: Path) -> dict:
    """The frame with NO art (transparent inside), cropped to the hex, for the interactive editor's preview."""
    cached = load_front_cache(tier, subfolder)
    canvas_size = tuple(cached["canvas"])
    art_canvas = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    img = composite_overlays(art_canvas, cached["overlays"], canvas_size, missing_out=[])
    img = clip_to_hex(img, cached.get("hex_mask") or cached.get("frame_mask") or img.split()[-1])
    if edges:
        img = restyle_edges(img, region, cost)
    img = img.crop(HEX_BOX)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    mask = (cached.get("hex_mask") or cached.get("frame_mask")).resize(canvas_size, Image.Resampling.BILINEAR).crop(HEX_BOX)
    mask.save(out.with_name(out.stem + "-mask.png"))
    return {"frame": str(out), "mask": str(out.with_name(out.stem + "-mask.png"))}


def main() -> int:
    ap = argparse.ArgumentParser(description="Render front-base.png and back-base.png of one hex spirit.")
    ap.add_argument("--spec", help="spec JSON file, or - for stdin")
    ap.add_argument("--frame-preview", nargs=5, metavar=("TIER", "SUBFOLDER", "REGION", "COST", "OUT"), help="write the frame alone (no art) for the editor")
    args = ap.parse_args()
    if args.frame_preview:
        tier, sub, region, cost, out = args.frame_preview
        try:
            with contextlib.redirect_stdout(sys.stderr):
                result = frame_preview(tier, None if sub in ("", "null", "standalone") else sub, region, int(cost), True, Path(out))
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}), file=sys.stderr, flush=True)
            return 1
        print(json.dumps(result), flush=True)
        return 0
    if not args.spec:
        ap.error("--spec or --frame-preview is required")
    try:
        if args.spec == "-":
            spec, base_dir = json.load(sys.stdin), Path.cwd()
        else:
            spec_path = Path(args.spec).resolve()
            spec, base_dir = json.loads(spec_path.read_text()), spec_path.parent
        job = parse_spec(spec, base_dir)
        # Repo helpers print progress; keep stdout for the one result line.
        with contextlib.redirect_stdout(sys.stderr):
            result = run(job)
    except Exception as exc:  # noqa: BLE001 - report every failure as one JSON line
        kind = "" if isinstance(exc, SpecError) else f"{type(exc).__name__}: "
        print(json.dumps({"error": f"{kind}{exc}"}), file=sys.stderr, flush=True)
        return 1
    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

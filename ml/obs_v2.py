"""
arc-obs-v2 flat-observation parser.

The TS encoder (src/lib/play/ml/encodeV2.ts, docs/encoder-v2.md) flattens an
entity-level observation to one constant-length float array:

    [header 2+3*T] [payload: per-family rows concatenated] [masks: per family]

Header: [versionCode=2, numTokenTypes=T, then (typeId, cap, dim) x T] with the
families in payload order. Family names by typeId:
0=global 1=seat 2=spirit 3=market 4=rune 5=monster. Mask order matches payload
order but only for families that carry a mask (global has none; caps==1
families like monster still carry a 1-wide mask).

Everything here is driven by the header / obsV2Meta — no hard-coded offsets.
The layout for the frozen catalog is 3419 floats, but the parser only trusts
what the header says.

Usage:
    spec = ObsV2Spec.from_meta(json.load(open("meta.json")))   # or .from_flat(row)
    tokens, masks = spec.unflatten(flat)   # flat: (D,) or (B, D), numpy or torch
    tokens["seat"]  -> (B, 6, 55) float tensor;  masks["seat"] -> (B, 6) float
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Union

import numpy as np
import torch

OBS_V2_VERSION_CODE = 2

# typeId -> family name, fixed by the encoder contract (OBS_V2_TOKEN_TYPES).
TOKEN_TYPE_NAMES = ("global", "seat", "spirit", "market", "rune", "monster")

# Families that carry a trailing mask block, in payload order. `global` is the
# only mask-less family: it is always exactly one real token.
MASKED_FAMILIES = ("seat", "spirit", "market", "rune", "monster")

ArrayLike = Union[np.ndarray, torch.Tensor, list]


@dataclass(frozen=True)
class FamilySpec:
    name: str
    type_id: int
    cap: int
    dim: int


@dataclass(frozen=True)
class ObsV2Spec:
    version_code: int
    families: tuple[FamilySpec, ...]

    @property
    def header_len(self) -> int:
        return 2 + 3 * len(self.families)

    @property
    def payload_len(self) -> int:
        return sum(f.cap * f.dim for f in self.families)

    @property
    def mask_len(self) -> int:
        return sum(f.cap for f in self.families if f.name in MASKED_FAMILIES)

    @property
    def flat_length(self) -> int:
        return self.header_len + self.payload_len + self.mask_len

    @property
    def header(self) -> list[int]:
        out = [self.version_code, len(self.families)]
        for f in self.families:
            out.extend((f.type_id, f.cap, f.dim))
        return out

    def family(self, name: str) -> FamilySpec:
        for f in self.families:
            if f.name == name:
                return f
        raise KeyError(name)

    # ── constructors ────────────────────────────────────────────────────────

    @classmethod
    def from_header(cls, header: ArrayLike) -> "ObsV2Spec":
        h = [int(round(float(x))) for x in list(header)]
        if len(h) < 2:
            raise ValueError("obs-v2 header too short")
        version_code, n = h[0], h[1]
        if version_code != OBS_V2_VERSION_CODE:
            raise ValueError(f"obs-v2 version mismatch: got {version_code}, want {OBS_V2_VERSION_CODE}")
        if len(h) < 2 + 3 * n:
            raise ValueError(f"obs-v2 header truncated: {len(h)} floats for {n} families")
        fams = []
        for i in range(n):
            type_id, cap, dim = h[2 + 3 * i : 5 + 3 * i]
            if not (0 <= type_id < len(TOKEN_TYPE_NAMES)):
                raise ValueError(f"obs-v2 header: unknown typeId {type_id}")
            fams.append(FamilySpec(TOKEN_TYPE_NAMES[type_id], type_id, cap, dim))
        if [f.name for f in fams] != list(TOKEN_TYPE_NAMES[:n]):
            raise ValueError(f"obs-v2 header: families out of payload order: {[f.name for f in fams]}")
        return cls(version_code=version_code, families=tuple(fams))

    @classmethod
    def from_flat(cls, flat: ArrayLike) -> "ObsV2Spec":
        """Build a spec from the self-describing header of a flat row (or batch)."""
        arr = flat
        if isinstance(arr, list):
            arr = np.asarray(arr)
        row = arr[0] if arr.ndim == 2 else arr
        n = int(round(float(row[1])))
        spec = cls.from_header(row[: 2 + 3 * n])
        if row.shape[-1] != spec.flat_length:
            raise ValueError(f"obs-v2 row length {row.shape[-1]} != header-implied {spec.flat_length}")
        return spec

    @classmethod
    def from_meta(cls, meta: dict) -> "ObsV2Spec":
        """Build from obsV2Meta() JSON (the meta.json written next to datasets)."""
        spec = cls.from_header(meta["flatHeader"])
        if int(meta["versionCode"]) != spec.version_code:
            raise ValueError("meta.versionCode disagrees with meta.flatHeader")
        if int(meta["flatLength"]) != spec.flat_length:
            raise ValueError(f"meta.flatLength {meta['flatLength']} != header-implied {spec.flat_length}")
        dims = meta["dims"]
        caps = meta["caps"]
        for f in spec.families:
            if int(dims[f.name]) != f.dim:
                raise ValueError(f"meta.dims.{f.name}={dims[f.name]} != header dim {f.dim}")
            # caps uses plural keys for the padded families; global/monster are cap 1.
            cap_key = {"seat": "seats", "spirit": "spirits", "market": "market", "rune": "runes"}.get(f.name)
            if cap_key is not None and int(caps[cap_key]) != f.cap:
                raise ValueError(f"meta.caps.{cap_key}={caps[cap_key]} != header cap {f.cap}")
        return spec

    # ── parsing ─────────────────────────────────────────────────────────────

    def unflatten(
        self,
        flat: ArrayLike,
        validate_header: bool = True,
        dtype: torch.dtype = torch.float32,
    ) -> tuple[dict[str, torch.Tensor], dict[str, torch.Tensor]]:
        """
        Split flat rows into per-family token tensors and pad masks.

        flat: (D,) or (B, D), numpy / torch / list. Returns
        (tokens, masks) where tokens[name] is (B, cap, dim) and masks[name] is
        (B, cap) with 1=real, 0=pad. `global` gets an implicit all-ones mask.
        """
        x = flat
        if isinstance(x, list):
            x = np.asarray(x, dtype=np.float32)
        if isinstance(x, np.ndarray):
            x = torch.from_numpy(np.ascontiguousarray(x, dtype=np.float32))
        x = x.to(dtype)
        if x.dim() == 1:
            x = x.unsqueeze(0)
        if x.dim() != 2:
            raise ValueError(f"expected (D,) or (B, D), got shape {tuple(x.shape)}")
        if x.shape[1] != self.flat_length:
            raise ValueError(f"flat length {x.shape[1]} != spec length {self.flat_length}")

        if validate_header:
            expect = torch.tensor(self.header, dtype=dtype, device=x.device)
            if not torch.all(x[:, : self.header_len] == expect):
                bad = int((x[:, : self.header_len] != expect).any(dim=1).nonzero()[0, 0])
                raise ValueError(f"row {bad}: embedded flat header does not match spec {self.header}")

        tokens: dict[str, torch.Tensor] = {}
        masks: dict[str, torch.Tensor] = {}
        off = self.header_len
        for f in self.families:
            tokens[f.name] = x[:, off : off + f.cap * f.dim].reshape(-1, f.cap, f.dim)
            off += f.cap * f.dim
        for f in self.families:
            if f.name in MASKED_FAMILIES:
                masks[f.name] = x[:, off : off + f.cap]
                off += f.cap
        assert off == self.flat_length
        masks["global"] = torch.ones(x.shape[0], self.family("global").cap, dtype=dtype, device=x.device)
        return tokens, masks

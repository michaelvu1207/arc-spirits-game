"""Shared numerical primitives for the frozen V35 P30 statistical design."""

from __future__ import annotations

import numpy as np


def conservative_sign_flip_tolerance(
    replicate_points: np.ndarray, *, axis: int = -1
) -> np.ndarray | float:
    """Bound summation/dot-product noise without dropping mathematical ties."""
    values = np.asarray(replicate_points, dtype=np.float64)
    if values.ndim == 0 or values.shape[axis] < 1 or not np.isfinite(values).all():
        raise ValueError("sign-flip points must be a finite non-empty array")
    operation_count = values.shape[axis]
    scale = np.maximum(1.0, np.mean(np.abs(values), axis=axis))
    tolerance = (
        np.finfo(np.float64).eps * scale * (8 * operation_count + 16)
    )
    return float(tolerance) if np.ndim(tolerance) == 0 else tolerance

"""
Flow-guided temporal stabilization for per-frame style transfer.

Per-frame stylization (TransformerNet or AdaIN) treats every frame independently, so small
input changes produce large texture changes between frames: flicker. ReCoNet avoids this by
training with a temporal loss; this module enforces the same constraint at inference time,
with no retraining (in the spirit of Ruder et al. 2016's flow-based initialisation):

    O_t = M_t ⊙ (λ · W(O_{t-1}) + (1 − λ) · S_t)  +  (1 − M_t) ⊙ S_t

  S_t        per-frame stylized frame t
  W(O_{t-1}) previous *output* warped into frame t with backward optical flow (t → t−1)
  M_t        reliability mask: forward–backward flow consistency, in-bounds, softened
  λ          temporal blend (0 = per-frame, → 1 = maximally smooth)

Occluded / newly revealed pixels (M_t = 0) take the fresh stylization, so moving objects
don't leave trails. Flow is computed on the *content* frames (where motion is real), at
reduced resolution for speed, then scaled up.

Detail preservation (``detail_sigma``): blending whole frames recursively also low-pass filters
them (every warp resamples), which washes out brush texture: in our measurements sharpness
halved and the style distance doubled. By default only the low frequencies are blended over time
and the current frame's high-frequency detail (σ = detail_sigma) is added back:

    O_t = G_σ * [M_t ⊙ (λ W(O_{t-1}) + (1−λ) S_t) + (1−M_t) ⊙ S_t]  +  (S_t − G_σ * S_t)

This stabilises colour / shape flicker while keeping the texture sharp; the remaining flicker is
texture-level and needs temporal *training* (ReCoNet) to remove. ``detail_sigma=0`` gives plain
full-frame blending (smoothest, but blurrier).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import cv2
import numpy as np


def _farneback(a_gray: np.ndarray, b_gray: np.ndarray) -> np.ndarray:
    return cv2.calcOpticalFlowFarneback(
        a_gray, b_gray, None, pyr_scale=0.5, levels=4, winsize=21, iterations=3, poly_n=7, poly_sigma=1.5, flags=0
    )


def _remap(img: np.ndarray, flow: np.ndarray, border=cv2.BORDER_REPLICATE) -> np.ndarray:
    h, w = flow.shape[:2]
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    return cv2.remap(img, gx + flow[..., 0], gy + flow[..., 1], cv2.INTER_LINEAR, borderMode=border)


@dataclass
class TemporalStabilizer:
    """Stateful: feed frames in order with `step(content, stylized)`. Call `reset()` between clips."""

    blend: float = 0.7
    detail_sigma: float = 1.0
    flow_scale: float = 0.5
    consistency_px: float = 1.5
    mask_blur: int = 7
    _prev_gray: Optional[np.ndarray] = field(default=None, init=False, repr=False)
    _prev_out: Optional[np.ndarray] = field(default=None, init=False, repr=False)
    last_mask_mean: float = field(default=0.0, init=False)

    def reset(self) -> None:
        self._prev_gray = None
        self._prev_out = None

    def _flows(self, gray: np.ndarray):
        """Backward (t→t−1) and forward (t−1→t) flow at full resolution."""
        h, w = gray.shape
        s = self.flow_scale
        if s < 1.0:
            small = (max(8, int(w * s)), max(8, int(h * s)))
            a = cv2.resize(gray, small, interpolation=cv2.INTER_AREA)
            b = cv2.resize(self._prev_gray, small, interpolation=cv2.INTER_AREA)
        else:
            a, b = gray, self._prev_gray
        back = _farneback(a, b)
        fwd = _farneback(b, a)
        if s < 1.0:
            back = cv2.resize(back, (w, h), interpolation=cv2.INTER_LINEAR) / s
            fwd = cv2.resize(fwd, (w, h), interpolation=cv2.INTER_LINEAR) / s
        return back, fwd

    def step(self, content_bgr: np.ndarray, stylized_bgr: np.ndarray) -> np.ndarray:
        if content_bgr.shape[:2] != stylized_bgr.shape[:2]:
            content_bgr = cv2.resize(content_bgr, (stylized_bgr.shape[1], stylized_bgr.shape[0]), interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(content_bgr, cv2.COLOR_BGR2GRAY)

        if self._prev_gray is None or self._prev_gray.shape != gray.shape or self.blend <= 0:
            self._prev_gray, self._prev_out = gray, stylized_bgr.copy()
            self.last_mask_mean = 0.0
            return stylized_bgr

        back, fwd = self._flows(gray)
        h, w = gray.shape
        gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
        mx, my = gx + back[..., 0], gy + back[..., 1]

        # Forward–backward consistency: following back then forward should return to the start.
        fwd_at = _remap(fwd, back)
        err = np.hypot(back[..., 0] + fwd_at[..., 0], back[..., 1] + fwd_at[..., 1])
        motion = np.hypot(back[..., 0], back[..., 1])
        reliable = (err < self.consistency_px + 0.05 * motion) & (mx >= 0) & (mx <= w - 1) & (my >= 0) & (my <= h - 1)
        mask = reliable.astype(np.float32)
        if self.mask_blur > 1:
            k = self.mask_blur | 1
            mask = cv2.GaussianBlur(mask, (k, k), 0) * reliable  # soften edges, keep holes hard
        self.last_mask_mean = float(mask.mean())

        warped = cv2.remap(self._prev_out, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
        cur = stylized_bgr.astype(np.float32)
        m = (self.blend * mask)[..., None]
        blended = m * warped + (1.0 - m) * cur
        if self.detail_sigma > 0:
            # temporal blend for low frequencies only; keep this frame's fine texture
            blended = cv2.GaussianBlur(blended, (0, 0), self.detail_sigma) + (
                cur - cv2.GaussianBlur(cur, (0, 0), self.detail_sigma)
            )
        out = np.clip(blended, 0, 255).astype(np.uint8)

        self._prev_gray, self._prev_out = gray, out
        return out


def stabilize_frames(contents, stylized, blend: float = 0.7, detail_sigma: float = 1.0):
    """Convenience: stabilize two aligned frame sequences (lists of BGR arrays)."""
    stab = TemporalStabilizer(blend=blend, detail_sigma=detail_sigma)
    return [stab.step(c, s) for c, s in zip(contents, stylized)]

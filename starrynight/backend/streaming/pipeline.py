"""
Per-session frame pipeline for live WebRTC streaming (GP2 feature 2).

Pure numpy in / numpy out, so it's testable without WebRTC. Everything a live session needs:

  * fixed-style TransformerNet models (cached, one per style) or AdaIN with an uploaded painting
  * style strength: AdaIN feature interpolation, or a pixel blend for TransformerNet
  * flow-guided temporal stabilization (style_transfer.temporal), reset on every style change
  * graceful degradation: inference resolution adapts to hold the target frame rate
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional

import cv2
import numpy as np
import torch

from style_transfer.reco.style_catalog import resolve_style_model
from style_transfer.temporal import TemporalStabilizer

BACKEND = Path(__file__).resolve().parents[1]
ADAIN = "adain"

_models: Dict[str, torch.nn.Module] = {}
_models_lock = threading.Lock()


def get_style_model(style_id: str) -> torch.nn.Module:
    """TransformerNet for a preset style id (e.g. 'starry-night'); loaded once per process."""
    with _models_lock:
        if style_id not in _models:
            from style_transfer.fast_style.transformer import TransformerNetwork

            path, _ = resolve_style_model(BACKEND, style_id)
            net = TransformerNetwork()
            net.load_state_dict(torch.load(path, map_location="cpu"))
            _models[style_id] = net.eval()
        return _models[style_id]


def fit_even(w: int, h: int, max_side: int, multiple: int = 4):
    scale = min(1.0, max_side / max(w, h))
    return max(multiple, int(w * scale) // multiple * multiple), max(multiple, int(h * scale) // multiple * multiple)


@dataclass
class AdaptiveResolution:
    """Hold `target_fps` by moving the inference size between `min_side` and `max_side` (EMA of frame time)."""

    target_fps: float = 15.0
    max_side: int = 384
    min_side: int = 160
    step: int = 32
    side: int = 256
    ema_ms: Optional[float] = None
    _cooldown: int = 0

    def update(self, frame_ms: float) -> int:
        self.ema_ms = frame_ms if self.ema_ms is None else 0.8 * self.ema_ms + 0.2 * frame_ms
        budget = 1000.0 / self.target_fps
        if self._cooldown > 0:
            self._cooldown -= 1
        elif self.ema_ms > budget * 1.15 and self.side > self.min_side:
            self.side = max(self.min_side, self.side - self.step)
            self._cooldown = 5
        elif self.ema_ms < budget * 0.6 and self.side < self.max_side:
            self.side = min(self.max_side, self.side + self.step)
            self._cooldown = 5
        return self.side


@dataclass
class FrameStylizer:
    style: str = "starry-night"
    alpha: float = 1.0
    temporal: bool = True
    out_width: int = 640
    res: AdaptiveResolution = field(default_factory=AdaptiveResolution)
    _adain_feat: Optional[torch.Tensor] = None
    _stab: TemporalStabilizer = field(default_factory=TemporalStabilizer)
    last_infer_ms: float = 0.0

    def set_style(self, style: str) -> None:
        if style == ADAIN and self._adain_feat is None:
            raise ValueError("Send a style image before switching to the custom (AdaIN) style.")
        if style not in ("raw", ADAIN):
            get_style_model(style)  # validates the id and warms the cache (raises on unknown styles)
        self.style = style
        self._stab.reset()

    def set_style_image(self, bgr: np.ndarray) -> None:
        from style_transfer.adain.inference import get_model

        self._adain_feat = get_model().encode_style(bgr)
        self.style = ADAIN
        self._stab.reset()

    def set_alpha(self, alpha: float) -> None:
        self.alpha = float(min(1.0, max(0.0, alpha)))

    @torch.inference_mode()
    def _stylize(self, small: np.ndarray) -> np.ndarray:
        if self.style == ADAIN:
            from style_transfer.adain.inference import get_model

            return get_model().stylize(small, self._adain_feat, self.alpha, max(small.shape[:2]))
        net = get_style_model(self.style)
        x = torch.from_numpy(small).permute(2, 0, 1).float().unsqueeze(0)  # BGR 0–255, as trained
        out = net(x)[0].clamp(0, 255).permute(1, 2, 0).numpy().astype(np.uint8)
        if out.shape[:2] != small.shape[:2]:
            out = cv2.resize(out, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_LINEAR)
        if self.alpha < 1.0:
            out = cv2.addWeighted(out, self.alpha, small, 1.0 - self.alpha, 0)
        return out

    def process(self, bgr: np.ndarray) -> np.ndarray:
        """One camera frame in → one stylized frame out (at a fixed output size, so the encoder never re-inits)."""
        h, w = bgr.shape[:2]
        ow, oh = fit_even(w, h, self.out_width, 2)
        if self.style == "raw" or self.alpha <= 0.0:
            return cv2.resize(bgr, (ow, oh), interpolation=cv2.INTER_AREA)
        t0 = time.perf_counter()
        sw, sh = fit_even(w, h, self.res.side, 8 if self.style == ADAIN else 4)
        small = cv2.resize(bgr, (sw, sh), interpolation=cv2.INTER_AREA)
        styled = self._stylize(small)
        if self.temporal:
            styled = self._stab.step(small, styled)
        out = cv2.resize(styled, (ow, oh), interpolation=cv2.INTER_LINEAR)
        self.last_infer_ms = (time.perf_counter() - t0) * 1000.0
        self.res.update(self.last_infer_ms)
        return out

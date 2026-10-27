"""
AdaIN inference helpers used by the API, the video job and the evaluation scripts.

Images are OpenCV BGR uint8 arrays at the boundaries; the network sees RGB in [0, 1].
Spatial sizes are snapped to multiples of 8 (three 2× down/up-sampling stages) and the
result is resized back to the content image's original size.
"""
from __future__ import annotations

import hashlib
import os
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Optional, Tuple

import cv2
import numpy as np
import torch

from .net import AdaINNet

MODEL_DIR = Path(os.environ.get("ADAIN_MODEL_DIR", Path(__file__).resolve().parents[2] / "models" / "adain"))
ENCODER_FILE = "vgg_normalised_relu4_1.pth"
DECODER_FILE = "decoder.pth"
SIZE_MULTIPLE = 8


def _device() -> torch.device:
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def fit_size(width: int, height: int, max_side: int, multiple: int = SIZE_MULTIPLE) -> Tuple[int, int]:
    """Largest (w, h) within max_side keeping aspect ratio, snapped down to `multiple`. Never upscales."""
    scale = min(1.0, max_side / float(max(width, height)))
    snap = lambda v: max(multiple, int(v * scale) // multiple * multiple)  # noqa: E731
    return snap(width), snap(height)


def bgr_to_tensor(img_bgr: np.ndarray, size: Tuple[int, int], device: torch.device) -> torch.Tensor:
    if img_bgr.ndim == 2:
        img_bgr = cv2.cvtColor(img_bgr, cv2.COLOR_GRAY2BGR)
    if img_bgr.shape[2] == 4:
        img_bgr = cv2.cvtColor(img_bgr, cv2.COLOR_BGRA2BGR)
    resized = cv2.resize(img_bgr, size, interpolation=cv2.INTER_AREA)
    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
    return torch.from_numpy(rgb).permute(2, 0, 1).float().div_(255.0).unsqueeze(0).to(device)


def tensor_to_bgr(t: torch.Tensor) -> np.ndarray:
    rgb = t.squeeze(0).clamp(0, 1).mul(255).round().byte().permute(1, 2, 0).cpu().numpy()
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


class AdaINModel:
    """Loads the network once; caches encoded style features (encoding is half the cost)."""

    def __init__(self, model_dir: Path = MODEL_DIR, device: Optional[torch.device] = None):
        self.device = device or _device()
        enc_path = Path(model_dir) / ENCODER_FILE
        dec_path = Path(model_dir) / DECODER_FILE
        for p in (enc_path, dec_path):
            if not p.is_file() or p.stat().st_size == 0:
                raise FileNotFoundError(f"AdaIN checkpoint missing: {p}")
        net = AdaINNet()
        net.encoder.load_state_dict(torch.load(enc_path, map_location="cpu"))
        net.decoder.load_state_dict(torch.load(dec_path, map_location="cpu"))
        self.net = net.to(self.device).eval()
        self._style_cache: "OrderedDict[str, torch.Tensor]" = OrderedDict()
        self._lock = threading.Lock()

    @torch.no_grad()
    def encode_style(self, style_bgr: np.ndarray, max_side: int = 512) -> torch.Tensor:
        h, w = style_bgr.shape[:2]
        key = hashlib.sha1(style_bgr.tobytes()).hexdigest() + f":{max_side}"
        with self._lock:
            cached = self._style_cache.get(key)
            if cached is not None:
                self._style_cache.move_to_end(key)
                return cached
        feat = self.net.encode(bgr_to_tensor(style_bgr, fit_size(w, h, max_side), self.device))
        with self._lock:
            self._style_cache[key] = feat
            while len(self._style_cache) > 8:
                self._style_cache.popitem(last=False)
        return feat

    @torch.no_grad()
    def stylize(
        self,
        content_bgr: np.ndarray,
        style_feat: torch.Tensor,
        alpha: float = 1.0,
        max_side: int = 768,
        keep_size: bool = True,
    ) -> np.ndarray:
        alpha = float(max(0.0, min(1.0, alpha)))
        h, w = content_bgr.shape[:2]
        size = fit_size(w, h, max_side)
        content = bgr_to_tensor(content_bgr, size, self.device)
        out = self.net.decode_from(self.net.encode(content), style_feat, alpha)
        out = out[:, :, : size[1], : size[0]]  # ceil-mode pooling can add a few pixels
        bgr = tensor_to_bgr(out)
        if keep_size and (bgr.shape[1], bgr.shape[0]) != (w, h):
            bgr = cv2.resize(bgr, (w, h), interpolation=cv2.INTER_CUBIC)
        return bgr


_model: Optional[AdaINModel] = None
_model_lock = threading.Lock()


def get_model() -> AdaINModel:
    global _model
    with _model_lock:
        if _model is None:
            _model = AdaINModel()
        return _model


def stylize_image(content_bgr: np.ndarray, style_bgr: np.ndarray, alpha: float = 1.0, max_side: int = 768) -> np.ndarray:
    model = get_model()
    return model.stylize(content_bgr, model.encode_style(style_bgr), alpha=alpha, max_side=max_side)


def stylize_frame(frame_bgr: np.ndarray, style_feat: torch.Tensor, alpha: float, max_side: int) -> np.ndarray:
    return get_model().stylize(frame_bgr, style_feat, alpha=alpha, max_side=max_side)

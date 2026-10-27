import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np
from django.test import SimpleTestCase

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from evaluate_style_transfer import temporal_metrics  # noqa: E402


def _pan_clip(path: Path, frames=12, step=4, flicker=0):
    """A textured image panning right; `flicker` adds random per-frame brightness jumps."""
    rng = np.random.default_rng(0)
    base = cv2.GaussianBlur(rng.integers(0, 255, (120, 400, 3), dtype=np.uint8), (0, 0), 2)
    w = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 10, (160, 120))
    for i in range(frames):
        f = base[:, i * step : i * step + 160].astype(np.int16)
        if flicker:
            f = f + int(rng.integers(-flicker, flicker))
        w.write(np.clip(f, 0, 255).astype(np.uint8))
    w.release()


class TemporalWarpingErrorTests(SimpleTestCase):
    def test_motion_compensated_error_is_near_zero_for_a_clean_pan(self):
        with tempfile.TemporaryDirectory() as d:
            clip = Path(d) / "pan.avi"
            _pan_clip(clip)
            m = temporal_metrics(clip, clip, 50)
        # Pure translation is fully explained by optical flow → TWE far below raw frame difference.
        self.assertLess(m["temporal_warping_error_mae"], 0.5 * m["naive_frame_diff_mae"])

    def test_flicker_increases_twe(self):
        with tempfile.TemporaryDirectory() as d:
            clean, flick = Path(d) / "a.avi", Path(d) / "b.avi"
            _pan_clip(clean)
            _pan_clip(flick, flicker=25)
            smooth = temporal_metrics(clean, clean, 50)["temporal_warping_error_mae"]
            flickery = temporal_metrics(clean, flick, 50)["temporal_warping_error_mae"]
        self.assertGreater(flickery, smooth * 3)

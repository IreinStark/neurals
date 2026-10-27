import numpy as np
import cv2
from django.test import SimpleTestCase

from style_transfer.temporal import TemporalStabilizer


def _scene(w=200, h=120, seed=0):
    rng = np.random.default_rng(seed)
    return cv2.GaussianBlur(rng.integers(0, 255, (h, w * 3, 3), dtype=np.uint8), (0, 0), 3)


def _flicker(img, rng, amount=30):
    """Imitate per-frame stylization flicker: blotchy colour/brightness shifts that change every frame."""
    noise = cv2.GaussianBlur(rng.normal(0, 1, img.shape).astype(np.float32), (0, 0), 8)
    noise *= amount / (noise.std() + 1e-6)
    return np.clip(img.astype(float) + noise, 0, 255).astype(np.uint8)


def _sharpness(img):
    return cv2.Laplacian(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var()


class TemporalStabilizerTests(SimpleTestCase):
    def test_first_frame_passes_through_unchanged(self):
        s = TemporalStabilizer()
        img = _scene()[:, :200]
        self.assertTrue(np.array_equal(s.step(img, img), img))

    def test_blend_zero_is_plain_per_frame(self):
        rng = np.random.default_rng(1)
        s = TemporalStabilizer(blend=0.0)
        base = _scene()[:, :200]
        for _ in range(3):
            styl = _flicker(base, rng)
            self.assertTrue(np.array_equal(s.step(base, styl), styl))

    def test_reduces_frame_to_frame_change_on_a_static_scene(self):
        rng = np.random.default_rng(2)
        content = _scene()[:, :200]
        s = TemporalStabilizer()
        raw, out = [], []
        for _ in range(12):
            styl = _flicker(content, rng)
            raw.append(styl)
            out.append(s.step(content, styl))
        diff = lambda seq: np.mean([np.abs(a.astype(int) - b.astype(int)).mean() for a, b in zip(seq[5:], seq[6:])])  # noqa: E731
        self.assertLess(diff(out), 0.5 * diff(raw))

    def test_follows_motion_when_the_camera_pans(self):
        """On a pan the stabilized output must move with the scene: no freezing, no ghost trails."""
        rng = np.random.default_rng(3)
        big = np.full((120, 600, 3), 40, np.uint8)
        for _ in range(60):  # distinct shapes give optical flow something real to track
            x, y = int(rng.integers(0, 600)), int(rng.integers(0, 120))
            color = tuple(int(c) for c in rng.integers(60, 255, 3))
            cv2.circle(big, (x, y), int(rng.integers(5, 18)), color, -1)
        big = cv2.GaussianBlur(big, (0, 0), 1)
        s = TemporalStabilizer()
        outs = [s.step(big[:, i * 6 : i * 6 + 200], big[:, i * 6 : i * 6 + 200]) for i in range(10)]
        truth = big[:, 54:254].astype(int)
        err = np.abs(outs[-1].astype(int) - truth)[:, 20:-20].mean()
        frozen = np.abs(outs[0].astype(int) - truth)[:, 20:-20].mean()
        self.assertLess(err, 0.05 * frozen)

    def test_keeps_texture_sharp(self):
        """Default (detail-preserving) mode must not blur the style texture away."""
        rng = np.random.default_rng(6)
        content = _scene(seed=6)[:, :200]
        texture = rng.integers(0, 255, content.shape, dtype=np.uint8)  # high-frequency "brushwork"
        s = TemporalStabilizer()
        outs = [s.step(content, _flicker(texture, rng)) for _ in range(10)]
        self.assertGreater(_sharpness(outs[-1]), 0.8 * _sharpness(texture))

    def test_full_frame_mode_is_smoother_but_blurrier(self):
        rng = np.random.default_rng(7)
        content = _scene(seed=7)[:, :200]
        texture = rng.integers(0, 255, content.shape, dtype=np.uint8)
        full, detail = TemporalStabilizer(detail_sigma=0), TemporalStabilizer()
        for _ in range(10):
            styl = _flicker(texture, rng)
            a, b = full.step(content, styl), detail.step(content, styl)
        self.assertLess(_sharpness(a), _sharpness(b))

    def test_reset_starts_a_new_clip(self):
        s = TemporalStabilizer()
        a = _scene(seed=4)[:, :200]
        b = _scene(seed=5)[:, :200]
        s.step(a, a)
        s.reset()
        self.assertTrue(np.array_equal(s.step(b, b), b))

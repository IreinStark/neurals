import base64
import tempfile
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, override_settings
from django.urls import reverse

from style_transfer.adain.inference import AdaINModel, fit_size
from style_transfer.job_state import get_job_state


def _png(h, w, seed):
    rng = np.random.default_rng(seed)
    img = cv2.GaussianBlur(rng.integers(0, 255, (h, w, 3), dtype=np.uint8), (0, 0), 3)
    return cv2.imencode(".png", img)[1].tobytes(), img


def _upload(name, data, ctype="image/png"):
    return SimpleUploadedFile(name, data, content_type=ctype)


class AdaINModelTests(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.model = AdaINModel()

    def test_fit_size_snaps_to_multiples_of_8_without_upscaling(self):
        self.assertEqual(fit_size(979, 734, 512), (512, 376))  # 734 * 512/979 = 383.9 → 376
        self.assertEqual(fit_size(100, 60, 512), (96, 56))

    def test_output_keeps_content_size_and_differs_from_content(self):
        _, content = _png(90, 130, 1)
        _, style = _png(80, 80, 2)
        out = self.model.stylize(content, self.model.encode_style(style), alpha=1.0, max_side=128)
        self.assertEqual(out.shape, content.shape)
        self.assertGreater(np.abs(out.astype(int) - content.astype(int)).mean(), 5)

    def test_alpha_moves_output_between_content_and_style(self):
        _, content = _png(64, 64, 3)
        _, style = _png(64, 64, 4)
        feat = self.model.encode_style(style)
        low = self.model.stylize(content, feat, alpha=0.0, max_side=64)
        high = self.model.stylize(content, feat, alpha=1.0, max_side=64)
        d_low = np.abs(low.astype(int) - content.astype(int)).mean()
        d_high = np.abs(high.astype(int) - content.astype(int)).mean()
        self.assertLess(d_low, d_high)

    def test_style_features_are_cached(self):
        _, style = _png(40, 40, 5)
        self.assertIs(self.model.encode_style(style), self.model.encode_style(style))


class AdaINImageApiTests(SimpleTestCase):
    def test_stylizes_content_with_uploaded_style(self):
        c_bytes, content = _png(60, 100, 6)
        s_bytes, _ = _png(64, 64, 7)
        res = self.client.post(
            reverse("api_v2:adain-image"),
            {"content": _upload("c.png", c_bytes), "style": _upload("s.png", s_bytes), "alpha": "0.8", "max_side": "96"},
        )
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual((body["width"], body["height"]), (100, 60))
        self.assertEqual(body["alpha"], 0.8)
        img = cv2.imdecode(np.frombuffer(base64.b64decode(body["image"].split(",", 1)[1]), np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(img.shape, content.shape)

    def test_validation_errors_use_the_v2_envelope(self):
        c_bytes, _ = _png(32, 32, 8)
        url = reverse("api_v2:adain-image")
        r = self.client.post(url, {"content": _upload("c.png", c_bytes)})
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (400, "missing_style"))
        r = self.client.post(url, {"content": _upload("c.png", c_bytes), "style": _upload("s.png", c_bytes), "alpha": "2"})
        self.assertEqual(r.json()["error"]["code"], "invalid_alpha")
        r = self.client.post(url, {"content": _upload("c.txt", b"hello", "text/plain"), "style": _upload("s.png", c_bytes)})
        self.assertEqual(r.json()["error"]["code"], "invalid_content")
        self.assertEqual(self.client.get(url).status_code, 405)


class _SyncThread:
    """Runs the job immediately so the test can inspect the finished state."""

    def __init__(self, target, args=(), kwargs=None, daemon=None):
        self.target, self.args, self.kwargs = target, args, kwargs or {}

    def start(self):
        self.target(*self.args, **self.kwargs)


class AdaINVideoApiTests(SimpleTestCase):
    def test_video_job_completes_with_a_playable_file(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "in.avi"
            w = cv2.VideoWriter(str(src), cv2.VideoWriter_fourcc(*"MJPG"), 8, (96, 64))
            for i in range(4):
                w.write(np.full((64, 96, 3), 40 * i, np.uint8))
            w.release()
            s_bytes, _ = _png(48, 48, 9)
            with override_settings(MEDIA_ROOT=d, BASE_DIR=Path(d), WEBCAM_VIDEO_TASK_MODE="thread"), patch(
                "api_v2.adain_views.Thread", _SyncThread
            ), patch("style_transfer.tasks._save_processed_video"):
                res = self.client.post(
                    reverse("api_v2:adain-video"),
                    {
                        "video": _upload("in.avi", src.read_bytes(), "video/x-msvideo"),
                        "style": _upload("s.png", s_bytes),
                        "alpha": "1",
                    },
                )
                self.assertEqual(res.status_code, 202, res.content)
                state = get_job_state(res.json()["job_id"])
            self.assertEqual(state["status"], "completed", state)
            self.assertTrue(state["video_url"].startswith("/media/output/video-"))
            self.assertEqual(state["style"], "custom")

    def test_rejects_missing_style(self):
        res = self.client.post(reverse("api_v2:adain-video"), {"video": _upload("v.mp4", b"x", "video/mp4")})
        self.assertEqual(res.json()["error"]["code"], "missing_style")

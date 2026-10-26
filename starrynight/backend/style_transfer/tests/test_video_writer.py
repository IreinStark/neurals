import os
import tempfile
from unittest.mock import patch

import numpy as np
from django.test import SimpleTestCase

from style_transfer.tasks import open_browser_playable_writer


class _FakeWriter:
    def __init__(self, ok):
        self.ok = ok

    def isOpened(self):
        return self.ok

    def release(self):
        pass


class BrowserPlayableWriterTests(SimpleTestCase):
    def test_writes_a_real_file_with_an_available_codec(self):
        with tempfile.TemporaryDirectory() as d:
            writer, path = open_browser_playable_writer(os.path.join(d, "out.mp4"), 10.0, (64, 48))
            for i in range(5):
                writer.write(np.full((48, 64, 3), i * 40, np.uint8))
            writer.release()
            self.assertTrue(os.path.getsize(path) > 0)
            self.assertIn(os.path.splitext(path)[1], {".mp4", ".webm"})

    def test_prefers_h264_then_webm_and_switches_extension(self):
        opened = []

        def fake_writer(path, fourcc, fps, size):
            opened.append(path)
            return _FakeWriter(path.endswith(".webm"))  # pretend H.264 is unavailable

        with patch("cv2.VideoWriter", side_effect=fake_writer):
            _, path = open_browser_playable_writer("/tmp/x/video-1.mp4", 8.0, (640, 360))
        self.assertEqual(opened[0], "/tmp/x/video-1.mp4")
        self.assertEqual(path, "/tmp/x/video-1.webm")

    def test_raises_when_nothing_opens(self):
        with patch("cv2.VideoWriter", side_effect=lambda *a: _FakeWriter(False)):
            with self.assertRaises(ValueError):
                open_browser_playable_writer("/tmp/x/v.mp4", 8.0, (640, 360))


class FastPipelineReturnsWrittenPathTests(SimpleTestCase):
    def test_returns_the_path_actually_written(self):
        import cv2

        from style_transfer import tasks

        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "in.avi")
            w = cv2.VideoWriter(src, cv2.VideoWriter_fourcc(*"MJPG"), 10, (64, 48))
            for i in range(3):
                w.write(np.full((48, 64, 3), i * 60, np.uint8))
            w.release()
            with patch.object(tasks.StyleTransferConfig, "get_loaded_model", return_value=object()), patch.object(
                tasks, "stlye_transfer", side_effect=lambda model, content: content
            ):
                out = tasks._process_webcam_video_fast(src, os.path.join(d, "out.mp4"), "m.pth", lambda *a: None)
            self.assertIsNotNone(out)
            self.assertTrue(os.path.exists(out))
            self.assertGreater(os.path.getsize(out), 0)

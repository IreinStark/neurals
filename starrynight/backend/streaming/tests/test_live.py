import asyncio
import time

import cv2
import numpy as np
from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack
from av import VideoFrame
from channels.testing import WebsocketCommunicator
from django.test import SimpleTestCase, override_settings

from streaming.pipeline import AdaptiveResolution, FrameStylizer, fit_even


def _scene(t: int, w=320, h=240):
    img = np.zeros((h, w, 3), np.uint8)
    img[:] = (40, 90, 160)
    cv2.circle(img, (60 + 4 * t, 120), 40, (230, 200, 60), -1)
    cv2.rectangle(img, (200, 40), (280, 200), (30, 160, 60), -1)
    return img


class AdaptiveResolutionTests(SimpleTestCase):
    def test_slow_frames_lower_the_resolution_and_fast_frames_raise_it(self):
        r = AdaptiveResolution(target_fps=10, max_side=384, min_side=160, side=256)
        for _ in range(30):
            r.update(400)  # 2.5 fps — far too slow
        self.assertEqual(r.side, 160)
        for _ in range(60):
            r.update(20)  # fast
        self.assertEqual(r.side, 384)

    def test_fit_even(self):
        self.assertEqual(fit_even(1280, 720, 640, 2), (640, 360))
        self.assertEqual(fit_even(300, 200, 640, 4), (300, 200))


class FrameStylizerTests(SimpleTestCase):
    def test_fixed_style_output_size_is_constant_and_styled(self):
        s = FrameStylizer(style="starry-night", temporal=False, out_width=320)
        frame = _scene(0, 640, 480)
        out = s.process(frame)
        self.assertEqual(out.shape, (240, 320, 3))
        ref = cv2.resize(frame, (320, 240))
        self.assertGreater(float(np.abs(out.astype(int) - ref).mean()), 10)
        s.res.side = 160
        self.assertEqual(s.process(frame).shape, (240, 320, 3))  # resolution change never changes output size

    def test_alpha_zero_and_raw_pass_the_camera_through(self):
        frame = _scene(0)
        s = FrameStylizer(style="starry-night", alpha=0.0, out_width=320)
        np.testing.assert_array_equal(s.process(frame), frame)
        s.set_alpha(1.0)
        s.set_style("raw")
        np.testing.assert_array_equal(s.process(frame), frame)

    def test_unknown_style_and_adain_without_image_are_rejected(self):
        s = FrameStylizer()
        with self.assertRaises(Exception):
            s.set_style("no-such-style")
        with self.assertRaises(ValueError):
            s.set_style("adain")

    def test_adain_with_uploaded_style_image(self):
        s = FrameStylizer(temporal=False, out_width=256)
        painting = cv2.GaussianBlur(np.random.default_rng(1).integers(0, 255, (128, 128, 3), dtype=np.uint8), (0, 0), 2)
        s.set_style_image(painting)
        self.assertEqual(s.style, "adain")
        self.assertEqual(s.process(_scene(0)).shape, (192, 256, 3))


class SyntheticCamera(VideoStreamTrack):
    def __init__(self):
        super().__init__()
        self.n = 0

    async def recv(self):
        pts, time_base = await self.next_timestamp()
        frame = VideoFrame.from_ndarray(_scene(self.n % 40), format="bgr24")
        frame.pts, frame.time_base = pts, time_base
        self.n += 1
        return frame


@override_settings(LIVE_ICE_SERVERS=[], LIVE_MAX_SESSIONS=1, ALLOWED_HOSTS=["*"])
class LiveSignallingTests(SimpleTestCase):
    """End to end: browser-like aiortc peer ⇄ Channels signalling ⇄ server peer ⇄ stylizer."""

    def _communicator(self):
        from writer_backend.asgi import application

        return WebsocketCommunicator(application, "/ws/live/", headers=[(b"origin", b"http://localhost")])

    def test_stream_round_trip_returns_stylized_frames_and_stats(self):
        async def run():
            ws = self._communicator()
            connected, _ = await ws.connect()
            self.assertTrue(connected)
            hello = await ws.receive_json_from(timeout=5)
            self.assertEqual(hello["type"], "hello")
            self.assertIn("starry-night", hello["styles"])

            pc = RTCPeerConnection()
            pc.addTransceiver(SyntheticCamera(), direction="sendrecv")
            got = asyncio.get_running_loop().create_future()

            @pc.on("track")
            def on_track(track):
                async def pull():
                    frames = []
                    while len(frames) < 3:
                        frames.append((await track.recv()).to_ndarray(format="bgr24"))
                    got.set_result(frames)

                asyncio.ensure_future(pull())

            await pc.setLocalDescription(await pc.createOffer())
            await ws.send_json_to({"type": "offer", "sdp": pc.localDescription.sdp, "style": "starry-night", "alpha": 1.0})
            answer = await ws.receive_json_from(timeout=30)
            self.assertEqual(answer["type"], "answer", answer)
            await pc.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type="answer"))

            frames = await asyncio.wait_for(got, 90)
            self.assertEqual(frames[-1].shape[1], 320)  # output width (camera is 320 wide)
            raw = _scene(0)
            self.assertGreater(float(np.abs(frames[-1].astype(int) - raw).mean()), 10)  # it's stylized

            stats = None
            deadline = time.time() + 20
            while time.time() < deadline:
                m = await ws.receive_json_from(timeout=10)
                if m["type"] == "stats" and m["sent"] >= 3:
                    stats = m
                    break
            self.assertIsNotNone(stats)
            self.assertEqual(stats["style"], "starry-night")
            self.assertGreater(stats["pipelineMs"], 0)

            await ws.send_json_to({"type": "style", "style": "no-such-style"})
            err = None
            while err is None:
                m = await ws.receive_json_from(timeout=10)
                if m["type"] == "error":
                    err = m
            self.assertEqual(err["code"], "bad_request")

            # a second session is refused while the server is at capacity (LIVE_MAX_SESSIONS=1)
            ws2 = self._communicator()
            await ws2.connect()
            busy = await ws2.receive_json_from(timeout=5)
            self.assertEqual(busy["code"], "busy")
            await ws2.disconnect()

            await pc.close()
            await ws.send_json_to({"type": "bye"})
            await ws.disconnect()

        asyncio.run(run())

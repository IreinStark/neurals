"""
The return WebRTC video track: camera frames in, stylized frames out.

Latency management: a reader task drains the incoming track continuously and keeps only the newest
frame ("latest wins"). If inference is slower than the camera, stale frames are dropped instead of
queuing, so delay never builds up. Dropped frames are counted.

Frame synchronization: each output frame keeps the pts/time_base of the camera frame it was made from,
so the browser's jitter buffer plays them on the sender's clock.
"""
from __future__ import annotations

import asyncio
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from aiortc import MediaStreamTrack
from aiortc.mediastreams import MediaStreamError
from av import VideoFrame

from .pipeline import FrameStylizer

# One inference thread per process: frames from all sessions are processed one at a time,
# which is what a single CPU/GPU can actually do.
_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="live-infer")


class StylizedTrack(MediaStreamTrack):
    kind = "video"

    def __init__(self, source: MediaStreamTrack, stylizer: FrameStylizer):
        super().__init__()
        self.source = source
        self.stylizer = stylizer
        self._latest: Optional[VideoFrame] = None
        self._latest_t = 0.0
        self._new = asyncio.Event()
        self._ended = False
        self.received = 0
        self.sent = 0
        self.dropped = 0
        self.pipeline_ms = 0.0  # frame arrival → stylized frame ready
        self.queue_ms = 0.0  # time the frame waited before inference started
        self._sent_times: list[float] = []
        self._reader = asyncio.ensure_future(self._read())

    async def _read(self):
        try:
            while True:
                frame = await self.source.recv()
                self.received += 1
                if self._latest is not None:
                    self.dropped += 1
                self._latest, self._latest_t = frame, time.perf_counter()
                self._new.set()
        except MediaStreamError:
            pass
        finally:
            self._ended = True
            self._new.set()

    @property
    def fps(self) -> int:
        now = time.perf_counter()
        self._sent_times = [t for t in self._sent_times if now - t <= 1.0]
        return len(self._sent_times)

    async def recv(self) -> VideoFrame:
        while self._latest is None:
            if self._ended:
                self.stop()
                raise MediaStreamError
            self._new.clear()
            await self._new.wait()
        frame, arrived = self._latest, self._latest_t
        self._latest = None
        started = time.perf_counter()
        img = frame.to_ndarray(format="bgr24")
        out = await asyncio.get_running_loop().run_in_executor(_EXECUTOR, self.stylizer.process, img)
        done = time.perf_counter()
        self.queue_ms = (started - arrived) * 1000.0
        self.pipeline_ms = (done - arrived) * 1000.0
        self._sent_times.append(done)
        self.sent += 1
        new = VideoFrame.from_ndarray(out, format="bgr24")
        new.pts, new.time_base = frame.pts, frame.time_base
        return new

    def stop(self):
        super().stop()
        if not self._reader.done():
            self._reader.cancel()

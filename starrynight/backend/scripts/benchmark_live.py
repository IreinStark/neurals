"""
Latency benchmark: live WebRTC streaming vs the GP1 asynchronous upload → job → download path.

Live: a real aiortc peer streams a synthetic 30 fps camera through the actual Channels consumer and
aiortc server peer. Every stylized frame keeps its source frame's pts, so the client knows exactly when
that frame was captured. Per-frame latency is therefore measured, not estimated:
    capture (pts) → encode → network → server decode → stylize → encode → network → client decode.

Async (GP1): the same number of seconds of video goes through the existing video job
(_process_webcam_video_fast). Time until the user can see anything = whole-clip processing time.

Usage:  python scripts/benchmark_live.py --seconds 8 --styles starry-night,wave --sides 160,256,384 --fps 15
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import json
import os
import statistics
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "writer_backend.settings")
os.environ.setdefault("CACHE_BACKEND", "locmem")

import django  # noqa: E402

django.setup()

from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack  # noqa: E402
from av import VideoFrame  # noqa: E402
from channels.testing import WebsocketCommunicator  # noqa: E402
from django.conf import settings  # noqa: E402


def scene(t: int, w: int, h: int) -> np.ndarray:
    img = np.full((h, w, 3), (40, 90, 160), np.uint8)
    cv2.circle(img, (int(w * 0.2) + 6 * (t % 60), h // 2), h // 6, (230, 200, 60), -1)
    cv2.rectangle(img, (int(w * 0.65), h // 6), (int(w * 0.85), h * 5 // 6), (30, 160, 60), -1)
    cv2.putText(img, f"{t:05d}", (20, h - 20), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 2)
    return img


class Camera(VideoStreamTrack):
    def __init__(self, w, h):
        super().__init__()
        self.w, self.h, self.n = w, h, 0
        self.sent_at = {}

    async def recv(self):
        pts, tb = await self.next_timestamp()
        frame = VideoFrame.from_ndarray(scene(self.n, self.w, self.h), format="bgr24")
        frame.pts, frame.time_base = pts, tb
        self.sent_at[pts] = time.perf_counter()
        self.n += 1
        return frame


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))] if xs else float("nan")


async def run_live(style: str, side, seconds: float, w: int, h: int, target_fps: float, temporal: bool):
    """side = int → resolution pinned; side = "adaptive" → 160–384 chosen by the controller."""
    from writer_backend.asgi import application

    settings.LIVE_MAX_SIDE, settings.LIVE_MIN_SIDE = (384, 160) if side == "adaptive" else (side, side)
    settings.LIVE_ICE_SERVERS = []
    ws = WebsocketCommunicator(application, "/ws/live/", headers=[(b"origin", b"http://localhost")])
    await ws.connect()
    await ws.receive_json_from(timeout=10)
    cam = Camera(w, h)
    pc = RTCPeerConnection()
    pc.addTransceiver(cam, direction="sendrecv")
    lat, arrivals, stop = [], [], asyncio.Event()

    @pc.on("track")
    def on_track(track):
        async def pull():
            while not stop.is_set():
                try:
                    f = await asyncio.wait_for(track.recv(), 10)
                except Exception:
                    break
                now = time.perf_counter()
                if f.pts in cam.sent_at:
                    lat.append((now - cam.sent_at[f.pts]) * 1000)
                    arrivals.append(now)

        asyncio.ensure_future(pull())

    await pc.setLocalDescription(await pc.createOffer())
    await ws.send_json_to({"type": "offer", "sdp": pc.localDescription.sdp, "style": style, "alpha": 1.0,
                           "temporal": temporal, "targetFps": target_fps})
    while True:
        m = await ws.receive_json_from(timeout=60)
        if m["type"] == "answer":
            break
    await pc.setRemoteDescription(RTCSessionDescription(sdp=m["sdp"], type="answer"))

    warm = time.perf_counter() + 3.0  # model load + encoder warm-up excluded
    end = warm + seconds
    stats = []
    while time.perf_counter() < end:
        try:
            m = await ws.receive_json_from(timeout=2)
            if m["type"] == "stats" and time.perf_counter() > warm:
                stats.append(m)
        except Exception:
            pass
    stop.set()
    n_warm = sum(1 for t in arrivals if t <= warm)
    lat_s, arr_s = lat[n_warm:], [t for t in arrivals if t > warm]
    sent = sum(1 for t in cam.sent_at.values() if warm < t <= end)
    await pc.close()
    await ws.send_json_to({"type": "bye"})
    await ws.disconnect()
    fps = (len(arr_s) - 1) / (arr_s[-1] - arr_s[0]) if len(arr_s) > 1 else 0.0
    last = stats[-1] if stats else {}
    return {
        "mode": "live WebRTC", "style": style, "max_side": side, "temporal": temporal,
        "frames_captured": sent, "frames_returned": len(lat_s),
        "fps_out": round(fps, 1),
        "latency_ms_p50": round(pct(lat_s, 50), 1), "latency_ms_p95": round(pct(lat_s, 95), 1),
        "server_infer_ms": round(statistics.mean([s["inferMs"] for s in stats]), 1) if stats else None,
        "server_pipeline_ms": round(statistics.mean([s["pipelineMs"] for s in stats]), 1) if stats else None,
        "final_side": last.get("side"), "dropped_pct": round(100 * (1 - len(lat_s) / max(1, sent)), 1),
        "time_to_first_frame_s": None,
    }


def run_async(style: str, seconds: float, w: int, h: int, fps: int = 30):
    from style_transfer.reco.style_catalog import resolve_style_model
    from style_transfer.tasks import _process_webcam_video_fast

    tmp = Path(tempfile.mkdtemp())
    src = tmp / "clip.mp4"
    vw = cv2.VideoWriter(str(src), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    for i in range(int(seconds * fps)):
        vw.write(scene(i, w, h))
    vw.release()
    path, _ = resolve_style_model(BACKEND, style)
    t0 = time.perf_counter()
    try:
        _process_webcam_video_fast(str(src), str(tmp / "out.mp4"), path, lambda *_: None, temporal=True)
    except TypeError:
        _process_webcam_video_fast(str(src), str(tmp / "out.mp4"), path)
    total = time.perf_counter() - t0
    return {
        "mode": "async upload job (GP1)", "style": style, "max_side": None, "temporal": True,
        "frames_captured": int(seconds * fps), "frames_returned": int(seconds * fps), "fps_out": round(seconds * fps / total, 1),
        "latency_ms_p50": None, "latency_ms_p95": None, "server_infer_ms": None, "server_pipeline_ms": None,
        "final_side": None, "dropped_pct": 0.0, "time_to_first_frame_s": round(total, 2),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=8)
    ap.add_argument("--styles", default="starry-night")
    ap.add_argument("--sides", default="160,256,384,adaptive")
    ap.add_argument("--fps", type=float, default=15, help="server target fps (adaptive resolution)")
    ap.add_argument("--size", default="640x360", help="camera resolution")
    ap.add_argument("--no-async", action="store_true")
    ap.add_argument("--out", default=str(BACKEND / "evaluation" / "results"))
    args = ap.parse_args()
    w, h = map(int, args.size.split("x"))
    rows = []
    for style in args.styles.split(","):
        for side in [int(x) if x.isdigit() else x for x in args.sides.split(",")]:
            r = asyncio.run(run_live(style, side, args.seconds, w, h, args.fps, True))
            print(json.dumps(r))
            rows.append(r)
        if not args.no_async:
            r = run_async(style, args.seconds, w, h)
            print(json.dumps(r))
            rows.append(r)
    out = Path(args.out) / f"live_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    out.mkdir(parents=True, exist_ok=True)
    (out / "results.json").write_text(json.dumps({"camera": args.size, "seconds": args.seconds, "cpu_count": os.cpu_count(),
                                                  "target_fps": args.fps, "rows": rows}, indent=2))
    with open(out / "results.csv", "w", newline="") as f:
        wr = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        wr.writeheader()
        wr.writerows(rows)
    print("saved", out)


if __name__ == "__main__":
    main()

"""
WebRTC signalling over a Django Channels WebSocket:  ws(s)://<host>/ws/live/?token=<jwt access>

client → server                                       server → client
  {"type":"offer","sdp","style","alpha","temporal"}     {"type":"hello","iceServers","styles","maxSessions"}
  {"type":"style","style"}         preset id | "raw"    {"type":"answer","sdp"}
  {"type":"style_image","image"}   data URL → AdaIN     {"type":"stats", fps, inferMs, pipelineMs, queueMs,
  {"type":"config","alpha","temporal","targetFps"}                      side, dropped, received, style}
  {"type":"bye"}                                        {"type":"error","code","message"}

Non-trickle ICE: the browser sends its offer once ICE gathering is complete and aiortc answers
with all candidates included, so no candidate messages are needed.
"""
from __future__ import annotations

import asyncio
import base64
import logging

import cv2
import numpy as np
from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.conf import settings

from style_transfer.reco.style_catalog import STYLE_MODEL_CANDIDATES

from .pipeline import ADAIN, AdaptiveResolution, FrameStylizer
from .tracks import StylizedTrack

log = logging.getLogger(__name__)
_active = 0
MAX_STYLE_IMAGE_BYTES = 8 * 1024 * 1024


def _ice_servers():
    return [{"urls": u} for u in getattr(settings, "LIVE_ICE_SERVERS", ["stun:stun.l.google.com:19302"])]


def _decode_data_url(data_url: str):
    try:
        raw = base64.b64decode(data_url.split(",", 1)[1] if "," in data_url else data_url, validate=False)
    except Exception:
        return None
    if len(raw) > MAX_STYLE_IMAGE_BYTES:
        return None
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    return img


class LiveStyleConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        global _active
        self.pc = None
        self.track = None
        self.stats_task = None
        self.counted = False
        if getattr(settings, "LIVE_REQUIRE_AUTH", False) and not self.scope["user"].is_authenticated:
            await self.close(code=4401)
            return
        if _active >= getattr(settings, "LIVE_MAX_SESSIONS", 4):
            await self.accept()
            await self.send_json({"type": "error", "code": "busy", "message": "The live server is at capacity. Try again shortly."})
            await self.close(code=4429)
            return
        _active += 1
        self.counted = True
        self.stylizer = FrameStylizer(res=AdaptiveResolution(
            target_fps=float(getattr(settings, "LIVE_TARGET_FPS", 15)), max_side=int(getattr(settings, "LIVE_MAX_SIDE", 384)),
            min_side=int(getattr(settings, "LIVE_MIN_SIDE", 160)),
        ))
        self.stylizer.res.side = min(max(self.stylizer.res.side, self.stylizer.res.min_side), self.stylizer.res.max_side)
        await self.accept()
        await self.send_json({
            "type": "hello",
            "iceServers": _ice_servers(),
            "styles": list(STYLE_MODEL_CANDIDATES) + [ADAIN, "raw"],
            "maxSessions": getattr(settings, "LIVE_MAX_SESSIONS", 4),
        })

    async def disconnect(self, code):
        global _active
        if self.counted:
            _active = max(0, _active - 1)
            self.counted = False
        await self._teardown()

    async def _teardown(self):
        if self.stats_task:
            self.stats_task.cancel()
            self.stats_task = None
        if self.track:
            self.track.stop()
            self.track = None
        if self.pc:
            await self.pc.close()
            self.pc = None

    async def _error(self, code, message):
        await self.send_json({"type": "error", "code": code, "message": message})

    async def _apply(self, msg):
        if "alpha" in msg:
            self.stylizer.set_alpha(float(msg["alpha"]))
        if "temporal" in msg:
            self.stylizer.temporal = bool(msg["temporal"])
        if "targetFps" in msg:
            self.stylizer.res.target_fps = float(min(30, max(1, float(msg["targetFps"]))))
        if msg.get("style"):
            await asyncio.get_running_loop().run_in_executor(None, self.stylizer.set_style, msg["style"])

    async def receive_json(self, msg, **kwargs):
        kind = msg.get("type")
        try:
            if kind == "offer":
                await self._offer(msg)
            elif kind in ("style", "config"):
                await self._apply(msg)
            elif kind == "style_image":
                img = _decode_data_url(msg.get("image") or "")
                if img is None:
                    return await self._error("invalid_style_image", "The style image could not be read (max 8 MB).")
                await asyncio.get_running_loop().run_in_executor(None, self.stylizer.set_style_image, img)
                await self.send_json({"type": "style_ready", "style": ADAIN})
            elif kind == "bye":
                await self._teardown()
                await self.close()
            else:
                await self._error("unknown_message", f"Unknown message type: {kind!r}")
        except (ValueError, KeyError) as exc:
            await self._error("bad_request", str(exc))

    async def _offer(self, msg):
        await self._teardown()
        await self._apply({k: msg[k] for k in ("style", "alpha", "temporal", "targetFps") if k in msg})
        config = RTCConfiguration(iceServers=[RTCIceServer(urls=s["urls"]) for s in _ice_servers()])
        pc = self.pc = RTCPeerConnection(configuration=config)

        @pc.on("track")
        def on_track(track):
            if track.kind == "video" and self.track is None:
                self.track = StylizedTrack(track, self.stylizer)
                pc.addTrack(self.track)

        @pc.on("connectionstatechange")
        async def on_state():
            if pc.connectionState in ("failed", "closed"):
                await self._teardown()

        await pc.setRemoteDescription(RTCSessionDescription(sdp=msg["sdp"], type="offer"))
        if self.track is None:
            return await self._error("no_video", "The offer has no video track.")
        await pc.setLocalDescription(await pc.createAnswer())
        await self.send_json({"type": "answer", "sdp": pc.localDescription.sdp})
        self.stats_task = asyncio.ensure_future(self._stats_loop())

    async def _stats_loop(self):
        while self.track is not None:
            t, s = self.track, self.stylizer
            await self.send_json({
                "type": "stats",
                "fps": t.fps,
                "inferMs": round(s.last_infer_ms, 1),
                "pipelineMs": round(t.pipeline_ms, 1),
                "queueMs": round(t.queue_ms, 1),
                "side": s.res.side,
                "received": t.received,
                "sent": t.sent,
                "dropped": t.dropped,
                "style": s.style,
                "temporal": s.temporal,
            })
            await asyncio.sleep(1.0)

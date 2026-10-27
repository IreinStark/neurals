# Real-time WebRTC streaming (GP2 feature 2)

Webcam Studio → **Live Stream**. The camera is sent to the Django server over WebRTC. The server stylizes each
frame (preset TransformerNet, or AdaIN with an uploaded painting) and sends the result back on a second WebRTC
track, which plays in the design's second video layer. Style buttons and Style Strength change the stream live.

## Architecture

```
browser                                         Django (Daphne ASGI)
──────                                          ────────────────────
getUserMedia ─► RTCPeerConnection ══ video ══►  aiortc peer ─► StylizedTrack ─► FrameStylizer
                  ▲                                                │  (latest frame wins,       (TransformerNet / AdaIN,
                  ║◄═════════ stylized video ═════════════════════┘   pts kept)                  strength, temporal
                  ║                                                                              stabilizer, adaptive size)
WebSocket /ws/live/ ◄──── Channels consumer: hello / offer / answer / style / config / stats
```

- **Signalling:** Django Channels WebSocket `/ws/live/` (`streaming/consumers.py`). Optional JWT via `?token=`; set
  `LIVE_REQUIRE_AUTH=true` to make it mandatory. ICE is non-trickle: the offer and answer each carry all candidates.
- **Media:** aiortc on the server. The browser sends at most 640 px wide (`scaleResolutionDownBy`).
- **Next.js** proxies the WebSocket (`/ws/live/`), so the studio stays same-origin.

## The three engineering problems the proposal named

| Problem | Solution |
|---|---|
| **Latency management** | `StylizedTrack` drains the camera track continuously and keeps only the newest frame. When inference is slower than the camera, stale frames are dropped instead of queued, so latency can't build up (measured below: p95 stays close to p50). |
| **Frame synchronization** | Each stylized frame carries its source frame's `pts`/`time_base`, so the browser's jitter buffer plays it on the camera's clock. The benchmark uses the same `pts` to measure exact per-frame latency. |
| **Graceful degradation** | (1) `AdaptiveResolution` moves the inference size between 160 and 384 px to hold the target frame rate (`LIVE_TARGET_FPS`, default 15). The output size stays fixed so the encoder never restarts. (2) A session cap (`LIVE_MAX_SESSIONS`) answers "busy". (3) If the server is unreachable, full or drops the connection, the page says so and keeps styling in the browser (ONNX worker). |

Latency shown in the studio:
- **Latency** = network round trip + server pipeline.
- **Glass-to-glass** = encode + round trip + server pipeline + jitter buffer + decode.

All the components come from `RTCPeerConnection.getStats()` and the server's per-frame timing.

## Measured: live vs the GP1 asynchronous path

`python scripts/benchmark_live.py --seconds 10 --sides 160,256,384,adaptive --fps 15`. The results are in
`backend/evaluation/results/live_20261027_080401/`.

Setup:
- a real aiortc peer through the real consumer;
- a 640×360, 30 fps synthetic camera, starry-night style, temporal stabilization on;
- **a 2-vCPU cloud sandbox, no GPU**;
- latency = capture → … → stylized frame decoded at the client, matched by `pts`.

| Mode | Inference size | Output FPS | Latency p50 | Latency p95 | Server inference |
|---|---|---|---|---|---|
| Live WebRTC | 160 px (fixed) | 10.9 | 178 ms | 217 ms | 57 ms |
| Live WebRTC | 256 px (fixed) | 4.8 | 295 ms | 382 ms | 104 ms |
| Live WebRTC | 384 px (fixed) | 2.7 | 513 ms | 632 ms | 201 ms |
| **Live WebRTC** | **adaptive (settled at 192 px)** | **10.1** | **197 ms** | **244 ms** | 60 ms |
| GP1 async upload job | full frame | 7.1 (offline) | — | — | — |

GP1 async: **42 s** from submitting a 10-second clip to anything being viewable. Live mode shows the first
stylized frame within about 0.2 s, and the delay stays constant however long the session runs.

Reading the numbers:
- On 2 CPU cores, the VP8 encode and decode that aiortc does in the same process cost about as much as the
  model. That's why 256 px reaches only 4.8 FPS although inference alone takes 104 ms.
- The adaptive controller finds the best trade-off without manual tuning.
- On the GP1 GPU (36+ FPS measured for TransformerNet), inference drops to a few milliseconds and encoding becomes
  the limit. Expect real-time 30 FPS at 384 px or more.
- "Dropped" frames in `results.csv` are camera frames deliberately skipped by the latest-frame-wins policy
  (camera at 30 fps, server at about 10). They aren't lost packets.

Live browser check (Chromium with a fake camera, same sandbox, while model training was also running):
- the stream connected and the stylized track rendered;
- 7–11 FPS at 160 px, the studio showed about 280 ms latency and 310 ms glass-to-glass;
- switching styles mid-stream worked.

## Running it

```
pip install -r requirements.txt     # channels, daphne, aiortc
python manage.py runserver          # Daphne: HTTP + WebSocket on :8000
cd web && npm run build && npm start  # studio on :3000 (proxies /ws/live/)
```

Settings and env:

| Setting | Default |
|---|---|
| `LIVE_TARGET_FPS` | 15 |
| `LIVE_MAX_SIDE` | 384 |
| `LIVE_MIN_SIDE` | 160 |
| `LIVE_MAX_SESSIONS` | 4 |
| `LIVE_REQUIRE_AUTH` | false |
| `LIVE_ICE_SERVERS` | `stun:stun.l.google.com:19302`; add a TURN server for users behind strict NATs |

In production run `daphne writer_backend.asgi:application`.

## Tests

- `streaming/tests/test_live.py`:
  - adaptive-resolution controller;
  - stylizer (sizes, strength, raw, AdaIN, validation);
  - **an end-to-end aiortc round trip through the Channels consumer** (stylized frames return, stats arrive, bad
    style is rejected, a second session gets "busy").
- `web/e2e/studio.spec.ts`: live mode falls back to in-browser styling when the server is unreachable.

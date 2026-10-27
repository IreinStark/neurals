# Neural Style Studio: How the Design Is Wired

The designer's page (`starrynight/design/Neural_Style_Studio.html`, kept untouched for reference) is served at `/` from a working copy, `web/studio/index.html`. That copy keeps the designer's markup, classes and styling. The only changes are the places where the page used to *simulate* something; those now call the real engine, `window.NS` (`web/src/studio/engine.ts`).

To see every change, diff the two files:
`diff <(sed 's/base64,[^"]*/B64/g' design/Neural_Style_Studio.html) <(sed 's/base64,[^"]*/B64/g' web/studio/index.html)`

| Screen / control | Design (simulated) | Now (real) |
|---|---|---|
| Image: style preview | CSS colour filter on the photo | TransformerNet ONNX model running in `style-preview-worker` (WebGPU → WebGL → WASM), 512 px preview |
| Image: Synthesize | Timed fake progress bar | Full-quality run (1280 px), with progress stages and the measured time and backend shown |
| Image: Export / Save / Share | Filtered copy of the photo | Composite of the real styled output at the design's intensity × strength formula |
| Image: Custom Style tab | Colour-statistics transfer | **AdaIN** (any style image). It runs in the browser and falls back to `/api/v2/adain/image/`. The Style Strength slider sets α. See [ADAIN.md](ADAIN.md). |
| Webcam: styled layer | CSS filter on a second `<video>` | Live frames go through the worker into a canvas layer (256 px, latest frame wins) |
| Webcam: FPS badge, latency, glass-to-glass | Static "60 FPS" and random numbers | Measured inference FPS, inference latency and capture-to-paint time |
| Webcam: snapshot / record / PiP | Filtered mix | Mixes the real styled canvas |
| Video Upload: Custom Style *(added; uses the design's own tab and upload components)* | Not in the design | AdaIN video job via `POST /api/v2/adain/video/` with the uploaded painting. Style Intensity sets α. |
| Video Upload | Re-encoded in the browser with a CSS filter | Django job (`POST /style_transfer/webcam-video/`) with progress polling (`/style_transfer/video-status/<id>/`); the result is served from `/media/` |
| Sign in / Create account | Fake | Django SimpleJWT (`/accounts/login/`, `/accounts/register/`); the email is used as the username |
| Forgot / Reset password | Fake | `/accounts/forgot-password/` → `/accounts/reset-password/`. There is no mail server, so the reset link opens directly. |
| Gallery: save / like / delete | In memory, lost on reload | Persisted in the browser (IndexedDB) |
| Header avatar, profile name, stats | "AM", "Alex Morgan", fixed numbers | The signed-in user's initials, name and email, plus real counts. Guests still see the design placeholders. |

## Style mapping

The design shows four styles, and each one maps to a trained checkpoint:

| Design card | Model |
|---|---|
| Starry Night | `starry-night` |
| Great Wave | `wave` |
| Neon Tokyo | `tokyo-ghoul` |
| Botanical | `lazy` (Lazy Sunday) |

`mosaic`, `udnie`, `bayanihan` and `pointilism` exist but have no card in the design.

## Known gaps (to raise with the designer or the plan)

- **No whiteboard screen in the design.** The collaborative board (the core of the GP2 plan) runs at `/board/<id>`. You can create one from `/dev` until the design adds a board screen.
- **Video intensity slider:** with presets, the backend video job has no intensity parameter yet. With Custom Style, the slider sets AdaIN's α.
- **Video quality:** the Video Upload screen uses the fast TransformerNet job. The ReCoNet temporal pipeline with TWE metrics is task T5.1.
- **Share links** only resolve in the same browser until the gallery moves to Supabase Storage (T2.2 and later).
- **Tailwind:** the design loads Tailwind from `cdn.tailwindcss.com`. That's fine for the demo, but Tailwind recommends a compiled stylesheet for production.

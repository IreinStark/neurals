# GP2 Feature 1: Arbitrary Style Transfer (AdaIN)

**Status: done.** Users can upload *any* painting as the style, on the Image Transfer screen and on Video Upload. No training is needed and there is no new `.pth` file per style.

## What was built

| Part | Where |
|---|---|
| AdaIN network (Huang & Belongie, ICCV 2017): VGG-19 encoder up to relu4_1, AdaIN layer, mirrored decoder | `backend/style_transfer/adain/net.py` |
| Pretrained weights from the reference implementation (naoto0804/pytorch-AdaIN, MIT licence). The VGG is trimmed to relu4_1 (80 MB → 14 MB). | `backend/models/adain/` |
| Inference with style-feature caching (each style image is encoded once) and α content↔style blending | `backend/style_transfer/adain/inference.py` |
| **API: content + style input.** `POST /api/v2/adain/image/` (content, style, alpha, max_side) returns the stylised image. | `backend/api_v2/adain_views.py` |
| **API: video job.** `POST /api/v2/adain/video/` (video, style, alpha) runs as a background job with the style encoded once; progress via `/style_transfer/video-status/<id>/`. | `backend/style_transfer/tasks.py` |
| Browser model: `adain.onnx` (two inputs plus α, dynamic sizes), checked against PyTorch to within 0.0005 (on a 0–255 scale) | `backend/scripts/export_adain_onnx.py` → `frontend/public/models/adain.onnx` |
| The worker accepts a style image once (cached by key) and then infers with `styleKey` and α | `web/src/workers/style-preview-worker.ts`, `web/src/ml/styleClient.ts` |
| **UI: Image → Custom Style.** Live preview in the browser (falls back to the server API). The "Style Strength (α)" slider is the AdaIN α. Synthesize renders at full quality. | `web/studio/index.html` |
| **UI: Video Upload → Custom Style.** New Presets / Custom Style toggle using the design's existing components. "Style Intensity" sets α for the job. | `web/studio/index.html` |
| Tests: model (size, α, caching), API validation and success, the video job end-to-end, worker protocol, and browser E2E for both screens | `backend/api_v2/tests/test_adain.py`, `web/src/ml/*.test.ts`, `web/e2e/studio.spec.ts` |

## Evaluation (same LPIPS / PSNR / TWE framework)

Run it with:

```
python scripts/evaluate_adain.py --content-dir <photos> --style starry-night=<starry.jpg> --style wave=<wave.jpg> --video <clip.mp4>
```

The script compares, on the same 4 photos and the same 2 paintings, the **TransformerNet model trained on that painting** against **AdaIN given the painting at inference time**. Results from the run in `evaluation/results/adain_20261027_083925` (CPU, 384 px):

| Method | FPS (CPU) | PSNR ↑ | MAE ↓ | Style distance ↓ |
|---|---|---|---|---|
| TransformerNet (fixed, trained per style) | 6.0 | 9.85 | 69.2 | 162.4 |
| **AdaIN (arbitrary, no training)** | 2.2 | **12.45** | **50.7** | **76.6** |

PSNR and MAE measure content preservation against the photo. Style distance is the AdaIN paper's style loss (VGG mean/std distance to the painting).

Temporal warping error on a 40-frame panning clip (lower = less flicker):

| Method | TWE |
|---|---|
| Source clip, unstylised (reference floor) | 0.40 |
| AdaIN, per frame | 22.65 |
| TransformerNet, per frame | 29.63 |
| ReCoNet | *not measurable (see below)* |

**Findings:**
- **Style and content.** AdaIN matches the target painting's style statistics 2.1× more closely and preserves more of the content structure (+2.6 dB PSNR). It does this with no per-style training, which is the main research contribution.
- **Caveat on style distance.** It is measured with AdaIN's own VGG encoder, which is what AdaIN optimises, so it favours AdaIN. Present it alongside the visual comparison (`comparison.jpg`) and LPIPS.
- **Speed.** AdaIN is about 2.7× slower per frame on CPU, because it runs a VGG encoder and decoder against TransformerNet's small network. On a GPU / WebGPU both run in real time.
- **Flicker.** Neither method has temporal training, so both flicker on video. AdaIN flickers about 24% less than TransformerNet here.
- **LPIPS** was not computed in this run, because the sandbox can't download its VGG weights. On a machine with internet, run `pip install -r requirements-eval.txt` and rerun the script to fill that column.

## Two problems found in the GP1 evaluation (important for the report)

1. **The ReCoNet checkpoint (`style_transfer/reco/reconet.pth`) is collapsed.** For any input it outputs a near-uniform grey image (pixel std about 1.3, every value about 127). A grey video can't flicker, so its TWE is about 0. **The GP1 headline result (TWE 0.0149, "3.4× better") came from this degenerate output and shouldn't be reported as temporal consistency.** The evaluation script now detects and flags this. Fixing it needs a properly trained ReCoNet checkpoint (task T5.1).
2. **The TWE metric warped frames in the wrong direction.** It used forward flow with `cv2.remap`, which needs backward flow. On a clean pan, that scored *worse* than not warping at all (25.1 vs 21.7). It's fixed in `scripts/evaluate_style_transfer.py`: the source clip against itself now scores 0.40. Regression tests are in `style_transfer/tests/test_temporal_metric.py`. Any GP1 TWE numbers should be re-measured.

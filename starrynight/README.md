# StarryNight

An application to train, experiment with, and deploy neural style transfer models for images
and video. Real-time throughput (≥20 FPS) requires a CUDA-enabled GPU; CPU inference runs
at ~3 FPS for images and ~1.25 FPS for video.

# Demo
![ezgif com-gif-maker](https://user-images.githubusercontent.com/15766192/141136055-0bd08f88-2445-421a-bcfc-05680daa4730.gif)

# Installation

1. Install Python 3.9 or higher and Node 16 or 18
2. Install python dependencies: `pip install -r requirements.txt`
3. cd into `frontend` and run `npm install`

# Usage

1. cd into `backend` and run `python manage.py runserver`
2. cd into `frontend` and run `npm start`

For local development Django uses an in-memory cache by default so no Redis is needed.
Set `CACHE_BACKEND=redis` (and `CACHE_URL`) in production.

# Available Styles

| Style ID | Label | Checkpoint |
|----------|-------|------------|
| `starry-night` | Van Gogh – Starry Night | `models/starry/starry80.pth` |
| `mosaic` | Gaudi – Mosaic | `models/mosiac/mosaic_light.pth` |
| `udnie` | Francis Picabia – Udnie | `models/udnie_aggressive.pth` |
| `wave` | Hokusai – Great Wave | `models/wave/wave100.pth` |
| `tokyo-ghoul` | Tokyo Ghoul | `models/tokyo_ghoul/tokyo_ghoul_light.pth` |
| `lazy` | Lazy Sunday | `models/lazy/lazy250.pth` |
| `bayanihan` | Bayanihan | `models/bayanihan100.pth` |

In-browser live preview uses `pointilism-10.onnx` (ONNX WebAssembly, no server round-trip).

# Verify Model Checkpoints

Before running, confirm all checkpoints are present:

```bash
cd backend
python scripts/verify_models.py
```

# Evaluation

Use the evaluator at `backend/scripts/evaluate_style_transfer.py` to benchmark the
fast image styles and the ReCoNet video model.

Image evaluation:

```bash
cd backend
python scripts/evaluate_style_transfer.py image \
  --input ../frontend/public/home/styled1.jpg \
  --style-id starry-night \
  --save-visualization evaluation/image-comparison.png \
  --json-out evaluation/image-metrics.json
```

Video evaluation with a saved temporal-stability graph:

```bash
cd backend
python scripts/evaluate_style_transfer.py video \
  --input path/to/input_video.mp4 \
  --save-output evaluation/stylized-video.mp4 \
  --save-plot evaluation/temporal-warping-error.png \
  --json-out evaluation/video-metrics.json
```

Notes:

* `LPIPS` is optional. Install with `pip install lpips` to enable it.
* The video evaluator computes an optical-flow-aligned temporal warping error (TWE),
  which is more meaningful than plain frame-to-frame difference for flicker checks.
* `--save-plot` writes a line graph of TWE across frame pairs.

## Evaluation Results (CPU, 400×300 input)

Image styles — measured on `frontend/public/home/styled1.jpg`:

| Style | Checkpoint | FPS | LPIPS | MAE | PSNR (dB) |
|-------|-----------|-----|-------|-----|-----------|
| Starry Night | `starry/starry80.pth` | 3.88 | 0.713 | 65.4 | 9.8 |
| Mosaic | `mosiac/mosaic_light.pth` | 3.59 | 0.445 | 28.3 | 17.3 |
| Udnie | `udnie_aggressive.pth` | 3.61 | 0.423 | 28.8 | 16.8 |
| Wave | `wave/wave100.pth` | 3.24 | 0.568 | 44.7 | 13.0 |
| Tokyo Ghoul | `tokyo_ghoul/tokyo_ghoul_light.pth` | 3.19 | 0.179 | 12.4 | 24.0 |
| Lazy Sunday | `lazy/lazy250.pth` | 2.93 | 0.549 | 50.0 | 11.8 |
| Bayanihan | `bayanihan100.pth` | 3.05 | 0.535 | 42.1 | 13.5 |

Video (ReCoNet) — `reco/reconet.pth`, 640×360:

| Metric | Value |
|--------|-------|
| Processing FPS (CPU) | 1.25 |
| Temporal Warping Error MAE | 0.0149 |

Higher LPIPS means the style diverges more from the input photo — expected for
high-texture styles like Starry Night. Lower TWE means less flicker between frames.
GPU inference (CUDA) is expected to reach ≥15 FPS at 640×360.

## Multi-style Batch Workflow

`backend/scripts/evaluation_workflow.py` runs all four default styles across available
devices, then writes a timestamped JSON, CSV, and HTML report to
`backend/evaluation/results/`.

```bash
cd starrynight/backend
python scripts/evaluation_workflow.py
```

What it produces:

| File | Description |
|------|-------------|
| `results_TIMESTAMP.json` | All raw metric rows with full metadata |
| `results_TIMESTAMP.csv`  | Flat CSV for import into spreadsheets |
| `fps_comparison_TIMESTAMP.png` | Bar chart — FPS across all checkpoints/devices |
| `quality_metrics_TIMESTAMP.png` | Line chart — PSNR / MAE / LPIPS per image run |
| `temporal_stability_TIMESTAMP.png` | Bar chart — flow-aligned TWE for video runs |
| `device_comparison_TIMESTAMP.png` | Average FPS grouped by device |
| `report_TIMESTAMP.html` | One-page HTML summary with embedded charts |

Open the report:

```bash
open backend/evaluation/results/report_*.html   # macOS
xdg-open backend/evaluation/results/report_*.html  # Linux
```

By default the workflow evaluates `starry-night`, `mosaic`, `wave`, and `udnie`.
To add more styles or swap the test image, edit the `main()` function at the bottom of
`evaluation_workflow.py`.  
If `test_data/sample.mp4` does not exist, video evaluation is skipped automatically.

`backend/scripts/results_tracker.py` is the collector used by the workflow. You can also
import it directly to record results from your own scripts:

```python
from results_tracker import ResultsTracker

tracker = ResultsTracker(results_dir="evaluation/results")
tracker.add_result(mode="Image", checkpoint="models/starry/starry80.pth",
                   device="cpu", fps=3.88, psnr=9.8, mae=65.4, lpips=0.713)
tracker.print_summary()
tracker.save_json()
tracker.generate_report()
```

# Quick Start

```bash
# Terminal 1: Backend
cd starrynight/backend
python manage.py runserver 127.0.0.1:8000
# → Django on port 8000 (uses in-memory cache, no Redis needed)

# Terminal 2: Frontend
cd starrynight/frontend
npm start
# → React on port 3000

# Terminal 3: Evaluate a style (optional)
cd starrynight/backend
python scripts/verify_models.py
python scripts/evaluate_style_transfer.py image \
  --input ../frontend/public/home/styled1.jpg \
  --style-id starry-night

# Full batch benchmark (5-10 min on CPU)
python scripts/evaluation_workflow.py
open evaluation/results/report_*.html  # macOS
```

# Walkthrough(YouTube Video)
[![](https://img.youtube.com/vi/EddMbohoZZc/0.jpg)](https://www.youtube.com/watch?v=EddMbohoZZc)


# Credits
* Pretrained models were taken from https://github.com/zhanghang1989/PyTorch-Multi-Style-Transfer

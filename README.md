# neurals: Real-time Neural Style Transfer for Images, Video & Webcam

This is a neural style transfer workspace. Its main project is **[StarryNight](./starrynight)**, a full-stack web app (Django + React + PyTorch) that turns images, videos and a live webcam feed into artwork styles such as Van Gogh's *Starry Night*, *Mosaic* and *Udnie*.

## My contributions

StarryNight extends an existing open-source project (see [Credits](#credits)). I built these parts myself:

- **Live multi-style webcam studio**: a React `WebcamStudio` screen that runs style models **in the browser** with ONNX Runtime Web, so you can preview and switch between 8 styles in real time.
- **ONNX export pipeline**: converts the PyTorch checkpoints to ONNX so they run client-side, without a GPU server.
- **Evaluation framework**: a benchmarking harness that compares styles and devices on **FPS, PSNR, MAE, LPIPS and Temporal Warping Error (TWE)**. It exports CSV/JSON results, charts and HTML reports (see [`starrynight/backend/evaluation/results`](./starrynight/backend/evaluation/results)).
- **Startup and setup fixes**: model verification script (`scripts/verify_models.py`), an in-memory cache by default for local development, and a fixed webcam processing flow.

## Repository layout

| Folder | What it is |
|---|---|
| [`starrynight/`](./starrynight) | The main app: Django backend (JWT auth, style-transfer API, evaluation) and React frontend (upload, results carousel, webcam studio). See its [README](./starrynight/README.md) and [ARCHITECTURE.md](./starrynight/ARCHITECTURE.md). |
| [`Real-time-Coherent-Style-Transfer-For-Videos/`](./Real-time-Coherent-Style-Transfer-For-Videos) | A **third-party reference implementation** of ReCoNet by [skq024](https://github.com/skq024/Real-time-Coherent-Style-Transfer-For-Videos), kept here for study and comparison. I did not write this code. |

## Tech stack

Python · PyTorch · Django · Django REST Framework · React · ONNX Runtime Web · Redis (optional cache)

## Quick start

See [`starrynight/README.md`](./starrynight/README.md) for full instructions. In short:

```bash
cd starrynight
pip install -r requirements.txt
cd backend && python manage.py runserver      # API on :8000
cd ../frontend && npm install && npm start     # UI on :3000
```

## Credits

StarryNight builds on these open-source projects:

- **StarryNight**, original app by Ayush Chaurasia (MIT License, 2021). See [`starrynight/LICENSE`](./starrynight/LICENSE).
- **fast-neural-style** PyTorch implementation, based on Johnson et al., *Perceptual Losses for Real-Time Style Transfer and Super-Resolution* (2016).
- **ReCoNet** temporal-consistency network, based on [irsisyphus/reconet](https://github.com/irsisyphus/reconet), with VGG code from [pytorch/examples](https://github.com/pytorch/examples).
- **Real-time-Coherent-Style-Transfer-For-Videos** by [skq024](https://github.com/skq024/Real-time-Coherent-Style-Transfer-For-Videos).

All original licences are kept with the code they cover.

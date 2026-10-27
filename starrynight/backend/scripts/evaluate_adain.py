"""
GP2 evaluation: arbitrary-style AdaIN vs. the fixed-style models already in the project.

Same metric framework as evaluate_style_transfer.py:
  * Image (per content × style):  FPS, PSNR, MAE, LPIPS (content preservation, vs. content)
                                  + style distance (VGG relu1_1…relu4_1 mean/std distance to the style image,
                                    the style loss of Huang & Belongie 2017; lower = closer to the style)
  * Video (one clip):             Temporal Warping Error (optical-flow aligned) per method
                                    — TransformerNet per-frame, AdaIN per-frame, ReCoNet (temporal training)

Methods compared, on the same content images and the same two styles:
  fixed  : TransformerNet checkpoint trained on that painting (starry-night, wave)
  adain  : AdaIN given the painting image at inference time (no training)

Usage:
  python scripts/evaluate_adain.py --content-dir <dir of photos> --style starry-night=<starry.jpg> \
      --style wave=<wave.jpg> --video <clip.mp4> [--size 512] [--out evaluation/results]
Writes results.json, results.csv, charts and report.html into evaluation/results/adain_<timestamp>/.
"""
from __future__ import annotations

import argparse
import csv
import html
import json
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path
from typing import Callable, Dict, List, Optional

import cv2
import numpy as np
import torch

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND / "scripts"))

from evaluate_style_transfer import (  # noqa: E402
    compute_mae,
    compute_psnr,
    maybe_compute_lpips,
    temporal_metrics,
)
from style_transfer.adain.inference import AdaINModel, bgr_to_tensor, fit_size  # noqa: E402
from style_transfer.adain.net import calc_mean_std  # noqa: E402
from style_transfer.fast_style.api import stlye_transfer  # noqa: E402
from style_transfer.fast_style.stylize import load_model as load_fast_model  # noqa: E402
from style_transfer.reco.model_utils import resolve_existing_reconet_model  # noqa: E402
from style_transfer.reco.reco_infer import stylize_video as reconet_stylize_video  # noqa: E402
from style_transfer.reco.style_catalog import resolve_style_model  # noqa: E402

STYLE_LAYER_ENDS = (2, 9, 16, 29)  # indices in the AdaIN encoder: relu1_1, relu2_1, relu3_1, relu4_1


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--content-dir", required=True, help="Folder of content photos (jpg/png).")
    p.add_argument("--style", action="append", required=True, help="style_id=path/to/painting.jpg (repeatable)")
    p.add_argument("--video", help="Optional clip for the temporal (TWE) comparison.")
    p.add_argument("--size", type=int, default=512, help="Inference long side for image metrics.")
    p.add_argument("--fps-iters", type=int, default=5)
    p.add_argument("--video-frames", type=int, default=48, help="Max frames used for TWE.")
    p.add_argument("--out", default=str(BACKEND / "evaluation" / "results"))
    return p.parse_args()


# ------------------------------------------------------------------ helpers ---
@torch.no_grad()
def style_distance(adain: AdaINModel, image_bgr: np.ndarray, style_bgr: np.ndarray, size: int) -> float:
    """Huang & Belongie style loss: Σ_layers ‖μ(φ(x))−μ(φ(s))‖₂ + ‖σ(φ(x))−σ(φ(s))‖₂."""

    def stats(img):
        h, w = img.shape[:2]
        x = bgr_to_tensor(img, fit_size(w, h, size), adain.device)
        out = []
        for i, layer in enumerate(adain.net.encoder):
            x = layer(x)
            if i in STYLE_LAYER_ENDS:
                out.append(calc_mean_std(x))
        return out

    total = 0.0
    for (m1, s1), (m2, s2) in zip(stats(image_bgr), stats(style_bgr)):
        total += float(torch.norm(m1 - m2)) + float(torch.norm(s1 - s2))
    return total


def timed(fn: Callable[[], np.ndarray], iters: int):
    out = fn()  # warm-up
    start = time.perf_counter()
    for _ in range(iters):
        out = fn()
    return out, iters / (time.perf_counter() - start)


def resize_long(img: np.ndarray, size: int) -> np.ndarray:
    h, w = img.shape[:2]
    return cv2.resize(img, fit_size(w, h, size, 8), interpolation=cv2.INTER_AREA)


def stylize_video_per_frame(src: Path, dst: Path, frame_fn: Callable[[np.ndarray], np.ndarray], max_frames: int) -> Path:
    cap = cv2.VideoCapture(str(src))
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    writer = None
    n = 0
    while n < max_frames + 1:
        ok, frame = cap.read()
        if not ok:
            break
        out = frame_fn(frame)
        if writer is None:
            # Lossless-ish intermediate so codec artefacts don't pollute TWE.
            writer = cv2.VideoWriter(str(dst), cv2.VideoWriter_fourcc(*"MJPG"), fps, (out.shape[1], out.shape[0]))
        writer.write(out)
        n += 1
    cap.release()
    if writer is not None:
        writer.release()
    return dst


def frame_std(path: Path, frames: int = 10) -> float:
    """Mean per-frame pixel standard deviation (detects collapsed models)."""
    cap = cv2.VideoCapture(str(path))
    stds = []
    while len(stds) < frames:
        ok, f = cap.read()
        if not ok:
            break
        stds.append(float(np.std(f)))
    cap.release()
    return float(np.mean(stds)) if stds else 0.0


# --------------------------------------------------------------------- main ---
def main():
    args = parse_args()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    out_dir = Path(args.out) / f"adain_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    out_dir.mkdir(parents=True, exist_ok=True)

    styles: Dict[str, np.ndarray] = {}
    for spec in args.style:
        sid, path = spec.split("=", 1)
        img = cv2.imread(path, cv2.IMREAD_COLOR)
        if img is None:
            raise SystemExit(f"Could not read style image {path}")
        styles[sid] = img
    contents = sorted(p for p in Path(args.content_dir).iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png"})
    if not contents:
        raise SystemExit("No content images found")

    adain = AdaINModel(device=device)
    fixed_models = {sid: load_fast_model(resolve_style_model(BACKEND, sid)[0]) for sid in styles}

    rows: List[Dict[str, object]] = []
    samples = []
    print(f"device={device.type}  contents={len(contents)}  styles={list(styles)}  size={args.size}")
    for cpath in contents:
        content = resize_long(cv2.imread(str(cpath), cv2.IMREAD_COLOR), args.size)
        for sid, style_img in styles.items():
            fixed = fixed_models[sid]
            style_feat = adain.encode_style(style_img)
            methods = {
                "fixed": lambda: stlye_transfer(model=fixed, content=content).clip(0, 255).astype("uint8"),
                "adain": lambda: adain.stylize(content, style_feat, alpha=1.0, max_side=args.size),
            }
            outs = {}
            for method, fn in methods.items():
                out, fps = timed(fn, args.fps_iters)
                if out.shape[:2] != content.shape[:2]:
                    out = cv2.resize(out, (content.shape[1], content.shape[0]), interpolation=cv2.INTER_AREA)
                outs[method] = out
                lp = maybe_compute_lpips(
                    cv2.cvtColor(content, cv2.COLOR_BGR2RGB), cv2.cvtColor(out, cv2.COLOR_BGR2RGB), device.type
                )
                row = {
                    "content": cpath.name,
                    "style": sid,
                    "method": method,
                    "fps": round(fps, 3),
                    "psnr": round(compute_psnr(content, out), 3),
                    "mae": round(compute_mae(content, out), 3),
                    "lpips": None if lp is None else round(lp, 4),
                    "style_distance": round(style_distance(adain, out, style_img, args.size), 4),
                }
                rows.append(row)
                print(f"  {cpath.name:<16} {sid:<13} {method:<6} fps={row['fps']:<7} psnr={row['psnr']:<7} "
                      f"mae={row['mae']:<7} lpips={row['lpips']} style_dist={row['style_distance']}")
            if len(samples) < 4:
                samples.append((cpath.name, sid, content, outs["fixed"], outs["adain"], style_img))

    # ---------------------------------------------------------------- video ---
    video_rows: List[Dict[str, object]] = []
    if args.video:
        clip = Path(args.video)
        sid, style_img = next(iter(styles.items()))
        fixed = fixed_models[sid]
        style_feat = adain.encode_style(style_img)
        tmp = Path(tempfile.mkdtemp())
        per_frame = {
            f"TransformerNet ({sid}), per-frame": lambda f: stlye_transfer(model=fixed, content=resize_long(f, 384)).clip(0, 255).astype("uint8"),
            "AdaIN (any style), per-frame": lambda f: adain.stylize(resize_long(f, 384), style_feat, 1.0, 384),
        }
        for name, fn in per_frame.items():
            dst = stylize_video_per_frame(clip, tmp / (name.split()[0] + ".avi"), fn, args.video_frames)
            m = temporal_metrics(clip, dst, args.video_frames)
            video_rows.append({"method": name, "twe_mae": m["temporal_warping_error_mae"], "pairs": m["pairs_evaluated"]})
        reco = resolve_existing_reconet_model(BACKEND)
        if reco:
            dst = tmp / "reconet.mp4"
            reconet_stylize_video(str(clip), str(dst), str(reco))
            m = temporal_metrics(clip, dst, args.video_frames)
            row = {"method": "ReCoNet (temporal training)", "twe_mae": m["temporal_warping_error_mae"], "pairs": m["pairs_evaluated"]}
            # A collapsed checkpoint outputs a near-constant image, which trivially scores ~0 TWE.
            std = frame_std(dst)
            if std < 5.0:
                row["note"] = f"DEGENERATE: output is near-constant (pixel std {std:.2f}); TWE not meaningful"
            video_rows.append(row)
        # Reference: flicker-free ground truth (the source clip against itself).
        m = temporal_metrics(clip, clip, args.video_frames)
        video_rows.append({"method": "Source clip (no stylization, reference)", "twe_mae": m["temporal_warping_error_mae"], "pairs": m["pairs_evaluated"]})
        for r in video_rows:
            r.setdefault("note", "")
            print(f"  TWE  {r['method']:<40} {r['twe_mae']:.3f}  ({r['pairs']} frame pairs) {r['note']}")

    # --------------------------------------------------------------- outputs ---
    summary = {}
    for method in ("fixed", "adain"):
        sel = [r for r in rows if r["method"] == method]
        avg = lambda k: None if any(r[k] is None for r in sel) else round(float(np.mean([r[k] for r in sel])), 4)  # noqa: E731
        summary[method] = {k: avg(k) for k in ("fps", "psnr", "mae", "lpips", "style_distance")}

    (out_dir / "results.json").write_text(json.dumps(
        {"device": device.type, "size": args.size, "summary": summary, "images": rows, "video": video_rows}, indent=2))
    with open(out_dir / "results.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    # comparison strip: content | fixed | adain | style
    strips = []
    for name, sid, c, fx, ad, st in samples:
        h = 220
        tiles = [cv2.resize(t, (int(t.shape[1] * h / t.shape[0]), h)) for t in (c, fx, ad, st)]
        strips.append(np.hstack(tiles))
    width = max(s.shape[1] for s in strips)
    grid = np.vstack([cv2.copyMakeBorder(s, 0, 6, 0, width - s.shape[1], cv2.BORDER_CONSTANT, value=(255, 255, 255)) for s in strips])
    cv2.imwrite(str(out_dir / "comparison.jpg"), grid, [cv2.IMWRITE_JPEG_QUALITY, 88])

    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        metrics = [k for k in ("fps", "psnr", "mae", "lpips", "style_distance") if summary["fixed"][k] is not None]
        fig, axes = plt.subplots(1, len(metrics) + (1 if video_rows else 0), figsize=(3.2 * (len(metrics) + 1), 3.2))
        for ax, k in zip(axes, metrics):
            ax.bar(["TransformerNet", "AdaIN"], [summary["fixed"][k], summary["adain"][k]], color=["#7c6dfa", "#34d399"])
            ax.set_title(k.upper().replace("_", " "))
        if video_rows:
            ax = axes[-1]
            vr = [r for r in video_rows if not r.get("note")]
            ax.barh([r["method"].split(",")[0].split(" (")[0] for r in vr], [r["twe_mae"] for r in vr], color="#f0b429")
            ax.set_title("TWE (lower = smoother)")
        fig.tight_layout()
        fig.savefig(out_dir / "charts.png", dpi=130)
    except Exception as exc:  # charts are optional
        print("charts skipped:", exc)

    def table(rs, keys):
        head = "".join(f"<th>{html.escape(k)}</th>" for k in keys)
        body = "".join("<tr>" + "".join(f"<td>{html.escape(str(r[k]))}</td>" for k in keys) + "</tr>" for r in rs)
        return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"

    summary_rows = [{"method": "TransformerNet (fixed)" if m == "fixed" else "AdaIN (arbitrary)", **v} for m, v in summary.items()]
    (out_dir / "report.html").write_text(f"""<!doctype html><meta charset="utf-8"><title>AdaIN evaluation</title>
<style>body{{font:14px system-ui;margin:24px;max-width:1100px}}table{{border-collapse:collapse;margin:8px 0 24px}}
td,th{{border:1px solid #ddd;padding:4px 8px;text-align:right}}th{{background:#f4f4f8}}img{{max-width:100%}}</style>
<h1>Arbitrary style transfer (AdaIN) vs fixed-style TransformerNet</h1>
<p>Device: {device.type} · inference size {args.size}px · {len(contents)} content images × {len(styles)} styles.
PSNR/MAE/LPIPS measure content preservation (vs the content photo). Style distance is the AdaIN style loss to the painting (lower = closer).
TWE is the optical-flow-aligned temporal warping error (lower = less flicker).</p>
<h2>Summary (averages)</h2>{table(summary_rows, ["method", "fps", "psnr", "mae", "lpips", "style_distance"])}
<img src="charts.png"><h2>Samples: content · TransformerNet · AdaIN · style image</h2><img src="comparison.jpg">
{"<h2>Temporal consistency</h2>" + table(video_rows, ["method", "twe_mae", "pairs", "note"]) if video_rows else ""}
<h2>All runs</h2>{table(rows, list(rows[0].keys()))}""")
    print(f"\nreport: {out_dir / 'report.html'}")


if __name__ == "__main__":
    main()

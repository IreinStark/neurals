"""
Re-measure temporal consistency (TWE) for every style model, with the corrected metric.

For each clip and each style it compares:
  per-frame   : stylize every frame independently (what GP1 shipped)
  stabilized  : the same frames + flow-guided temporal stabilization (style_transfer/temporal.py)
and reports TWE (optical-flow-aligned warping error, lower = less flicker) plus the style distance
to the painting (to show stabilization keeps the style). Reference rows: the unstylized clip (the
floor the metric can reach) and the ReCoNet checkpoint (flagged if its output is degenerate).

Usage:
  python scripts/evaluate_temporal.py --clip pan=<pan.mp4> --clip zoom=<zoom.mp4> \
      [--adain-style starry-night=<starry.jpg>] [--size 384] [--frames 40]
Writes results.json / results.csv / charts.png / report.html into evaluation/results/temporal_<ts>/.
"""
from __future__ import annotations

import argparse
import csv
import html
import json
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Callable, Dict, List

import cv2
import numpy as np
import torch

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND / "scripts"))

from evaluate_adain import frame_std, style_distance  # noqa: E402
from evaluate_style_transfer import temporal_metrics  # noqa: E402
from style_transfer.adain.inference import AdaINModel, fit_size  # noqa: E402
from style_transfer.fast_style.api import stlye_transfer  # noqa: E402
from style_transfer.fast_style.stylize import load_model as load_fast_model  # noqa: E402
from style_transfer.reco.model_utils import resolve_existing_reconet_model  # noqa: E402
from style_transfer.reco.reco_infer import stylize_video as reconet_stylize_video  # noqa: E402
from style_transfer.reco.style_catalog import STYLE_MODEL_CANDIDATES, resolve_style_model  # noqa: E402
from style_transfer.temporal import TemporalStabilizer  # noqa: E402


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--clip", action="append", required=True, help="name=path.mp4 (repeatable)")
    p.add_argument("--adain-style", action="append", default=[], help="label=painting.jpg (repeatable)")
    p.add_argument("--style-ref", action="append", default=[], help="TransformerNet style_id=painting.jpg, enables style distance")
    p.add_argument("--styles", default=",".join(STYLE_MODEL_CANDIDATES), help="TransformerNet style ids")
    p.add_argument("--size", type=int, default=384)
    p.add_argument("--frames", type=int, default=40)
    p.add_argument("--blend", type=float, default=0.7)
    p.add_argument("--out", default=str(BACKEND / "evaluation" / "results"))
    return p.parse_args()


def read_frames(path: str, size: int, limit: int) -> List[np.ndarray]:
    cap = cv2.VideoCapture(path)
    out = []
    while len(out) < limit + 1:
        ok, f = cap.read()
        if not ok:
            break
        h, w = f.shape[:2]
        out.append(cv2.resize(f, fit_size(w, h, size, 8), interpolation=cv2.INTER_AREA))
    cap.release()
    return out


def write_clip(frames: List[np.ndarray], path: Path, fps: float = 20.0) -> Path:
    h, w = frames[0].shape[:2]
    wr = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), fps, (w, h))  # near-lossless for metrics
    for f in frames:
        wr.write(f)
    wr.release()
    return path


def sharpness(img: np.ndarray) -> float:
    return float(cv2.Laplacian(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var())


MODES = {
    "per-frame": None,
    "stabilized (detail-preserving, default)": {"detail_sigma": 1.0},
    "stabilized (full-frame blend)": {"detail_sigma": 0.0},
}


def main():
    args = parse_args()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    out_dir = Path(args.out) / f"temporal_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp())
    adain = AdaINModel(device=device)

    methods: Dict[str, Callable[[np.ndarray], np.ndarray]] = {}
    style_refs: Dict[str, np.ndarray] = {}
    for spec in args.style_ref:
        sid, path = spec.split("=", 1)
        style_refs[f"TransformerNet · {sid}"] = cv2.imread(path, cv2.IMREAD_COLOR)
    for sid in [s for s in args.styles.split(",") if s]:
        try:
            model = load_fast_model(resolve_style_model(BACKEND, sid)[0])
        except Exception as exc:
            print(f"skip {sid}: {exc}")
            continue
        methods[f"TransformerNet · {sid}"] = (lambda m: lambda f: stlye_transfer(model=m, content=f).clip(0, 255).astype("uint8"))(model)
    for spec in args.adain_style:
        label, path = spec.split("=", 1)
        img = cv2.imread(path, cv2.IMREAD_COLOR)
        feat = adain.encode_style(img)
        style_refs[f"AdaIN · {label}"] = img
        methods[f"AdaIN · {label}"] = (lambda ft: lambda f: adain.stylize(f, ft, 1.0, args.size))(feat)

    rows: List[Dict[str, object]] = []
    strips = []
    for spec in args.clip:
        clip_name, clip_path = spec.split("=", 1)
        frames = read_frames(clip_path, args.size, args.frames)
        src = write_clip(frames, tmp / f"{clip_name}_src.avi")
        ref = temporal_metrics(src, src, args.frames)["temporal_warping_error_mae"]
        rows.append({"clip": clip_name, "method": "Source clip (reference floor)", "mode": "-", "twe": round(ref, 3),
                     "twe_reduction_pct": None, "style_distance": None, "style_change_pct": None, "sharpness_pct": None, "note": ""})
        print(f"[{clip_name}] {len(frames)} frames, reference TWE {ref:.3f}")
        mid = len(frames) // 2
        for name, fn in methods.items():
            per = [fn(f) for f in frames]
            base = {}
            strip = [frames[mid]]
            for mode, cfg in MODES.items():
                if cfg is None:
                    outs = per
                else:
                    stab = TemporalStabilizer(blend=args.blend, **cfg)
                    outs = [stab.step(c, x) for c, x in zip(frames, per)]
                twe = temporal_metrics(src, write_clip(outs, tmp / "o.avi"), args.frames)["temporal_warping_error_mae"]
                sd = None
                if name in style_refs:
                    sd = float(np.mean([style_distance(adain, outs[i], style_refs[name], args.size) for i in (mid // 2, mid, len(outs) - 1)]))
                sh = float(np.mean([sharpness(o) for o in outs[mid:]]))
                if cfg is None:
                    base = {"twe": twe, "sd": sd, "sh": sh}
                row = {
                    "clip": clip_name, "method": name, "mode": mode, "twe": round(twe, 3),
                    "twe_reduction_pct": None if cfg is None else round(100 * (1 - twe / base["twe"]), 1),
                    "style_distance": None if sd is None else round(sd, 2),
                    "style_change_pct": None if (cfg is None or sd is None) else round(100 * (sd / base["sd"] - 1), 1),
                    "sharpness_pct": None if cfg is None else round(100 * sh / base["sh"], 1),
                    "note": "",
                }
                rows.append(row)
                strip.append(outs[mid])
                print(f"  {name:<30} {mode:<42} TWE {twe:7.3f}  " + ("" if cfg is None else
                      f"(-{row['twe_reduction_pct']}%, sharpness {row['sharpness_pct']}%"
                      + (f", style {row['style_change_pct']:+}%" if row['style_change_pct'] is not None else "") + ")"))
            if len(strips) < 3 and name in style_refs:
                strips.append(np.hstack(strip))

        reco = resolve_existing_reconet_model(BACKEND)
        if reco:
            dst = tmp / "reco.mp4"
            reconet_stylize_video(str(src), str(dst), str(reco))
            twe = temporal_metrics(src, dst, args.frames)["temporal_warping_error_mae"]
            std = frame_std(dst)
            note = f"DEGENERATE checkpoint: near-constant output (pixel std {std:.2f}); TWE not meaningful" if std < 5 else ""
            rows.append({"clip": clip_name, "method": "ReCoNet (repo checkpoint)", "mode": "-", "twe": round(twe, 3), "twe_reduction_pct": None,
                         "style_distance": None, "style_change_pct": None, "sharpness_pct": None, "note": note})
            print(f"  ReCoNet: TWE {twe:.3f} {note}")

    def agg(mode, key):
        vals = [r[key] for r in rows if r["mode"] == mode and r[key] is not None]
        return round(float(np.mean(vals)), 2) if vals else None

    summary = {"clips": [c.split("=")[0] for c in args.clip], "methods": len(methods), "blend": args.blend, "device": device.type}
    for mode in MODES:
        summary[mode] = {k: agg(mode, k) for k in ("twe", "twe_reduction_pct", "style_change_pct", "sharpness_pct")}
    print("\nSUMMARY", json.dumps(summary, indent=1))

    (out_dir / "results.json").write_text(json.dumps({"summary": summary, "rows": rows}, indent=2))
    with open(out_dir / "results.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    if strips:
        cv2.imwrite(str(out_dir / "frames.jpg"), np.vstack(strips), [cv2.IMWRITE_JPEG_QUALITY, 88])

    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        clips = summary["clips"]
        names = list(methods)
        colors = {"per-frame": "#f87171", "stabilized (detail-preserving, default)": "#34d399", "stabilized (full-frame blend)": "#93c5fd"}
        fig, axes = plt.subplots(1, len(clips), figsize=(7.5 * len(clips), 0.55 * len(names) + 2), squeeze=False)
        for ax, clip in zip(axes[0], clips):
            y = np.arange(len(names))
            for k, mode in enumerate(MODES):
                vals = [next(r["twe"] for r in rows if r["clip"] == clip and r["method"] == n and r["mode"] == mode) for n in names]
                ax.barh(y + (1 - k) * 0.27, vals, 0.27, label=mode, color=colors[mode])
            floor = next(r["twe"] for r in rows if r["clip"] == clip and r["method"].startswith("Source"))
            ax.axvline(floor, color="#555", ls="--", lw=1, label="unstylized clip")
            ax.set_yticks(y, names, fontsize=8)
            ax.set_title(f"TWE on '{clip}' clip (lower = less flicker)")
            ax.legend(fontsize=7)
        fig.tight_layout()
        fig.savefig(out_dir / "charts.png", dpi=130)
    except Exception as exc:
        print("charts skipped:", exc)

    keys = list(rows[0].keys())
    table = "<table><tr>" + "".join(f"<th>{k}</th>" for k in keys) + "</tr>" + "".join(
        "<tr>" + "".join(f"<td>{html.escape('' if r[k] is None else str(r[k]))}</td>" for k in keys) + "</tr>" for r in rows) + "</table>"
    srows = "".join(f"<tr><td>{m}</td>" + "".join(f"<td>{'' if v is None else v}</td>" for v in summary[m].values()) + "</tr>" for m in MODES)
    (out_dir / "report.html").write_text(f"""<!doctype html><meta charset="utf-8"><title>Temporal consistency</title>
<style>body{{font:14px system-ui;margin:24px;max-width:1200px}}table{{border-collapse:collapse;margin-bottom:20px}}td,th{{border:1px solid #ddd;padding:4px 8px}}th{{background:#f4f4f8}}img{{max-width:100%}}</style>
<h1>Temporal consistency: per-frame vs flow-guided stabilization</h1>
<p>{len(methods)} style methods × {len(summary['clips'])} clips · {args.frames} frame pairs · blend λ={args.blend} · device {device.type}.
TWE = optical-flow-aligned warping error (lower = less flicker). Sharpness % and style change % are relative to per-frame
(full-frame blending lowers TWE partly by blurring the texture — compare its sharpness and style change).</p>
<table><tr><th>mode</th><th>mean TWE</th><th>TWE reduction %</th><th>style distance change %</th><th>sharpness kept %</th></tr>{srows}</table>
<img src="charts.png"><h2>Middle frame: content · per-frame · detail-preserving · full-frame blend</h2><img src="frames.jpg"><h2>All results</h2>{table}""")
    print("report:", out_dir / "report.html")


if __name__ == "__main__":
    main()

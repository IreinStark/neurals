"""
Temporal fine-tuning of a trained TransformerNet with ReCoNet's temporal losses (Gao et al. 2018).

Why this instead of training ReCoNet from scratch: the repo's `reconet.pth` is effectively untrained
(weights ≈ initialisation, output ≈ constant grey), and from-scratch training needs FlyingChairs/Sintel
and a GPU. ReCoNet's encoder/decoder is the same Johnson-style network as our TransformerNet, so we
start from a trained style (e.g. starry-night) and add ReCoNet's temporal objectives:

  * output-level temporal loss with luminance term (ReCoNet eq. 4):
        M ⊙ ‖ (O_t − W(O_{t−1})) − (Y(I_t) − Y(W(I_{t−1}))) ‖²
  * feature-level temporal loss on the encoder output (ReCoNet eq. 3):
        M↓ ⊙ ‖ F_t − W↓(F_{t−1}) ‖²
  * style preservation: the frozen original network is a teacher. Perceptual (VGG relu2_1/relu3_1)
    and Gram (relu1_1–relu4_1) losses keep the student's look close to the teacher's.

Frame pairs are synthetic: a random photo crop and the same scene after a small random camera motion
(translation / rotation / zoom) plus sensor noise and exposure jitter, so the optical flow and occlusion
mask are known exactly. Noise between frames is what makes per-frame networks flicker.

Usage:
  python scripts/train_temporal.py --style starry-night --images DIR [--images DIR ...] --iters 2000
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import torch
import torch.nn.functional as F

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from style_transfer.adain.net import build_encoder  # noqa: E402
from style_transfer.fast_style.transformer import TransformerNetwork  # noqa: E402
from style_transfer.reco.style_catalog import resolve_style_model  # noqa: E402

VGG_TAPS = {3: "relu1_1", 10: "relu2_1", 17: "relu3_1", 30: "relu4_1"}
SKIP_WORDS = ("digits", "sudoku", "text", "logo", "chess", "gradient", "depth", "ellipses", "ml.png", "letter",
              "starry", "blob", "pca", "board", "cards", "page", "phantom", "coins", "binary", "GT", "tmpl", "_bugy")


# ---------------------------------------------------------------- data

def collect_images(dirs, min_side=200):
    imgs = []
    for d in dirs:
        for p in sorted(Path(d).rglob("*")):
            if p.suffix.lower() not in (".jpg", ".jpeg", ".png") or any(w in p.name for w in SKIP_WORDS):
                continue
            im = cv2.imread(str(p), cv2.IMREAD_COLOR)
            if im is None or min(im.shape[:2]) < min_side or float(im.std()) < 20:
                continue
            imgs.append(im)
    return imgs


def random_pair(imgs, size, rng):
    """Returns I1, I2 (BGR 0–255 float tensors 3×H×W), backward flow 2→1 (2×H×W, pixels), mask (1×H×W)."""
    src = imgs[rng.randrange(len(imgs))]
    h, w = src.shape[:2]
    scale = rng.uniform(size * 1.15 / min(h, w), max(size * 1.15 / min(h, w), 1.0))
    src = cv2.resize(src, (max(size + 40, int(w * scale)), max(size + 40, int(h * scale))), interpolation=cv2.INTER_AREA)
    if rng.random() < 0.5:
        src = src[:, ::-1]
    h, w = src.shape[:2]
    y0, x0 = rng.randrange(0, h - size - 20 + 1), rng.randrange(0, w - size - 20 + 1)
    y0, x0 = y0 + 10, x0 + 10

    # camera motion in crop coordinates: p (frame 2) shows source content at T(p) (frame-1 coords)
    ang = math.radians(rng.uniform(-2.5, 2.5))
    s = rng.uniform(0.96, 1.04)
    tx, ty = rng.uniform(-8, 8), rng.uniform(-8, 8)
    c = (size - 1) / 2
    gy, gx = np.mgrid[0:size, 0:size].astype(np.float32)
    dx, dy = gx - c, gy - c
    tx_map = s * (math.cos(ang) * dx - math.sin(ang) * dy) + c + tx
    ty_map = s * (math.sin(ang) * dx + math.cos(ang) * dy) + c + ty

    src_f = src.astype(np.float32)
    i1 = src_f[y0:y0 + size, x0:x0 + size]
    i2 = cv2.remap(src_f, tx_map + x0, ty_map + y0, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    flow = np.stack([tx_map - gx, ty_map - gy])
    mask = ((tx_map >= 0) & (tx_map <= size - 1) & (ty_map >= 0) & (ty_map <= size - 1)).astype(np.float32)[None]

    # sensor noise + exposure jitter, independently per frame
    def jitter(im):
        im = im * rng.uniform(0.97, 1.03) + rng.uniform(-4, 4)
        return np.clip(im + np.random.normal(0, rng.uniform(1.0, 4.0), im.shape).astype(np.float32), 0, 255)

    t = lambda a: torch.from_numpy(np.ascontiguousarray(a))  # noqa: E731
    return t(jitter(i1).transpose(2, 0, 1)), t(jitter(i2).transpose(2, 0, 1)), t(flow), t(mask)


# ---------------------------------------------------------------- model pieces

def warp(x, flow):
    """Backward warp: out(p) = x(p + flow(p)). flow in pixels, shape B×2×H×W."""
    b, _, h, w = x.shape
    gy, gx = torch.meshgrid(torch.arange(h, dtype=x.dtype), torch.arange(w, dtype=x.dtype), indexing="ij")
    px = (gx + flow[:, 0]) / (w - 1) * 2 - 1
    py = (gy + flow[:, 1]) / (h - 1) * 2 - 1
    return F.grid_sample(x, torch.stack([px, py], -1), mode="bilinear", padding_mode="border", align_corners=True)


def luminance(bgr):
    return (0.114 * bgr[:, 0:1] + 0.587 * bgr[:, 1:2] + 0.299 * bgr[:, 2:3])


class VGG(torch.nn.Module):
    def __init__(self):
        super().__init__()
        enc = build_encoder()
        enc.load_state_dict(torch.load(BACKEND / "models/adain/vgg_normalised_relu4_1.pth", map_location="cpu"))
        self.enc = enc.eval()
        for p in self.enc.parameters():
            p.requires_grad_(False)

    def forward(self, bgr255):
        x = bgr255.flip(1) / 255.0  # BGR 0–255 → RGB 0–1
        out = {}
        for i, layer in enumerate(self.enc):
            x = layer(x)
            if i in VGG_TAPS:
                out[VGG_TAPS[i]] = x
        return out


def gram(f):
    b, c, h, w = f.shape
    f = f.reshape(b, c, h * w)
    return f @ f.transpose(1, 2) / (c * h * w)


def run_with_features(net: TransformerNetwork, x):
    feats = net.ResidualBlock(net.ConvBlock(x))
    return net.DeconvBlock(feats), feats


# ---------------------------------------------------------------- training

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--style", default="starry-night")
    ap.add_argument("--images", action="append", required=True)
    ap.add_argument("--iters", type=int, default=2000)
    ap.add_argument("--size", type=int, default=192)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--w-out", type=float, default=1.0, help="output temporal loss weight (relative)")
    ap.add_argument("--w-feat", type=float, default=0.5, help="feature temporal loss weight (relative)")
    ap.add_argument("--w-style", type=float, default=100.0, help="Gram loss weight (on relative error)")
    ap.add_argument("--w-perc", type=float, default=100.0, help="perceptual loss weight (on relative error)")
    ap.add_argument("--out", default=str(BACKEND / "models/temporal"))
    ap.add_argument("--save-every", type=int, default=250)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    torch.set_num_threads(max(1, os.cpu_count() or 1))
    rng = random.Random(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    imgs = collect_images(args.images)
    print(f"{len(imgs)} training photos")
    teacher_path = resolve_style_model(BACKEND, args.style)[0]
    teacher = TransformerNetwork()
    teacher.load_state_dict(torch.load(teacher_path, map_location="cpu"))
    teacher.eval().requires_grad_(False)
    student = TransformerNetwork()
    student.load_state_dict(torch.load(teacher_path, map_location="cpu"))
    student.train()
    vgg = VGG()
    opt = torch.optim.Adam(student.parameters(), lr=args.lr)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    log_path = out_dir / f"{args.style}_train_log.jsonl"
    log = open(log_path, "w")
    norms = None
    t0 = time.time()

    for it in range(1, args.iters + 1):
        i1, i2, flow, mask = random_pair(imgs, args.size, rng)
        i1, i2, flow, mask = i1[None], i2[None], flow[None], mask[None]
        x = torch.cat([i1, i2])

        with torch.no_grad():
            t_out = teacher(x)
            t_feat = vgg(t_out)
            t_gram = {k: gram(v) for k, v in t_feat.items()}

        s_out, s_res = run_with_features(student, x)
        s_feat = vgg(s_out)
        o1, o2 = s_out[0:1], s_out[1:2]

        # ReCoNet output temporal loss with luminance term
        d_out = o2 - warp(o1, flow)
        d_in = luminance(i2) - luminance(warp(i1, flow))
        l_out = (mask * (d_out - d_in) ** 2).sum() / (mask.sum() * 3 + 1e-6)

        # ReCoNet feature temporal loss at encoder resolution (1/4)
        fh, fw = s_res.shape[-2:]
        flow_s = F.interpolate(flow, size=(fh, fw), mode="bilinear", align_corners=True) * (fw / flow.shape[-1])
        mask_s = (F.interpolate(mask, size=(fh, fw), mode="bilinear", align_corners=True) > 0.99).float()
        d_f = s_res[1:2] - warp(s_res[0:1], flow_s)
        l_feat = (mask_s * d_f ** 2).sum() / (mask_s.sum() * d_f.shape[1] + 1e-6)

        # style preservation vs. the frozen teacher
        # relative errors: 0.01 = features/Grams off by 1% of their energy
        l_perc = sum(F.mse_loss(s_feat[k], t_feat[k]) / t_feat[k].pow(2).mean() for k in ("relu2_1", "relu3_1"))
        l_gram = sum(F.mse_loss(gram(s_feat[k]), t_gram[k]) / t_gram[k].pow(2).mean() for k in VGG_TAPS.values())

        if norms is None:  # temporal terms are normalised by the teacher's own (flickery) level at the start
            norms = {"out": max(float(l_out), 1e-6), "feat": max(float(l_feat), 1e-6)}
            print("initial temporal loss scales", {k: f"{v:.4g}" for k, v in norms.items()})
        loss = (args.w_perc * l_perc + args.w_style * l_gram
                + args.w_out * l_out / norms["out"] + args.w_feat * l_feat / norms["feat"])

        opt.zero_grad()
        loss.backward()
        opt.step()

        rec = {"it": it, "loss": float(loss), "out_temporal": float(l_out), "feat_temporal": float(l_feat),
               "perceptual": float(l_perc), "gram": float(l_gram), "sec": round(time.time() - t0, 1)}
        log.write(json.dumps(rec) + "\n")
        log.flush()
        if it % 25 == 0 or it == 1:
            print(f"[{it}/{args.iters}] loss {rec['loss']:.3f}  out-temporal {l_out:.2f}  feat-temporal {l_feat:.4f}  "
                  f"perc {l_perc:.4f}  gram {l_gram:.4f}  ({rec['sec']}s)", flush=True)
        if it % args.save_every == 0 or it == args.iters:
            torch.save(student.state_dict(), out_dir / f"{args.style}_temporal_it{it}.pth")
            torch.save(student.state_dict(), out_dir / f"{args.style}_temporal.pth")
    log.close()
    print("done:", out_dir / f"{args.style}_temporal.pth")


if __name__ == "__main__":
    main()

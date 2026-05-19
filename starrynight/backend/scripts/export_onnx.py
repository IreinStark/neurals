#!/usr/bin/env python3
"""
Export all TransformerNetwork style checkpoints to ONNX for browser inference.

Usage:
    cd starrynight/backend
    python scripts/export_onnx.py

Outputs one .onnx file per style into frontend/public/models/.
"""
from __future__ import annotations

import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = SCRIPT_DIR.parent
REPO_DIR = BACKEND_DIR.parent
MODELS_OUTPUT_DIR = REPO_DIR / "frontend" / "public" / "models"

sys.path.insert(0, str(BACKEND_DIR))

import torch
from style_transfer.fast_style.transformer import TransformerNetwork
from style_transfer.reco.style_catalog import STYLE_MODEL_CANDIDATES

# 320x180 is 16:9 half-HD — fast in browser while showing clear style
EXPORT_H = 180
EXPORT_W = 320


def load_transformer(pth_path: Path) -> TransformerNetwork:
    net = TransformerNetwork()
    state = torch.load(str(pth_path), map_location="cpu")
    # strip DataParallel 'module.' prefix if present
    if any(k.startswith("module.") for k in state):
        state = {k[len("module."):]: v for k, v in state.items()}
    net.load_state_dict(state)
    net.eval()
    return net


def export_style(style_id: str, pth_path: Path, out_dir: Path) -> Path:
    net = load_transformer(pth_path)
    dummy = torch.zeros(1, 3, EXPORT_H, EXPORT_W)
    out_path = out_dir / f"{style_id}.onnx"
    torch.onnx.export(
        net,
        dummy,
        str(out_path),
        input_names=["input"],
        output_names=["output"],
        opset_version=11,
        do_constant_folding=True,
        dynamic_axes={
            "input": {2: "height", 3: "width"},
            "output": {2: "height", 3: "width"},
        },
    )
    return out_path


def main() -> None:
    MODELS_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    passed, failed = 0, 0

    for style_id, candidates in STYLE_MODEL_CANDIDATES.items():
        resolved = None
        for parts in candidates:
            candidate = (BACKEND_DIR / Path(*parts)).resolve()
            if candidate.exists() and candidate.stat().st_size > 1024:
                resolved = candidate
                break

        if resolved is None:
            print(f"  SKIP  {style_id}  (no checkpoint found)")
            failed += 1
            continue

        print(f"  Exporting {style_id}  ← {resolved.name} ...", end=" ", flush=True)
        try:
            out_path = export_style(style_id, resolved, MODELS_OUTPUT_DIR)
            size_mb = out_path.stat().st_size / (1024 * 1024)
            print(f"OK  ({size_mb:.1f} MB)  → {out_path.name}")
            passed += 1
        except Exception as exc:
            print(f"FAILED  ({exc})")
            failed += 1

    print()
    print(f"Exported {passed} / {passed + failed} styles to {MODELS_OUTPUT_DIR}")
    if failed:
        print(f"  {failed} style(s) skipped — add checkpoints and re-run.")


if __name__ == "__main__":
    main()

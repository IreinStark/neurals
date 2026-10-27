"""
Export AdaIN to ONNX for in-browser arbitrary style transfer (style-preview-worker).

Graph contract (matches the TransformerNet models' 0–255 convention):
  inputs : content [1,3,H,W] float32 0–255   (H, W multiples of 8)
           style   [1,3,Hs,Ws] float32 0–255
           alpha   [1] float32 in [0, 1]      (content ↔ style feature blend)
  output : output  [1,3,H,W] float32 0–255   (clamped)

Usage:  python scripts/export_adain_onnx.py  [--out ../frontend/public/models/adain.onnx]
"""
import argparse
import sys
from pathlib import Path

import numpy as np
import torch
from torch import nn

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from style_transfer.adain.inference import AdaINModel  # noqa: E402
from style_transfer.adain.net import adaptive_instance_norm  # noqa: E402


class AdaINExport(nn.Module):
    def __init__(self, net):
        super().__init__()
        self.encoder, self.decoder = net.encoder, net.decoder

    def forward(self, content, style, alpha):
        cf = self.encoder(content / 255.0)
        sf = self.encoder(style / 255.0)
        a = alpha.reshape(1, 1, 1, 1)
        t = a * adaptive_instance_norm(cf, sf) + (1.0 - a) * cf
        out = self.decoder(t)[:, :, : content.shape[2], : content.shape[3]]
        return (out * 255.0).clamp(0.0, 255.0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(BACKEND.parent / "frontend" / "public" / "models" / "adain.onnx"))
    args = parser.parse_args()

    model = AdaINExport(AdaINModel(device=torch.device("cpu")).net).eval()
    content = torch.rand(1, 3, 128, 160) * 255
    style = torch.rand(1, 3, 96, 96) * 255
    alpha = torch.tensor([0.8])
    torch.onnx.export(
        model,
        (content, style, alpha),
        args.out,
        input_names=["content", "style", "alpha"],
        output_names=["output"],
        opset_version=17,
        do_constant_folding=True,
        dynamic_axes={
            "content": {2: "height", 3: "width"},
            "style": {2: "style_height", 3: "style_width"},
            "output": {2: "height", 3: "width"},
        },
    )

    # Verify against PyTorch at a different size than the trace.
    import onnxruntime as ort

    sess = ort.InferenceSession(args.out, providers=["CPUExecutionProvider"])
    c = torch.rand(1, 3, 200, 264) * 255
    s = torch.rand(1, 3, 120, 176) * 255
    a = torch.tensor([1.0])
    with torch.no_grad():
        ref = model(c, s, a).numpy()
    got = sess.run(None, {"content": c.numpy(), "style": s.numpy(), "alpha": a.numpy()})[0]
    err = float(np.abs(ref - got).max())
    print(f"exported {args.out}  shape={got.shape}  max|torch-onnx|={err:.4f}")
    if got.shape != ref.shape or err > 1.0:
        raise SystemExit("ONNX output does not match PyTorch")


if __name__ == "__main__":
    main()

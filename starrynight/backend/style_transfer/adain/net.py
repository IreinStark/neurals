"""
AdaIN network (Huang & Belongie, "Arbitrary Style Transfer in Real-time with Adaptive
Instance Normalization", ICCV 2017).

Layer layout matches the reference PyTorch implementation (naoto0804/pytorch-AdaIN, MIT
licence) so its pretrained weights load directly. Only the VGG-19 layers up to relu4_1
are kept: that is all the encoder uses, and it cuts the checkpoint from 80 MB to ~14 MB.
"""
import torch
from torch import nn

EPS = 1e-5


def build_encoder() -> nn.Sequential:
    """VGG-19 (normalised) up to relu4_1. Input: RGB in [0, 1]."""
    def block(cin, cout):
        return [nn.ReflectionPad2d((1, 1, 1, 1)), nn.Conv2d(cin, cout, (3, 3)), nn.ReLU()]

    pool = lambda: nn.MaxPool2d((2, 2), (2, 2), (0, 0), ceil_mode=True)  # noqa: E731
    return nn.Sequential(
        nn.Conv2d(3, 3, (1, 1)),
        *block(3, 64), *block(64, 64), pool(),                                   # relu1_1, relu1_2
        *block(64, 128), *block(128, 128), pool(),                               # relu2_1, relu2_2
        *block(128, 256), *block(256, 256), *block(256, 256), *block(256, 256), pool(),  # relu3_x
        *block(256, 512),                                                        # relu4_1
    )


def build_decoder() -> nn.Sequential:
    """Mirror of the encoder; maps relu4_1 features back to RGB in ~[0, 1]."""
    def block(cin, cout, relu=True):
        layers = [nn.ReflectionPad2d((1, 1, 1, 1)), nn.Conv2d(cin, cout, (3, 3))]
        return layers + ([nn.ReLU()] if relu else [])

    up = lambda: nn.Upsample(scale_factor=2, mode="nearest")  # noqa: E731
    return nn.Sequential(
        *block(512, 256), up(),
        *block(256, 256), *block(256, 256), *block(256, 256), *block(256, 128), up(),
        *block(128, 128), *block(128, 64), up(),
        *block(64, 64), *block(64, 3, relu=False),
    )


def calc_mean_std(feat: torch.Tensor, eps: float = EPS):
    n, c = feat.shape[:2]
    flat = feat.reshape(n, c, -1)
    mean = flat.mean(dim=2).reshape(n, c, 1, 1)
    std = (flat.var(dim=2) + eps).sqrt().reshape(n, c, 1, 1)
    return mean, std


def adaptive_instance_norm(content_feat: torch.Tensor, style_feat: torch.Tensor) -> torch.Tensor:
    """AdaIN(x, y) = σ(y) · (x − μ(x)) / σ(x) + μ(y), per channel."""
    c_mean, c_std = calc_mean_std(content_feat)
    s_mean, s_std = calc_mean_std(style_feat)
    return (content_feat - c_mean) / c_std * s_std + s_mean


class AdaINNet(nn.Module):
    """content, style in [0, 1] → stylised image in [0, 1]. `alpha` blends content↔style features."""

    def __init__(self):
        super().__init__()
        self.encoder = build_encoder()
        self.decoder = build_decoder()

    def encode(self, x: torch.Tensor) -> torch.Tensor:
        return self.encoder(x)

    def decode_from(self, content_feat: torch.Tensor, style_feat: torch.Tensor, alpha: float) -> torch.Tensor:
        t = adaptive_instance_norm(content_feat, style_feat)
        t = alpha * t + (1.0 - alpha) * content_feat
        return self.decoder(t)

    def forward(self, content: torch.Tensor, style: torch.Tensor, alpha: float = 1.0) -> torch.Tensor:
        return self.decode_from(self.encode(content), self.encode(style), alpha)

# Temporal consistency: findings, fix and re-measurement (GP2)

Results: `backend/evaluation/results/temporal_20261027_090100/` (`report.html`, `charts.png`, `frames.jpg`, `results.csv`).
Reproduce: `python scripts/evaluate_temporal.py --clip pan=pan.mp4 --clip zoom=zoom.mp4 --adain-style starry-night=starry.jpg --adain-style wave=wave.jpg --style-ref starry-night=starry.jpg --style-ref wave=wave.jpg --size 384 --frames 40`

## 1. Two problems in the GP1 evaluation

**The ReCoNet checkpoint is degenerate.** `reconet.pth` loads with every weight matched, but it outputs a
near-constant grey frame (≈127, pixel std 1.2) for *any* input. A constant video has no flicker, so it gets
a near-zero warping error (TWE 0.039 here). The GP1 headline result (TWE 0.0149, "3.4× better") came from
this output, so it does not show temporal consistency. The evaluation scripts now detect the case
(`frame_std < 5`) and flag the row as *DEGENERATE*. A properly trained ReCoNet (plan task T5.1) is still needed.

**The TWE metric warped in the wrong direction.** It warped with forward flow (prev→next) through
`cv2.remap`, which needs backward flow. With the bug, warping scored *worse* than not warping at all
(25.1 vs 21.7 on the unstylized clip). With backward flow (next→prev) the unstylized clips score 0.4 to 3.9 (warping now helps, as it should).
This is fixed in `scripts/evaluate_style_transfer.py` and covered by `style_transfer/tests/test_temporal_metric.py`.
Every TWE number in the GP1 report has to be re-measured.

## 2. Fix without retraining: flow-guided stabilization

`style_transfer/temporal.py` → `TemporalStabilizer`, on by default in both video jobs (`temporal=false` turns it off).

    O_t = G_σ * [M ⊙ (λ W(O_{t−1}) + (1−λ) S_t) + (1−M) ⊙ S_t]  +  (S_t − G_σ * S_t)

- W: the previous *output*, warped with backward Farneback flow computed on the content frames.
- M: a forward–backward consistency mask, so occluded or newly revealed pixels take the fresh frame and leave no trails.
- λ = 0.7.
- Detail preservation, σ = 1: only low frequencies are blended over time, and the current frame's fine texture is kept.
  Plain full-frame blending lowers TWE more, but only by blurring. Sharpness falls to about 40%, and AdaIN's
  style distance rises by up to +180%. That reads as "less flicker" but it is really a loss of style.

## 3. Re-measured results (9 style methods × 2 clips, 40 frame pairs, CPU)

| Mode | Mean TWE ↓ | TWE reduction | Style distance change | Sharpness kept |
|---|---|---|---|---|
| Per-frame (no temporal handling) | 11.24 | — | — | 100% |
| **Stabilized, detail-preserving (default)** | **8.08** | **−29%** | +3.9% (mean) | **91%** |
| Stabilized, full-frame blend | 4.59 | −55% | +60% | 41% |
| Unstylized source clip (reference) | 2.8–3.9 | | | |
| ReCoNet repo checkpoint | 0.039 | flagged: degenerate | | |

Per method, the default mode reduces TWE by 11–41% (TransformerNet) and 27–40% (AdaIN).
The source clip is a reference, not a hard floor. Smoothed outputs with low texture (udnie, lazy) can score below it.

Remaining flicker comes from fine brush texture changing frame to frame. Inference-time smoothing can't
remove it without blurring the image. That needs a temporally trained network (ReCoNet with a working checkpoint).

## 4. Text for the report (replaces the GP1 temporal claim)

> **Evaluation validity.** Re-examining the GP1 temporal evaluation found two problems. (1) The trained ReCoNet
> checkpoint outputs a near-constant image regardless of input. Its very low warping error (0.0149) therefore reflects
> the absence of content, not temporal consistency, and the "3.4× better" claim is withdrawn. (2) The temporal warping
> error implementation used the forward optical flow with a backward-mapping warp. The corrected metric uses backward
> flow and is validated by tests (warping now lowers the error on an unstylized clip instead of raising it).
> In GP2, temporal consistency is addressed at inference time with flow-guided, occlusion-aware, detail-preserving
> stabilization. Across 9 style models and 2 test clips it reduces TWE by 29% on average (11.24 → 8.08) while
> keeping 91% of the texture sharpness and changing style distance by about 4%. Retraining ReCoNet remains future work.

The design's Video Upload "Pipeline Info" card used to show "ReCoNet + Optical Flow" and "4.13 (3.4× better)".
It now shows the measured values.

## 5. Trial: temporal fine-tuning with ReCoNet's losses (negative result)

**Why.** The repo's `reconet.pth` can't be fixed, because it was never trained. Its weights are statistically
indistinguishable from PyTorch's random initialisation:
- conv std 0.038 vs 0.037 untrained;
- instance-norm scales ≈ 1.0, biases ≈ 0;
- the largest pre-tanh output for a 0–255 input is about 2.4, and `tanh(x/255)·150 + 127.5` maps that to flat grey.

The GP1 training script saves every 1,000 iterations on FlyingChairs. The committed file is an early save, and
no other version exists in any branch or in the team submission repo (`aiiotcenter/ai-driven-style-transfer-for-video`).

**What we tried** (`scripts/train_temporal.py`). ReCoNet's encoder and decoder are the same Johnson network as our
TransformerNet, so we warm-started from the trained starry-night model and fine-tuned with ReCoNet's temporal losses:
- the output temporal loss with its luminance term;
- the feature temporal loss on the encoder output.

A frozen copy of the original model acted as teacher (VGG perceptual + Gram loss) to keep the style. FlyingChairs
and Sintel can't be downloaded in our environment, so frame pairs were synthesized: photo crops with random camera
motion (±8 px, ±2.5°, ±4 % zoom), per-frame sensor noise and exposure jitter, giving an exact flow and occlusion mask.

**Results** (TWE, lower is better; same harness as §3):

| Model | Pan clip | Real camera clip (OpenCV `vtest.avi`) |
|---|---|---|
| starry-night (original) | 29.53 | 8.60 |
| + 500 steps, temporal weight 1×, lr 2e-4 | 29.44 (−0.3 %) | 8.54 (−0.8 %) |
| + 500 steps, temporal weight 10×, lr 5e-4 | 29.10 (−1.4 %) | 8.40 (−2.4 %) |
| original + inference-time stabilization (§2) | 23.56 (−20 %) | 7.06 (−18 %) |

**Conclusion.** On a 2-core CPU (~1.3 s/step) with synthetic motion, temporal training gives only a marginal
improvement. Inference-time flow-guided stabilization gives ten times more for free. A real ReCoNet needs GPU
training on an optical-flow video dataset (FlyingChairs/Sintel, tens of thousands of steps). That's GP2 future work;
the trainer script is ready for it (`--images` can point at extracted video frames, and the loss terms are
ReCoNet's). We didn't ship the fine-tuned checkpoint because its gain is within noise.

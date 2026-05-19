#!/usr/bin/env python3
"""
Verify that all expected model checkpoints are present and non-empty.

Usage:
    cd starrynight/backend
    python scripts/verify_models.py
"""
from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent

EXPECTED = {
    "ReCoNet (video)": [
        BACKEND_DIR / "style_transfer" / "reco" / "reconet.pth",
    ],
    "ONNX browser (pointilism)": [
        BACKEND_DIR.parent / "frontend" / "public" / "models" / "pointilism-10.onnx",
    ],
    "Starry Night": [
        BACKEND_DIR / "models" / "starry" / "starry80.pth",
        BACKEND_DIR / "models" / "starry" / "starry_dark.pth",
    ],
    "Mosaic": [
        BACKEND_DIR / "models" / "mosiac" / "mosaic_light.pth",
        BACKEND_DIR / "models" / "mosiac" / "mosaic_aggressive.pth",
    ],
    "Udnie": [
        BACKEND_DIR / "models" / "udnie_aggressive.pth",
    ],
    "Wave": [
        BACKEND_DIR / "models" / "wave" / "wave50.pth",
        BACKEND_DIR / "models" / "wave" / "wave100.pth",
        BACKEND_DIR / "models" / "wave" / "wave150.pth",
        BACKEND_DIR / "models" / "wave" / "wave200.pth",
    ],
    "Tokyo Ghoul": [
        BACKEND_DIR / "models" / "tokyo_ghoul" / "tokyo_ghoul_light.pth",
        BACKEND_DIR / "models" / "tokyo_ghoul" / "tokyo_ghoul_aggressive.pth",
    ],
    "Lazy Sunday": [
        BACKEND_DIR / "models" / "lazy" / "lazy250.pth",
    ],
    "Bayanihan": [
        BACKEND_DIR / "models" / "bayanihan100.pth",
    ],
}

MIN_SIZE_BYTES = 1024  # anything under 1 KB is considered corrupt / placeholder


def check() -> int:
    passed = 0
    failed = 0
    missing = 0

    print(f"Backend dir : {BACKEND_DIR}")
    print()

    for style, paths in EXPECTED.items():
        style_ok = True
        for path in paths:
            if not path.exists():
                print(f"  MISSING  {path.relative_to(BACKEND_DIR.parent)}")
                missing += 1
                style_ok = False
            elif path.stat().st_size < MIN_SIZE_BYTES:
                print(f"  CORRUPT  {path.relative_to(BACKEND_DIR.parent)}  ({path.stat().st_size} bytes)")
                failed += 1
                style_ok = False
            else:
                size_mb = path.stat().st_size / (1024 * 1024)
                print(f"  OK       {path.relative_to(BACKEND_DIR.parent)}  ({size_mb:.1f} MB)")
                passed += 1

        label = "PASS" if style_ok else "FAIL"
        print(f"  [{label}] {style}")
        print()

    total = passed + failed + missing
    print(f"Results: {passed}/{total} files OK, {missing} missing, {failed} corrupt")

    if missing or failed:
        print()
        print("Download missing checkpoints and place them at the paths shown above.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(check())

from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .model_utils import preferred_reconet_model_path, resolve_existing_reconet_model

DEFAULT_STYLE_ID = "starry-night"

STYLE_LABELS = {
    "starry-night": "Van Gogh - Starry Night",
    "mosaic": "Gaudi - Mosaic",
    "udnie": "Francis Picabia - Udnie",
    "candy": "Pop Art - Candy",
}


def _normalize_style_id(raw: str) -> str:
    return raw.strip().lower().replace("_", "-").replace(" ", "-")


def _label_for(style_id: str) -> str:
    return STYLE_LABELS.get(style_id, style_id.replace("-", " ").title())


def _load_env_style_paths() -> Dict[str, Path]:
    raw = os.environ.get("RECONET_STYLE_MODELS", "").strip()
    if not raw:
        return {}
    parsed: Dict[str, Path] = {}
    for pair in raw.split(","):
        if "=" not in pair:
            continue
        key, value = pair.split("=", 1)
        style_id = _normalize_style_id(key)
        model_path = Path(value.strip()).expanduser().resolve(strict=False)
        if style_id and value.strip():
            parsed[style_id] = model_path
    return parsed


def _scan_style_directory(base_dir: Path) -> Dict[str, Path]:
    style_dir = base_dir / "style_transfer" / "reco" / "styles"
    if not style_dir.exists() or not style_dir.is_dir():
        return {}
    found: Dict[str, Path] = {}
    for file_path in sorted(style_dir.glob("*.pth")):
        style_id = _normalize_style_id(file_path.stem)
        if style_id:
            found[style_id] = file_path.resolve(strict=False)
    return found


def style_model_map(base_dir: Path) -> Dict[str, Path]:
    model_map: Dict[str, Path] = {}

    # Default style always points at the canonical ReCoNet checkpoint.
    default_model = resolve_existing_reconet_model(base_dir)
    if default_model:
        model_map[DEFAULT_STYLE_ID] = Path(default_model).resolve(strict=False)

    # Optional additional styles discovered from directory/env.
    model_map.update(_scan_style_directory(base_dir))
    model_map.update(_load_env_style_paths())

    # If there is no resolved model at all yet, expose default expected path.
    if not model_map:
        model_map[DEFAULT_STYLE_ID] = Path(preferred_reconet_model_path(base_dir)).resolve(strict=False)

    return model_map


def available_styles(base_dir: Path) -> Tuple[List[Dict[str, str]], str]:
    mapped = style_model_map(base_dir)
    default_style = DEFAULT_STYLE_ID if DEFAULT_STYLE_ID in mapped else next(iter(mapped.keys()))

    styles: List[Dict[str, str]] = []
    for style_id, model_path in mapped.items():
        styles.append(
            {
                "id": style_id,
                "label": _label_for(style_id),
                "available": model_path.exists() and model_path.is_file() and model_path.stat().st_size > 0,
                "model_path": str(model_path),
            }
        )
    styles.sort(key=lambda item: (item["id"] != default_style, item["label"]))
    return styles, default_style


def resolve_style_model(base_dir: Path, style_id: Optional[str]) -> Tuple[str, str]:
    mapped = style_model_map(base_dir)
    normalized = _normalize_style_id(style_id or "")
    if not normalized:
        normalized = DEFAULT_STYLE_ID if DEFAULT_STYLE_ID in mapped else next(iter(mapped.keys()))

    if normalized not in mapped:
        valid = ", ".join(sorted(mapped.keys()))
        raise ValueError(f"Unknown style '{normalized}'. Available styles: {valid}")

    model_path = mapped[normalized]
    if not model_path.exists() or not model_path.is_file() or model_path.stat().st_size <= 0:
        raise FileNotFoundError(
            f"Style model for '{normalized}' is missing at: {model_path}"
        )

    return str(model_path), normalized

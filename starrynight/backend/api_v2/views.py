from pathlib import Path

from django.http import JsonResponse
from django.views.decorators.http import require_GET

from style_transfer.reco.style_catalog import STYLE_LABELS, style_model_map

BACKEND_DIR = Path(__file__).resolve().parents[1]

# ONNX assets served by the Next.js app from web/public/models (spec §7.1, §8.1).
ONNX_FILES = {
    "starry-night": "/models/starry-night.onnx",
    "mosaic": "/models/mosaic.onnx",
    "udnie": "/models/udnie.onnx",
    "wave": "/models/wave.onnx",
    "tokyo-ghoul": "/models/tokyo-ghoul.onnx",
    "lazy": "/models/lazy.onnx",
    "bayanihan": "/models/bayanihan.onnx",
    "pointilism": "/models/pointilism-10.onnx",
}

BROWSER_ONLY_LABELS = {"pointilism": "Pointillism"}


@require_GET
def health(request):
    return JsonResponse({"status": "ok", "service": "starrynight-backend", "api": "v2"})


@require_GET
def styles(request):
    """Fixed style catalog with server (.pth) and browser (.onnx) availability."""
    server_models = style_model_map(BACKEND_DIR)
    out = []
    for style_id, label in {**STYLE_LABELS, **BROWSER_ONLY_LABELS}.items():
        model_path = server_models.get(style_id)
        out.append(
            {
                "id": style_id,
                "label": label,
                "serverAvailable": bool(model_path and model_path.is_file() and model_path.stat().st_size > 0),
                "onnx": ONNX_FILES.get(style_id),
            }
        )
    return JsonResponse({"styles": out})

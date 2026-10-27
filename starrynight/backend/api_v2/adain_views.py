"""
Arbitrary style transfer endpoints (AdaIN). Both take a content input *and* a style image.

  POST /api/v2/adain/image/   multipart: content, style, alpha?, max_side?  → stylised JPEG (base64)
  POST /api/v2/adain/video/   multipart: video, style, alpha?               → 202 {job_id}
       progress: GET /style_transfer/video-status/<job_id>/  (shared job store)
"""
import base64
import os
import time
import uuid
from threading import Thread

import cv2
import numpy as np
from django.conf import settings
from django.core.files.storage import default_storage
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from style_transfer.job_state import set_job_state
from style_transfer.tasks import process_adain_video

from .errors import error_response

MAX_IMAGE_BYTES = 15 * 1024 * 1024
MAX_VIDEO_BYTES = 100 * 1024 * 1024
MAX_SIDE_LIMIT = 1280


def _read_image(upload):
    data = np.frombuffer(upload.read(), dtype=np.uint8)
    return cv2.imdecode(data, cv2.IMREAD_COLOR) if data.size else None


def _parse_alpha(raw):
    try:
        alpha = float(raw if raw not in (None, "") else 1.0)
    except (TypeError, ValueError):
        return None
    return alpha if 0.0 <= alpha <= 1.0 else None


def _check_image(upload, field):
    if upload is None:
        return error_response(400, f"missing_{field}", f"Upload a {field} image.")
    if upload.size > MAX_IMAGE_BYTES:
        return error_response(413, "file_too_large", f"The {field} image must be under 15 MB.")
    if not (getattr(upload, "content_type", "") or "").startswith("image/"):
        return error_response(400, f"invalid_{field}", f"The {field} file must be an image.")
    return None


@csrf_exempt
@require_POST
def adain_image(request):
    content_up, style_up = request.FILES.get("content"), request.FILES.get("style")
    for up, field in ((content_up, "content"), (style_up, "style")):
        err = _check_image(up, field)
        if err:
            return err
    alpha = _parse_alpha(request.POST.get("alpha"))
    if alpha is None:
        return error_response(400, "invalid_alpha", "alpha must be a number between 0 and 1.")
    try:
        max_side = max(64, min(MAX_SIDE_LIMIT, int(request.POST.get("max_side", 768))))
    except ValueError:
        return error_response(400, "invalid_max_side", "max_side must be an integer.")

    content, style = _read_image(content_up), _read_image(style_up)
    if content is None or style is None:
        return error_response(400, "unreadable_image", "One of the images could not be decoded.")

    from style_transfer.adain import stylize_image

    try:
        start = time.perf_counter()
        out = stylize_image(content, style, alpha=alpha, max_side=max_side)
        ms = (time.perf_counter() - start) * 1000
    except FileNotFoundError as exc:
        return error_response(503, "model_missing", str(exc))

    ok, jpg = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        return error_response(500, "encode_failed", "Could not encode the result.")
    return JsonResponse(
        {
            "image": "data:image/jpeg;base64," + base64.b64encode(jpg.tobytes()).decode("ascii"),
            "width": int(out.shape[1]),
            "height": int(out.shape[0]),
            "alpha": alpha,
            "ms": round(ms, 1),
            "model": "adain-vgg19-relu4_1",
        }
    )


def _task_mode() -> str:
    mode = getattr(settings, "WEBCAM_VIDEO_TASK_MODE", "thread")
    return mode if mode in ("thread", "celery") else "thread"


@csrf_exempt
@require_POST
def adain_video(request):
    video_up, style_up = request.FILES.get("video"), request.FILES.get("style")
    if video_up is None:
        return error_response(400, "missing_video", "Upload a video.")
    if video_up.size > MAX_VIDEO_BYTES:
        return error_response(413, "file_too_large", "The video must be under 100 MB.")
    if not (getattr(video_up, "content_type", "") or "").startswith("video/"):
        return error_response(400, "invalid_video", "Please upload a video file.")
    err = _check_image(style_up, "style")
    if err:
        return err
    alpha = _parse_alpha(request.POST.get("alpha"))
    if alpha is None:
        return error_response(400, "invalid_alpha", "alpha must be a number between 0 and 1.")

    job_id = str(uuid.uuid4())
    vid_ext = os.path.splitext(video_up.name or "")[1] or ".mp4"
    img_ext = os.path.splitext(style_up.name or "")[1] or ".png"
    video_path = default_storage.save(f"temp/{job_id}{vid_ext}", video_up)
    style_path = default_storage.save(f"temp/{job_id}-style{img_ext}", style_up)
    set_job_state(job_id, {"status": "queued", "progress": 0, "video_url": None, "error": None, "style": "custom"})

    args = (job_id, video_path, style_path)
    kwargs = {"alpha": alpha, "source": request.POST.get("source", "upload")}
    mode = _task_mode()
    if mode == "celery":
        try:
            process_adain_video.delay(*args, **kwargs)
        except Exception:
            mode = "thread"
    if mode == "thread":
        Thread(target=process_adain_video.run, args=args, kwargs=kwargs, daemon=True).start()

    return JsonResponse({"job_id": job_id, "status": "queued", "execution_mode": mode, "style": "custom"}, status=202)

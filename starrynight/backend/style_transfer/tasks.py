import os
from typing import Optional

from celery import shared_task
from django.conf import settings
from django.core.cache import cache
from django.core.files.storage import default_storage

from .reco.style_catalog import resolve_style_model
from .reco.reco_infer import stylize_video

JOB_TTL_SECONDS = 3600


def _job_key(job_id: str) -> str:
    return f"job_{job_id}"


def _update_job(job_id: str, **payload) -> None:
    current = cache.get(_job_key(job_id), {})
    current.update(payload)
    cache.set(_job_key(job_id), current, timeout=JOB_TTL_SECONDS)


def _friendly_error(exc: Exception) -> str:
    message = str(exc).strip()
    lowered = message.lower()
    if "out of memory" in lowered:
        return "Processing failed: GPU out of memory."
    if "unable to open input video" in lowered:
        return "Processing failed: unsupported or corrupted video codec."
    if "unable to open output video writer" in lowered:
        return "Processing failed: could not initialize output video encoder."
    return message or "Processing failed due to an unexpected error."


@shared_task(bind=True, soft_time_limit=60 * 58, time_limit=60 * 60)
def process_webcam_video(self, job_id: str, temp_path: str, style: Optional[str] = None) -> None:
    try:
        model_path, selected_style = resolve_style_model(settings.BASE_DIR, style)
        _update_job(job_id, status="processing", progress=0, error=None, style=selected_style)

        input_abs = default_storage.path(temp_path)
        output_rel = f"output/video-{job_id}.mp4"
        output_abs = default_storage.path(output_rel)
        os.makedirs(os.path.dirname(output_abs), exist_ok=True)

        def on_progress(frames_done: int, total_frames: int) -> None:
            if total_frames > 0:
                progress = min(99, int((frames_done / total_frames) * 100))
            else:
                # Unknown frame count - keep progress indeterminate but moving.
                progress = min(99, frames_done % 100)
            _update_job(job_id, status="processing", progress=progress)

        stylize_video(input_abs, output_abs, model_path, progress_callback=on_progress)
        _update_job(
            job_id,
            status="completed",
            progress=100,
            video_url=f"{settings.MEDIA_URL}{output_rel}",
            error=None,
            style=selected_style,
        )
    except Exception as exc:
        _update_job(job_id, status="failed", progress=0, error=_friendly_error(exc))
    finally:
        # Week-1 cleanup can be basic.
        try:
            default_storage.delete(temp_path)
        except Exception:
            pass

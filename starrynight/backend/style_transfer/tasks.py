import os
from typing import Optional

from celery import shared_task
from django.conf import settings
from django.core.files.storage import default_storage

from .apps import StyleTransferConfig
from .fast_style.api import stlye_transfer
from .job_state import update_job_state
from .reco.style_catalog import resolve_style_model


def _update_job(job_id: str, **payload) -> None:
    update_job_state(job_id, **payload)


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


# Browser-playable first: H.264 (needs an OpenCV build with an H.264 encoder, e.g. macOS),
# then VP8/VP9 WebM (available in the pip Linux wheels), then legacy fallbacks that
# browsers generally can't play.
VIDEO_WRITER_CANDIDATES = (("avc1", ".mp4"), ("VP80", ".webm"), ("VP90", ".webm"), ("mp4v", ".mp4"), ("MJPG", ".avi"))


def open_browser_playable_writer(output_abs: str, fps: float, frame_size):
    """Open the first working cv2.VideoWriter. Returns (writer, actual_output_path)."""
    import cv2

    stem = os.path.splitext(output_abs)[0]
    for fourcc_text, ext in VIDEO_WRITER_CANDIDATES:
        path = stem + ext
        candidate = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*fourcc_text), fps, frame_size)
        if candidate.isOpened():
            return candidate, path
        candidate.release()
        try:
            os.remove(path)
        except OSError:
            pass
    raise ValueError(f"Unable to open output video writer: {output_abs}")


def _process_webcam_video_fast(
    input_abs: str,
    output_abs: str,
    model_path: str,
    progress_callback,
) -> str:
    """Stylize with the fast TransformerNet path. Returns the path actually written."""
    from math import ceil

    import cv2

    capture = cv2.VideoCapture(input_abs)
    if not capture.isOpened():
        capture.release()
        raise ValueError(
            "Unable to open input video. Use a browser-recorded WebM/MP4 file with supported codecs."
        )

    fps = capture.get(cv2.CAP_PROP_FPS)
    if not fps or fps <= 0:
        fps = 24.0
    total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

    target_fps = 8.0
    sample_stride = max(1, int(ceil(float(fps) / target_fps))) if fps > target_fps else 1
    output_fps = max(1.0, float(fps) / sample_stride)
    frame_size = (640, 360)

    try:
        writer, output_abs = open_browser_playable_writer(output_abs, output_fps, frame_size)
    except ValueError:
        capture.release()
        raise

    model = StyleTransferConfig.get_loaded_model(model_path)

    frames_seen = 0
    try:
        while True:
            ok, frame_bgr = capture.read()
            if not ok:
                break
            frames_seen += 1
            if sample_stride > 1 and (frames_seen - 1) % sample_stride != 0:
                progress_callback(frames_seen, total_frames)
                continue

            resized = cv2.resize(frame_bgr, frame_size, interpolation=cv2.INTER_AREA)
            styled = stlye_transfer(model=model, content=resized).clip(0, 255).astype("uint8")
            writer.write(styled)
            progress_callback(frames_seen, total_frames)
    finally:
        capture.release()
        writer.release()
    return output_abs


def _save_processed_video(job_id: str, video_url: str, style: str, user_id: Optional[int], source: str) -> None:
    try:
        from django.contrib.auth.models import User
        from .models import ProcessedVideo
        user = User.objects.get(pk=user_id) if user_id else None
        ProcessedVideo.objects.update_or_create(
            job_id=job_id,
            defaults={"video_url": video_url, "style": style, "user": user, "source": source},
        )
    except Exception:
        pass


@shared_task(bind=True, soft_time_limit=60 * 58, time_limit=60 * 60)
def process_webcam_video(
    self,
    job_id: str,
    temp_path: str,
    style: Optional[str] = None,
    user_id: Optional[int] = None,
    source: str = "webcam",
) -> None:
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
                progress = min(99, frames_done % 100)
            _update_job(job_id, status="processing", progress=progress)

        written_abs = _process_webcam_video_fast(
            input_abs,
            output_abs,
            model_path,
            progress_callback=on_progress,
        )
        output_rel = os.path.join(os.path.dirname(output_rel), os.path.basename(written_abs))
        video_url = f"{settings.MEDIA_URL}{output_rel}"
        _update_job(
            job_id,
            status="completed",
            progress=100,
            video_url=video_url,
            error=None,
            style=selected_style,
        )
        _save_processed_video(job_id, video_url, selected_style, user_id, source)
    except Exception as exc:
        _update_job(job_id, status="failed", progress=0, error=_friendly_error(exc))
    finally:
        try:
            default_storage.delete(temp_path)
        except Exception:
            pass


def _process_adain_video(
    input_abs: str,
    output_abs: str,
    style_bgr,
    alpha: float,
    progress_callback,
    max_side: int = 512,
    target_fps: float = 8.0,
) -> str:
    """Arbitrary-style video: AdaIN per frame with the style features encoded once. Returns the path written."""
    from math import ceil

    import cv2

    from .adain import get_model

    capture = cv2.VideoCapture(input_abs)
    if not capture.isOpened():
        capture.release()
        raise ValueError("Unable to open input video. Use a browser-recorded WebM/MP4 file with supported codecs.")

    fps = capture.get(cv2.CAP_PROP_FPS) or 24.0
    total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    sample_stride = max(1, int(ceil(float(fps) / target_fps))) if fps > target_fps else 1
    output_fps = max(1.0, float(fps) / sample_stride)
    frame_size = (640, 360)

    try:
        writer, output_abs = open_browser_playable_writer(output_abs, output_fps, frame_size)
    except ValueError:
        capture.release()
        raise

    model = get_model()
    style_feat = model.encode_style(style_bgr)
    frames_seen = 0
    try:
        while True:
            ok, frame_bgr = capture.read()
            if not ok:
                break
            frames_seen += 1
            if sample_stride > 1 and (frames_seen - 1) % sample_stride != 0:
                progress_callback(frames_seen, total_frames)
                continue
            resized = cv2.resize(frame_bgr, frame_size, interpolation=cv2.INTER_AREA)
            writer.write(model.stylize(resized, style_feat, alpha=alpha, max_side=max_side))
            progress_callback(frames_seen, total_frames)
    finally:
        capture.release()
        writer.release()
    return output_abs


@shared_task(bind=True, soft_time_limit=60 * 58, time_limit=60 * 60)
def process_adain_video(
    self,
    job_id: str,
    temp_video_path: str,
    temp_style_path: str,
    alpha: float = 1.0,
    user_id: Optional[int] = None,
    source: str = "upload",
) -> None:
    import cv2

    try:
        _update_job(job_id, status="processing", progress=0, error=None, style="custom")
        style_bgr = cv2.imread(default_storage.path(temp_style_path), cv2.IMREAD_COLOR)
        if style_bgr is None:
            raise ValueError("Could not read the style image.")

        output_rel = f"output/video-{job_id}.mp4"
        output_abs = default_storage.path(output_rel)
        os.makedirs(os.path.dirname(output_abs), exist_ok=True)

        def on_progress(frames_done: int, total_frames: int) -> None:
            progress = min(99, int(frames_done / total_frames * 100)) if total_frames > 0 else min(99, frames_done % 100)
            _update_job(job_id, status="processing", progress=progress)

        written_abs = _process_adain_video(
            default_storage.path(temp_video_path), output_abs, style_bgr, alpha, progress_callback=on_progress
        )
        output_rel = os.path.join(os.path.dirname(output_rel), os.path.basename(written_abs))
        video_url = f"{settings.MEDIA_URL}{output_rel}"
        _update_job(job_id, status="completed", progress=100, video_url=video_url, error=None, style="custom")
        _save_processed_video(job_id, video_url, "custom", user_id, source)
    except Exception as exc:
        _update_job(job_id, status="failed", progress=0, error=_friendly_error(exc))
    finally:
        for path in (temp_video_path, temp_style_path):
            try:
                default_storage.delete(path)
            except Exception:
                pass

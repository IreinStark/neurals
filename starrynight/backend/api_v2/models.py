"""User gallery (GP2 feature 3): saved works, likes, view counts and public share links."""
import secrets
import uuid
from pathlib import PurePosixPath

from django.conf import settings
from django.db import models


def _media_path(instance, filename):
    ext = PurePosixPath(filename).suffix.lower()[:6] or ".bin"
    return f"gallery/{instance.owner_id}/{uuid.uuid4().hex}{ext}"


def _poster_path(instance, filename):
    return f"gallery/{instance.owner_id}/{uuid.uuid4().hex}_poster.jpg"


class Artwork(models.Model):
    KIND_IMAGE, KIND_VIDEO, KIND_WEBCAM = "image", "video", "webcam"
    KIND_CHOICES = [(KIND_IMAGE, "Image"), (KIND_VIDEO, "Video"), (KIND_WEBCAM, "Webcam")]

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="artworks")
    kind = models.CharField(max_length=8, choices=KIND_CHOICES, default=KIND_IMAGE)
    title = models.CharField(max_length=120)
    style = models.CharField(max_length=64, blank=True)
    media = models.FileField(upload_to=_media_path)
    poster = models.FileField(upload_to=_poster_path, blank=True)
    duration = models.CharField(max_length=8, blank=True)
    size_bytes = models.BigIntegerField(default=0)
    views = models.PositiveIntegerField(default=0)
    like_count = models.PositiveIntegerField(default=0)
    share_token = models.CharField(max_length=24, unique=True, null=True, blank=True)
    client_id = models.CharField(max_length=32, blank=True, help_text="id the studio assigned before upload")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["owner", "-created_at"])]

    def ensure_share_token(self) -> str:
        if not self.share_token:
            self.share_token = secrets.token_urlsafe(9)
            self.save(update_fields=["share_token"])
        return self.share_token

    def delete(self, *args, **kwargs):
        files = [f for f in (self.media, self.poster) if f]
        result = super().delete(*args, **kwargs)
        for f in files:
            f.storage.delete(f.name)
        return result


class ArtworkLike(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    artwork = models.ForeignKey(Artwork, on_delete=models.CASCADE, related_name="likes")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["user", "artwork"], name="one_like_per_user")]

from django.db import models
from django.contrib.auth.models import User


def nameFile(instance, filename):
    return '/'.join(['images', str(instance.name), filename])


class imageupload(models.Model):
    user = models.ForeignKey(User, on_delete=models.SET_NULL, null=True)
    title = models.CharField(max_length=50)
    images = models.ImageField('images', upload_to=nameFile)


class ProcessedVideo(models.Model):
    SOURCE_WEBCAM = "webcam"
    SOURCE_UPLOAD = "upload"
    SOURCE_CHOICES = [(SOURCE_WEBCAM, "Webcam"), (SOURCE_UPLOAD, "Upload")]

    user = models.ForeignKey(User, on_delete=models.CASCADE, null=True, blank=True)
    job_id = models.CharField(max_length=64, unique=True, db_index=True)
    style = models.CharField(max_length=128, blank=True)
    video_url = models.CharField(max_length=512)
    source = models.CharField(max_length=16, choices=SOURCE_CHOICES, default=SOURCE_WEBCAM)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.source}/{self.style} – job {self.job_id[:8]}"

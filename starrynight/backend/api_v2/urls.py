from django.urls import path

from . import adain_views, views

app_name = "api_v2"

urlpatterns = [
    path("health/", views.health, name="health"),
    path("styles/", views.styles, name="styles"),
    path("adain/image/", adain_views.adain_image, name="adain-image"),
    path("adain/video/", adain_views.adain_video, name="adain-video"),
]

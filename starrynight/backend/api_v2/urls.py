from django.urls import path

from . import adain_views, gallery_views, views

app_name = "api_v2"

urlpatterns = [
    path("health/", views.health, name="health"),
    path("styles/", views.styles, name="styles"),
    path("adain/image/", adain_views.adain_image, name="adain-image"),
    path("adain/video/", adain_views.adain_video, name="adain-video"),
    path("gallery/", gallery_views.gallery, name="gallery"),
    path("gallery/<int:pk>/", gallery_views.artwork_detail, name="artwork"),
    path("gallery/<int:pk>/like/", gallery_views.artwork_like, name="artwork-like"),
    path("gallery/<int:pk>/share/", gallery_views.artwork_share, name="artwork-share"),
    path("share/<str:token>/", gallery_views.shared, name="shared"),
]

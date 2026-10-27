from django.conf import settings
from django.conf.urls.static import static
from django.conf.urls import include
from django.contrib import admin
from django.urls import path

from api_v2.gallery_views import share_page

urlpatterns = [
    # path("", admin.site.urls),
    path("admin/", admin.site.urls),
    path("accounts/", include("accounts.urls")),
    path("style_transfer/", include("style_transfer.urls")),
    path("api/v2/", include("api_v2.urls")),
    path("s/<str:token>/", share_page, name="share-page"),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
